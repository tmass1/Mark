//! Mark as an MCP server: how Claude Code, Claude Desktop and other AI tools
//! ask the user for a screenshot.
//!
//! Two processes, one binary. A tool starts `mark --mcp` -- the bridge -- and
//! speaks MCP to it over stdin and stdout. The bridge takes nothing itself: it
//! relays the ask over a Unix socket to the Mark that is running, which has the
//! screen access and the editor, and waits there for the user to send a
//! screenshot or decline. Nothing reaches the tool without that Send.
//!
//! The bridge uses no AppKit, so it never registers as a running Mark, and
//! nothing but MCP ever goes to its stdout: a stray line there would be a
//! protocol error in the tool.

use crate::session::Reply;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::{ffi::OsStrExt, fs::{OpenOptionsExt, PermissionsExt}, io::AsRawFd, net::{UnixListener, UnixStream}};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// The MCP revision the bridge speaks, and the older ones it answers in when a
/// tool asks for one of them.
pub const PROTOCOL: &str = "2025-11-25";
const PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// The line protocol between bridge and app. A bridge started before Mark
/// updated itself keeps running the old code, so each side checks the other's.
const WIRE: u64 = 1;
const TOOL: &str = "capture_screen";
/// The ask is a few lines of text; this is far more than one needs.
const ASK_LIMIT: u64 = 64 * 1024;
/// The answer can carry a whole screenshot.
const ANSWER_LIMIT: u64 = 96 * 1024 * 1024;
/// How often a waiting call tells the tool it is still waiting -- once at once,
/// then on this beat. Claude Code gives a stdio server thirty quiet minutes and
/// OpenCode a minute, and each of these starts them again; a tool set to give
/// up sooner still hears before it would.
const PROGRESS_EVERY: Duration = Duration::from_secs(5);
/// How long the bridge waits for a Mark it had to open.
const LAUNCH_WAIT: Duration = Duration::from_secs(15);
/// How long a tool built on the MCP SDK waits for a call, unless it asks for
/// longer: a minute, which progress does not extend. Claude Desktop is one.
const SDK_PATIENCE: f64 = 60.0;

/// How long a tool waits for a call, by the name it gives itself, where its
/// default is known; None for one that waits as long as it takes. A tool not
/// known here is taken at the MCP SDK's word. Each is the tool's default, which
/// its user may change: a count that runs out while the tool still waits just
/// goes, and a tool that gives up sooner takes the ask with it.
fn patience(name: Option<&str>) -> Option<f64> {
    match name.unwrap_or_default() {
        // A day; OpenCode's and Cursor's never run out while progress comes;
        // Crush and VS Code don't give up at all.
        "claude-code" | "opencode" | "cursor-vscode" | "crush" | "Visual Studio Code" | "Visual Studio Code - Insiders" => None,
        // Grok Build: a hundred minutes.
        name if name.starts_with("grok-shell-") => None,
        // As long as the line Mark gives each to add it asks for.
        "copilot-cli" | "github-copilot-developer" => Some(3600.0),
        "Zed" => Some(600.0),
        "codex-mcp-client" | "goose-cli" | "goose-desktop" => Some(300.0),
        "gemini-cli-mcp-client" | "qwen-code-mcp-client" => Some(600.0),
        "antigravity-client" => Some(180.0),
        // Warp: half an hour, fixed.
        "dev.warp.Warp-Stable" | "dev.warp.Warp-Preview" => Some(1800.0),
        _ => Some(SDK_PATIENCE),
    }
}

pub const DECLINED: &str = "The user chose not to send a screenshot. Don't ask again unless they say so.";
pub const QUIT: &str = "Mark quit before a screenshot was sent.";

const INSTRUCTIONS: &str = "Mark is the user's screenshot tool. When seeing their screen would help -- an error \
message, a layout, what an app is showing -- call capture_screen with a prompt saying what you want to see. Mark \
shows them the prompt; they capture it, may mark it up with arrows, boxes and numbered steps, and send it, or \
decline. If they decline, don't ask again unless they say so.";

// ---- where the socket is ---------------------------------------------------

/// Mark's own folder under Application Support, where settings.json also
/// lives, named by the identifier of the app this binary belongs to: a test
/// copy, with an identifier of its own, never answers for the installed Mark,
/// and a development build takes a name apart from both.
pub fn folder() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/Application Support").join(identifier()))
}

fn identifier() -> String {
    let bundled = objc2_foundation::NSBundle::mainBundle().bundleIdentifier().map(|id| id.to_string());
    let id = bundled.filter(|id| !id.is_empty()).unwrap_or_else(|| "com.markapp.Mark".into());
    if cfg!(debug_assertions) { format!("{id}.dev") } else { id }
}

/// The home folder from the user database, not $HOME: a tool may start the
/// bridge with an environment of its own making.
fn home() -> Result<PathBuf, String> {
    // SAFETY: getpwuid returns a pointer into static storage, or null; it is
    // read at once and copied out.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_dir.is_null() { return Err("Your home folder couldn't be found.".into()); }
        let dir = std::ffi::CStr::from_ptr((*entry).pw_dir);
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
    }
}

pub fn socket_in(folder: &Path) -> Result<PathBuf, String> {
    let path = folder.join("mcp.sock");
    // A socket's path has 104 bytes on macOS, the zero that ends it among them.
    if path.as_os_str().len() >= 104 {
        return Err(format!("The path to Mark's socket is too long for macOS: {}", path.display()));
    }
    Ok(path)
}

/// The .app a binary is inside, if it is inside one: Mark.app/Contents/MacOS/mark.
fn app_of(binary: &Path) -> Option<PathBuf> {
    let app = binary.parent()?.parent()?.parent()?;
    (app.extension()? == "app").then(|| app.to_path_buf())
}

// ---- the app's side ----------------------------------------------------------

/// What a tool asked for, as the bridge relays it. Cleaned by the app, which
/// trusts nothing that arrives on the socket. `wait` is how many seconds the
/// tool will still wait, for a tool known to give up.
#[derive(Clone, Debug, PartialEq)]
pub struct Ask { pub client: String, pub prompt: String, pub mode: String, pub wait: Option<f64> }

/// What the app does with an ask. A trait, so the socket can be tested
/// without an app behind it.
pub trait Host: Send + Sync + 'static {
    /// Take the ask, or say why not. The receiver gets the one answer; it
    /// closes without one if the ask is withdrawn.
    fn ask(&self, ask: Ask) -> Result<(u64, mpsc::Receiver<Reply>), String>;
    /// The tool stopped waiting for this one.
    fn withdraw(&self, id: u64);
}

/// The socket, bound, and the lock that makes it this Mark's. Only the lock's
/// holder may clear away an old socket and bind a new one, so two Marks never
/// take the socket from each other; the lock goes with the process.
pub struct Bound { listener: UnixListener, path: PathBuf, _lock: std::fs::File }

impl Bound {
    pub fn path(&self) -> &Path { &self.path }
}

pub fn bind(folder: &Path) -> Result<Bound, String> {
    let path = socket_in(folder)?;
    std::fs::create_dir_all(folder).map_err(|e| format!("Mark's folder couldn't be made ({e})."))?;
    // Only this user may look in: the socket is here, and the settings.
    std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).mode(0o600)
        .open(folder.join("mcp.lock")).map_err(|e| format!("Mark couldn't take its lock ({e})."))?;
    // SAFETY: a plain flock on a descriptor this function owns.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another Mark is already answering AI tools.".into());
    }
    // With the lock held, a socket still here is one a Mark left behind.
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("An old socket couldn't be cleared away ({error}).")),
    }
    let listener = UnixListener::bind(&path).map_err(|e| format!("Mark couldn't listen for AI tools ({e})."))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    Ok(Bound { listener, path, _lock: lock })
}

/// Answer connections for as long as the app runs, each on a thread of its own.
pub fn serve(bound: Bound, host: Arc<dyn Host>) {
    std::thread::spawn(move || {
        for stream in bound.listener.incoming() {
            // A failed accept -- out of descriptors, say -- is waited out
            // rather than retried in a tight loop.
            let Ok(stream) = stream else { std::thread::sleep(Duration::from_millis(200)); continue };
            // The folder and the socket are this user's alone already; this is
            // the check that does not depend on either.
            if !same_user(&stream) { continue; }
            let host = host.clone();
            std::thread::spawn(move || connection(stream, host));
        }
        drop(bound);
    });
}

fn same_user(stream: &UnixStream) -> bool {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: getpeereid fills two integers for a connected socket's descriptor.
    unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::getuid() }
}

/// One ask: read it, hand it to the app, and write back the one answer -- or
/// nothing, if the bridge stops waiting first.
fn connection(stream: UnixStream, host: Arc<dyn Host>) {
    let Ok(writer) = stream.try_clone() else { return };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream);
    let answer = match read_line(&mut reader, ASK_LIMIT).and_then(|line| parse_ask(&line)) {
        Err(message) => Some(Reply::Failed(message)),
        Ok(ask) => match host.ask(ask) {
            Err(message) => Some(Reply::Failed(message)),
            Ok((id, answer)) => {
                // From here the only thing to read is the bridge giving up: a
                // cancel line, or the connection closing.
                let _ = reader.get_ref().set_read_timeout(None);
                let watcher = host.clone();
                std::thread::spawn(move || { let _ = read_line(&mut reader, ASK_LIMIT); watcher.withdraw(id); });
                answer.recv().ok()
            }
        },
    };
    if let Some(answer) = answer { let _ = write_line(&writer, &wire_answer(&answer)); }
    let _ = writer.shutdown(std::net::Shutdown::Both);
}

fn parse_ask(line: &str) -> Result<Ask, String> {
    let message: Value = serde_json::from_str(line).map_err(|_| "Mark couldn't read the request.".to_string())?;
    if message["v"].as_u64() != Some(WIRE) {
        return Err("Mark has been updated since this AI tool started it. Restart the tool, then ask again.".into());
    }
    if message["type"] != "ask" { return Err("Mark couldn't read the request.".into()); }
    let text = |key: &str| message[key].as_str().unwrap_or_default().to_string();
    let wait = message["wait"].as_f64().filter(|seconds| seconds.is_finite() && *seconds >= 0.0);
    Ok(Ask { client: text("client"), prompt: text("prompt"), mode: text("mode"), wait })
}

fn wire_answer(answer: &Reply) -> Value {
    match answer {
        Reply::Sent { png, text } => json!({ "v": WIRE, "type": "sent", "png": png, "text": text }),
        Reply::Declined => json!({ "v": WIRE, "type": "declined" }),
        Reply::Failed(message) => json!({ "v": WIRE, "type": "failed", "message": message }),
    }
}

fn read_answer(line: &str) -> Result<Reply, String> {
    let message: Value = serde_json::from_str(line).map_err(|_| "Mark's answer couldn't be read.".to_string())?;
    if message["v"].as_u64() != Some(WIRE) {
        return Err("Mark has been updated since this AI tool started it. Restart the tool, then ask again.".into());
    }
    let text = |key: &str| message[key].as_str().map(str::to_string);
    match message["type"].as_str() {
        Some("sent") => match (text("png"), text("text")) {
            (Some(png), Some(text)) => Ok(Reply::Sent { png, text }),
            _ => Err("Mark's answer couldn't be read.".into()),
        },
        Some("declined") => Ok(Reply::Declined),
        Some("failed") => Ok(Reply::Failed(text("message").unwrap_or_else(|| "Mark couldn't take the screenshot.".into()))),
        _ => Err("Mark's answer couldn't be read.".into()),
    }
}

/// One line, at most `limit` bytes of it, without its newline. The end of the
/// stream before any of it is an error: there was nothing to read.
fn read_line(reader: &mut impl BufRead, limit: u64) -> Result<String, String> {
    let mut line = String::new();
    let read = reader.take(limit).read_line(&mut line).map_err(|e| e.to_string())?;
    if read == 0 { return Err("closed".into()); }
    if !line.ends_with('\n') && read as u64 >= limit { return Err("That line is too long.".into()); }
    Ok(line.trim_end_matches(['\n', '\r']).to_string())
}

fn write_line(mut stream: &UnixStream, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes())
}

/// Text from a tool, made fit to show: no control or format characters --
/// which can reorder what is drawn around them, or hide text altogether --
/// runs of whitespace made one space, and at most `limit` characters.
pub fn clean(text: &str, limit: usize) -> String {
    let kept: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).filter(|c| !invisible(*c)).collect();
    let joined = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= limit { return joined; }
    let cut: String = joined.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// Characters that draw nothing themselves: the bidirectional marks,
/// overrides and isolates, the zero-width spaces and joiners, invisible
/// fillers, and the tag characters text can be hidden in.
fn invisible(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F
        | 0x202A..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0x1D173..=0x1D17A
        | 0xE0000..=0xE0FFF)
}

/// One AI tool Mark can be added to, and how: what the user does, in the
/// tool's own way.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// The tool, as a person names it.
    pub name: &'static str,
    /// Where it is listed: a command line, an app, or an editor.
    pub group: &'static str,
    #[serde(flatten)]
    pub how: How,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum How {
    /// A command to paste into Terminal.
    Command { text: String },
    /// A link that opens the tool, which then asks whether to add Mark.
    Link { url: String },
    /// Text for the tool's settings, where it goes -- a file, or a place in
    /// the tool -- and whether the tool must be opened again to read it.
    Config { place: String, text: String, restart: bool },
}

/// The schemes Mark opens a link in. Only links Mark made itself are ever
/// opened, and only in these.
const LINK_SCHEMES: [&str; 2] = ["cursor", "vscode"];

/// Every tool Mark can be added to, for the Mark at this path -- the running
/// one, so what is copied starts this very copy. Each the way its own makers
/// document: a link where it takes one, a command where it has one, and
/// otherwise the lines for its settings. A tool that runs in the cloud, as
/// Grok Bot does, can't start a program on this Mac, so it isn't here.
pub fn agents(binary: &Path) -> Result<Vec<Agent>, String> {
    let path = binary.to_str().ok_or("Mark's location can't be written down as text.")?;
    if path.contains("/AppTranslocation/") {
        return Err("Move Mark to your Applications folder first: macOS is running it from a temporary copy.".into());
    }
    if app_of(binary).is_none() { return Err("This Mark isn't running from its app, so there's nothing for an AI tool to start.".into()); }
    let shell = shell_quoted(path);
    // A JSON string is a TOML basic string and a YAML double-quoted one too.
    let quoted = Value::from(path).to_string();
    let server = json!({ "command": path, "args": ["--mcp"] });
    let pretty = |value: Value| serde_json::to_string_pretty(&value).unwrap_or_default();
    let servers = || pretty(json!({ "mcpServers": { "mark": server } }));
    let typed = |key: &str| pretty(json!({ key: { "mark": { "type": "stdio", "command": path, "args": ["--mcp"] } } }));
    let command = |name, line: String| Agent { name, group: "Command line", how: How::Command { text: line } };
    let config = |name, group, place: &str, text: String, restart| Agent { name, group, how: How::Config { place: place.into(), text, restart } };
    let link = |name, url: String| Agent { name, group: "Editors", how: How::Link { url } };
    // VS Code reads its link's text twice over, so a % in the path would be
    // read as the start of another; such a Mark gives the command instead.
    let vs_code = json!({ "name": "mark", "type": "stdio", "command": path, "args": ["--mcp"] }).to_string();
    let vs_code = if path.contains('%') {
        Agent { name: "VS Code", group: "Editors", how: How::Command { text: format!("code --add-mcp {}", shell_quoted(&vs_code)) } }
    } else { link("VS Code", format!("vscode:mcp/install?{}", link_part(&vs_code))) };
    Ok(vec![
        command("Claude Code", format!("claude mcp add --scope user mark -- {shell} --mcp")),
        command("Codex", format!("codex mcp add mark -- {shell} --mcp")),
        command("Grok Build", format!("grok mcp add mark -- {shell} --mcp")),
        // Copilot's own limit is a matter of seconds; an hour is time to show it.
        command("GitHub Copilot CLI", format!("copilot mcp add --timeout 3600000 mark -- {shell} --mcp")),
        command("Gemini CLI", format!("gemini mcp add --scope user mark {shell} -- --mcp")),
        command("OpenCode", format!("opencode mcp add mark -- {shell} --mcp")),
        command("Amp", format!("amp mcp add mark -- {shell} --mcp")),
        // Droid takes its command as one string it splits itself, so its file is surer.
        config("Factory Droid", "Command line", "~/.factory/mcp.json", typed("mcpServers"), false),
        command("Qwen Code", format!("qwen mcp add mark {shell} -- --mcp")),
        config("Crush", "Command line", "~/.config/crush/crush.json", typed("mcp"), true),
        config("Claude Desktop", "Apps", "~/Library/Application Support/Claude/claude_desktop_config.json", servers(), true),
        // The Codex app is the ChatGPT app's now: its Codex chats use local tools, from Codex's own settings.
        config("ChatGPT (Codex)", "Apps", "~/.codex/config.toml", format!("[mcp_servers.mark]\ncommand = {quoted}\nargs = [\"--mcp\"]"), true),
        config("Goose", "Apps", "the extensions in ~/.config/goose/config.yaml",
               format!("  mark:\n    enabled: true\n    type: stdio\n    name: mark\n    cmd: {quoted}\n    args: [\"--mcp\"]\n    timeout: 300"), true),
        config("Warp", "Apps", "~/.warp/.mcp.json", servers(), false),
        link("Cursor", format!("cursor://anysphere.cursor-deeplink/mcp/install?name=mark&config={}",
                               link_part(&STANDARD.encode(server.to_string())))),
        vs_code,
        config("JetBrains AI", "Editors", "Settings › Tools › AI Assistant › Model Context Protocol (MCP)", servers(), false),
        config("Devin (Windsurf)", "Editors", "~/.config/devin/mcp_config.json", servers(), true),
        // Zed waits a minute unless told otherwise, and ten at most.
        config("Zed", "Editors", "~/.config/zed/settings.json, inside its outer braces",
               within(&json!({ "context_servers": { "mark": { "command": path, "args": ["--mcp"], "env": {}, "timeout": 600 } } })), false),
        config("Antigravity", "Editors", "~/.gemini/config/mcp_config.json", servers(), true),
    ])
}

/// Single quotes keep any character in a path as itself, but a single quote.
fn shell_quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Text as part of a link: every byte but the few a link leaves as they are,
/// written %XX -- what a web page's encodeURIComponent makes, which is what
/// these tools read.
fn link_part(text: &str) -> String {
    text.bytes().map(|byte| match byte {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => char::from(byte).to_string(),
        _ => format!("%{byte:02X}"),
    }).collect()
}

/// An object's members, without its braces, to go inside a settings file that
/// has other things in it already.
fn within(value: &Value) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[1..lines.len().saturating_sub(1)].iter().map(|line| line.strip_prefix("  ").unwrap_or(line)).collect::<Vec<_>>().join("\n")
}

/// The link for the tool with this name, if Mark has one, in a scheme Mark opens.
pub fn link_for(binary: &Path, name: &str) -> Result<String, String> {
    let agents = agents(binary)?;
    let agent = agents.iter().find(|agent| agent.name == name).ok_or_else(|| format!("Mark doesn't know {name}."))?;
    match &agent.how {
        How::Link { url } if LINK_SCHEMES.iter().any(|scheme| url.starts_with(&format!("{scheme}:"))) => Ok(url.clone()),
        _ => Err(format!("{name} is added another way.")),
    }
}

// ---- the bridge ------------------------------------------------------------

/// What the bridge knows of the conversation: who it is talking to, as a
/// person would name it and as it names itself.
#[derive(Default)]
pub struct Bridge { client: Option<String>, id: Option<String> }

/// What a message from the tool calls for.
#[derive(Debug, PartialEq)]
pub enum Action {
    /// Write this back.
    Reply(Value),
    /// Ask Mark, and answer the call with this id when it does.
    Call { id: Value, ask: Ask, progress: Option<Value> },
    /// The tool stopped waiting for the call with this id.
    Cancel(Value),
    Nothing,
}

/// One line from the tool, and what to do about it. Pure, so the protocol is
/// tested without processes or sockets; `calling` is the id of the call
/// waiting on Mark, if one is.
pub fn respond(line: &str, bridge: &mut Bridge, calling: Option<&Value>) -> Action {
    let Ok(message) = serde_json::from_str::<Value>(line) else { return Action::Reply(error(Value::Null, -32700, "Parse error")) };
    let Some(object) = message.as_object() else { return Action::Reply(error(Value::Null, -32600, "Invalid request")) };
    let id = object.get("id").cloned();
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // An answer to a request of the bridge's -- it makes none -- is no business of its.
        let answer = object.contains_key("result") || object.contains_key("error");
        return match id { Some(id) if !answer => Action::Reply(error(id, -32600, "Invalid request")), _ => Action::Nothing };
    };
    let params = object.get("params").cloned().unwrap_or(Value::Null);
    // A notification gets no answer of any kind, whatever it is.
    let Some(id) = id else { return notification(method, &params, calling) };
    if !(id.is_string() || id.is_i64() || id.is_u64()) { return Action::Reply(error(Value::Null, -32600, "Invalid request")); }
    match method {
        "initialize" => {
            bridge.client = client_name(&params);
            bridge.id = params["clientInfo"]["name"].as_str().map(str::to_string);
            Action::Reply(result(id, initialized(&params)))
        }
        "ping" => Action::Reply(result(id, json!({}))),
        "tools/list" => Action::Reply(result(id, json!({ "tools": [tool()] }))),
        "tools/call" => call(id, &params, bridge, calling),
        // server/discover among them: the newer revision's opening, which a
        // tool falls back from at once, given an answer at once.
        _ => Action::Reply(error(id, -32601, "Method not found")),
    }
}

fn notification(method: &str, params: &Value, calling: Option<&Value>) -> Action {
    match (method, params.get("requestId"), calling) {
        ("notifications/cancelled", Some(target), Some(calling)) if target == calling => Action::Cancel(calling.clone()),
        _ => Action::Nothing,
    }
}

fn call(id: Value, params: &Value, bridge: &Bridge, calling: Option<&Value>) -> Action {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    if name != TOOL { return Action::Reply(error(id, -32602, &format!("Unknown tool: {name}"))); }
    if calling.is_some() {
        return Action::Reply(result(id, failure("Mark is already waiting on a screenshot for this conversation.")));
    }
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
    let prompt = arguments.get("prompt").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if prompt.is_empty() {
        return Action::Reply(result(id, failure("capture_screen needs a prompt: say what you want to see, so the user knows what to capture.")));
    }
    let mode = match arguments.get("mode").and_then(Value::as_str).unwrap_or("region") {
        "region" => "region",
        "window" => "window",
        "screen" | "display" => "display",
        other => return Action::Reply(result(id, failure(&format!("mode is region, window or screen, not {other}.")))),
    };
    let progress = params.get("_meta").and_then(|meta| meta.get("progressToken"))
        .filter(|token| token.is_string() || token.is_i64() || token.is_u64()).cloned();
    let client = bridge.client.clone().unwrap_or_else(|| "An AI tool".into());
    let wait = patience(bridge.id.as_deref());
    Action::Call { id, ask: Ask { client, prompt: prompt.into(), mode: mode.into(), wait }, progress }
}

/// The tool's own name for itself, as a person would say it.
fn client_name(params: &Value) -> Option<String> {
    let info = params.get("clientInfo")?;
    let text = |key: &str| info.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    if let Some(title) = text("title") { return Some(title.into()); }
    let name = text("name")?;
    // Grok Build names itself for the server it talks to: grok-shell-mark.
    if name.starts_with("grok-shell-") { return Some("Grok Build".into()); }
    if name.starts_with("grok-cli") { return Some("Grok CLI".into()); }
    Some(match name {
        "claude-code" => "Claude Code",
        "claude-ai" | "claude-desktop" | "claude-desktop-3p" => "Claude",
        "codex-mcp-client" => "Codex",
        "cursor-vscode" => "Cursor",
        "Visual Studio Code" | "Visual Studio Code - Insiders" | "Visual-Studio-Code" => "VS Code",
        "Windsurf" | "windsurf-client" => "Windsurf",
        "@cline/core" => "Cline",
        "lmstudio-mcp-server-session" => "LM Studio",
        "kimi-code" => "Kimi Code",
        "gemini-cli-mcp-client" => "Gemini CLI",
        "antigravity-client" => "Antigravity",
        "qwen-code-mcp-client" => "Qwen Code",
        "goose-cli" | "goose-desktop" => "Goose",
        "opencode" => "OpenCode",
        "crush" => "Crush",
        "copilot-cli" | "github-copilot-developer" => "GitHub Copilot",
        "dev.warp.Warp-Stable" | "dev.warp.Warp-Preview" => "Warp",
        "amp-mcp-client" => "Amp",
        "factory-cli" => "Factory Droid",
        "com.raycast.macos" => "Raycast",
        other => other,
    }.into())
}

fn initialized(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    // A revision this bridge doesn't know gets its newest, never an error: the
    // tool decides whether it can work with that.
    let version = asked.filter(|version| PROTOCOLS.contains(version)).unwrap_or(PROTOCOL);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "mark", "title": "Mark", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

fn tool() -> Value {
    json!({
        "name": TOOL,
        "title": "Ask for a screenshot",
        "description": "Ask the user to capture part of their Mac's screen with Mark and send it to you. Mark shows them \
            your prompt; they choose what to capture, can draw arrows, boxes and numbered steps on it, and send it -- or \
            decline. Waits until they do, which can take a minute or more. The result is the image, and a note of its \
            size and of any numbered steps.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "What you want to see, in a few words, shown to the user. For example: the error dialog in Xcode." },
                "mode": { "type": "string", "enum": ["region", "window", "screen"], "default": "region",
                          "description": "How it is most likely captured: part of the screen, one window, or the whole screen. The user can choose otherwise." },
            },
            "required": ["prompt"],
        },
        "annotations": { "title": "Ask for a screenshot", "readOnlyHint": true, "openWorldHint": false },
    })
}

fn result(id: Value, result: Value) -> Value { json!({ "jsonrpc": "2.0", "id": id, "result": result }) }
fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}
/// A call that did not get a screenshot: an answer, not a protocol error, so
/// the model reads why.
fn failure(text: &str) -> Value { json!({ "content": [{ "type": "text", "text": text }], "isError": true }) }

/// A call's result, from Mark's answer.
pub fn answered(answer: Reply) -> Value {
    match answer {
        Reply::Sent { png, text } => json!({ "content": [
            { "type": "image", "data": png, "mimeType": "image/png" },
            { "type": "text", "text": text },
        ] }),
        Reply::Declined => failure(DECLINED),
        Reply::Failed(message) => failure(&message),
    }
}

/// Whatever a waiting call can hear: Mark's answer, or the tool giving up.
enum Event { Answer(Result<Reply, String>), Cancel }

type Pending = Arc<Mutex<Option<(Value, mpsc::Sender<Event>)>>>;

/// Every message to the tool, one line each. A line is written whole while
/// stdout is held, so a call's progress can't land in the middle of another.
fn send(message: &Value) {
    let mut line = message.to_string();
    line.push('\n');
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}

/// The bridge: MCP on stdin and stdout until the tool closes stdin. Nothing
/// happens until a call -- no socket, no opening Mark -- since a tool may
/// start the bridge only to see what it offers.
pub fn serve_stdio() -> i32 {
    let pending: Pending = Arc::default();
    let mut bridge = Bridge::default();
    let mut calls = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let calling = pending.lock().map(|slot| slot.as_ref().map(|(id, _)| id.clone())).unwrap_or_default();
        match respond(&line, &mut bridge, calling.as_ref()) {
            Action::Reply(message) => send(&message),
            Action::Call { id, ask, progress } => {
                let asked = std::time::Instant::now();
                let (events, heard) = mpsc::channel();
                if let Ok(mut slot) = pending.lock() { *slot = Some((id.clone(), events.clone())); }
                let pending = pending.clone();
                calls.push(std::thread::spawn(move || run_call(id, ask, asked, progress, events, heard, pending)));
            }
            Action::Cancel(id) => {
                let waiting = pending.lock().ok().and_then(|mut slot| slot.take_if(|(calling, _)| *calling == id));
                if let Some((_, events)) = waiting { let _ = events.send(Event::Cancel); }
            }
            Action::Nothing => {}
        }
    }
    // The tool has gone. A call still waiting is withdrawn, so Mark stops
    // showing the ask; give it a moment to say so, then go.
    if let Some((_, events)) = pending.lock().ok().and_then(|mut slot| slot.take()) { let _ = events.send(Event::Cancel); }
    for _ in 0..20 {
        if calls.iter().all(|call| call.is_finished()) { break; }
        std::thread::sleep(Duration::from_millis(100));
    }
    0
}

fn run_call(id: Value, ask: Ask, asked: std::time::Instant, progress: Option<Value>, events: mpsc::Sender<Event>,
            heard: mpsc::Receiver<Event>, pending: Pending) {
    let answer = wait_for_mark(&ask, asked, progress, events, &heard);
    // Free the slot first, so a call the tool makes the moment it has this
    // answer isn't refused as a second one.
    if let Ok(mut slot) = pending.lock() { let _ = slot.take_if(|(calling, _)| *calling == id); }
    // Given up on, a call gets no answer at all.
    if let Some(answer) = answer { send(&result(id, answered(answer))); }
}

enum Unreachable { GaveUp, Because(String) }

/// Ask Mark, then wait: for its answer, or for the tool to give up, telling the
/// tool every so often that the wait goes on. None when the tool gave up.
fn wait_for_mark(ask: &Ask, asked: std::time::Instant, progress: Option<Value>, events: mpsc::Sender<Event>,
                 heard: &mpsc::Receiver<Event>) -> Option<Reply> {
    let stream = match connect(heard) {
        Ok(stream) => stream,
        Err(Unreachable::GaveUp) => return None,
        Err(Unreachable::Because(message)) => return Some(Reply::Failed(message)),
    };
    // What is left of the tool's patience once Mark has the ask: opening Mark
    // may have taken some of it.
    let wait = ask.wait.map(|seconds| (seconds - asked.elapsed().as_secs_f64()).max(0.0));
    let message = json!({ "v": WIRE, "type": "ask", "client": ask.client, "prompt": ask.prompt, "mode": ask.mode, "wait": wait });
    let Ok(reader) = stream.try_clone() else { return Some(Reply::Failed("Mark couldn't be reached.".into())) };
    if write_line(&stream, &message).is_err() { return Some(Reply::Failed("Mark couldn't be reached.".into())); }
    // The answer is read on a thread of its own, so this one can keep the tool
    // posted and hear it give up.
    std::thread::spawn(move || {
        let answer = read_line(&mut BufReader::new(reader), ANSWER_LIMIT)
            .map_err(|_| QUIT.to_string()).and_then(|line| read_answer(&line));
        let _ = events.send(Event::Answer(answer));
    });
    let tell = |waited: u64| if let Some(token) = &progress {
        send(&json!({ "jsonrpc": "2.0", "method": "notifications/progress",
                      "params": { "progressToken": token, "progress": waited, "message": "Waiting for the screenshot" } }));
    };
    let mut waited = 0;
    tell(waited);
    loop {
        match heard.recv_timeout(PROGRESS_EVERY) {
            Ok(Event::Answer(answer)) => return Some(answer.unwrap_or_else(Reply::Failed)),
            Ok(Event::Cancel) => {
                let _ = write_line(&stream, &json!({ "v": WIRE, "type": "cancel" }));
                let _ = stream.shutdown(std::net::Shutdown::Both);
                return None;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                waited += PROGRESS_EVERY.as_secs();
                tell(waited);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Some(Reply::Failed(QUIT.into())),
        }
    }
}

/// The running Mark's socket -- opening Mark first if it isn't running, the
/// way Finder would, so that it is its own app to macOS and not a child of
/// the tool, whose permissions it would otherwise be judged by.
fn connect(heard: &mpsc::Receiver<Event>) -> Result<UnixStream, Unreachable> {
    let socket = folder().and_then(|folder| socket_in(&folder)).map_err(Unreachable::Because)?;
    if let Ok(stream) = UnixStream::connect(&socket) { return Ok(stream); }
    let app = std::env::current_exe().ok().as_deref().and_then(app_of)
        .ok_or_else(|| Unreachable::Because("Mark isn't running. Open Mark, then ask again.".into()))?;
    let opened = std::process::Command::new("/usr/bin/open").arg("-g").arg(&app).args(["--args", "--for-request"])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .status();
    if !opened.is_ok_and(|status| status.success()) { return Err(Unreachable::Because("Mark couldn't be opened.".into())); }
    let tick = Duration::from_millis(200);
    for _ in 0..(LAUNCH_WAIT.as_millis() / tick.as_millis()) {
        if let Ok(Event::Cancel) = heard.recv_timeout(tick) { return Err(Unreachable::GaveUp); }
        if let Ok(stream) = UnixStream::connect(&socket) { return Ok(stream); }
    }
    Err(Unreachable::Because("Mark didn't start in time. Open Mark, then ask again.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(action: Action) -> Value {
        match action { Action::Reply(value) => value, other => panic!("expected a reply, got {other:?}") }
    }

    #[test]
    fn the_newer_revision_and_anything_unknown_are_refused_at_once() {
        let mut bridge = Bridge::default();
        let discover = reply(respond(r#"{"jsonrpc":"2.0","id":0,"method":"server/discover","params":{}}"#, &mut bridge, None));
        assert_eq!(discover, json!({ "jsonrpc": "2.0", "id": 0, "error": { "code": -32601, "message": "Method not found" } }));
        let other = reply(respond(r#"{"jsonrpc":"2.0","id":"x","method":"resources/list"}"#, &mut bridge, None));
        assert_eq!(other["error"]["code"], -32601);
        assert_eq!(other["id"], "x");
        assert_eq!(reply(respond("not json", &mut bridge, None))["error"]["code"], -32700);
        assert_eq!(reply(respond("[1,2]", &mut bridge, None))["error"]["code"], -32600);
    }

    #[test]
    fn notifications_get_no_answer_of_any_kind() {
        let mut bridge = Bridge::default();
        for line in [r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                     r#"{"jsonrpc":"2.0","method":"notifications/whatever","params":{}}"#,
                     r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}"#,
                     r#"{"jsonrpc":"2.0","id":4,"result":{}}"#] {
            assert_eq!(respond(line, &mut bridge, None), Action::Nothing, "{line}");
        }
    }

    #[test]
    fn initialize_answers_in_the_tools_revision_or_the_newest() {
        let mut bridge = Bridge::default();
        let line = |version: &str| format!(r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{version}","capabilities":{{}},"clientInfo":{{"name":"claude-code","version":"2.1"}}}}}}"#);
        let answer = reply(respond(&line("2025-06-18"), &mut bridge, None));
        assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(answer["result"]["serverInfo"]["name"], "mark");
        assert_eq!(answer["result"]["capabilities"], json!({ "tools": { "listChanged": false } }));
        assert_eq!(reply(respond(&line("2099-01-01"), &mut bridge, None))["result"]["protocolVersion"], PROTOCOL);
        // Cline's command line still asks for the first revision; what Mark sends was in it.
        assert_eq!(reply(respond(&line("2024-11-05"), &mut bridge, None))["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(bridge.client.as_deref(), Some("Claude Code"));
        assert_eq!(reply(respond(r#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#, &mut bridge, None)),
                   json!({ "jsonrpc": "2.0", "id": "p", "result": {} }));
    }

    #[test]
    fn the_one_tool_says_what_it_takes() {
        let tools = reply(respond(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, &mut Bridge::default(), None));
        let tool = &tools["result"]["tools"][0];
        assert_eq!(tool["name"], "capture_screen");
        assert_eq!(tool["inputSchema"]["required"], json!(["prompt"]));
        assert_eq!(tool["inputSchema"]["properties"]["mode"]["enum"], json!(["region", "window", "screen"]));
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(tool["annotations"]["openWorldHint"], false);
    }

    #[test]
    fn a_call_is_checked_before_mark_is_asked() {
        let mut bridge = Bridge::default();
        let _ = respond(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"x","title":"Cursor Agent"}}}"#, &mut bridge, None);
        let call = |arguments: &str| format!(r#"{{"jsonrpc":"2.0","id":"c","method":"tools/call","params":{{"name":"capture_screen","arguments":{arguments},"_meta":{{"progressToken":"t"}}}}}}"#);
        assert_eq!(respond(&call(r#"{"prompt":"  the error dialog ","mode":"screen"}"#), &mut bridge, None), Action::Call {
            id: json!("c"),
            ask: Ask { client: "Cursor Agent".into(), prompt: "the error dialog".into(), mode: "display".into(), wait: Some(SDK_PATIENCE) },
            progress: Some(json!("t")),
        });
        // Bad arguments are the model's to read and fix: a result, not a protocol error.
        let missing = reply(respond(&call("{}"), &mut bridge, None));
        assert_eq!(missing["result"]["isError"], true);
        assert!(missing["result"]["content"][0]["text"].as_str().unwrap().contains("prompt"));
        assert_eq!(reply(respond(&call(r#"{"prompt":"x","mode":"video"}"#), &mut bridge, None))["result"]["isError"], true);
        // A second call while one waits.
        assert_eq!(reply(respond(&call(r#"{"prompt":"x"}"#), &mut bridge, Some(&json!(7))))["result"]["isError"], true);
        // A tool that isn't there is the protocol's error.
        let unknown = reply(respond(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rm","arguments":{}}}"#, &mut bridge, None));
        assert_eq!(unknown["error"]["code"], -32602);
    }

    #[test]
    fn only_a_tool_that_waits_as_long_as_it_takes_is_spared_the_count_down() {
        let call = r#"{"jsonrpc":"2.0","id":"c","method":"tools/call","params":{"name":"capture_screen","arguments":{"prompt":"x"}}}"#;
        let waits = |client: &str| {
            let mut bridge = Bridge::default();
            let _ = respond(&format!(r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"clientInfo":{{"name":"{client}"}}}}}}"#), &mut bridge, None);
            match respond(call, &mut bridge, None) { Action::Call { ask, .. } => (ask.client, ask.wait), other => panic!("{other:?}") }
        };
        assert_eq!(waits("claude-code"), ("Claude Code".into(), None));
        assert_eq!(waits("claude-desktop"), ("Claude".into(), Some(60.0)));
        assert_eq!(waits("some-editor"), ("some-editor".into(), Some(60.0)));
        // Each known tool by its own default.
        assert_eq!(waits("codex-mcp-client"), ("Codex".into(), Some(300.0)));
        assert_eq!(waits("gemini-cli-mcp-client"), ("Gemini CLI".into(), Some(600.0)));
        assert_eq!(waits("grok-shell-mark"), ("Grok Build".into(), None));
        assert_eq!(waits("opencode"), ("OpenCode".into(), None));
        assert_eq!(waits("cursor-vscode"), ("Cursor".into(), None));
        assert_eq!(waits("Visual Studio Code"), ("VS Code".into(), None));
        // As long as Mark's own line for each asks it to wait.
        assert_eq!(waits("copilot-cli"), ("GitHub Copilot".into(), Some(3600.0)));
        assert_eq!(waits("Zed"), ("Zed".into(), Some(600.0)));
        assert_eq!(waits("@cline/core"), ("Cline".into(), Some(60.0)));
        // Told how long is left, the app hears it; told nonsense, it hears nothing.
        assert_eq!(parse_ask(r#"{"v":1,"type":"ask","prompt":"x","wait":42.5}"#).unwrap().wait, Some(42.5));
        assert_eq!(parse_ask(r#"{"v":1,"type":"ask","prompt":"x","wait":-3}"#).unwrap().wait, None);
        assert_eq!(parse_ask(r#"{"v":1,"type":"ask","prompt":"x"}"#).unwrap().wait, None);
    }

    #[test]
    fn a_cancel_is_heard_only_for_the_call_that_is_waiting() {
        let mut bridge = Bridge::default();
        let cancel = |id: &str| format!(r#"{{"jsonrpc":"2.0","method":"notifications/cancelled","params":{{"requestId":{id},"reason":"user"}}}}"#);
        assert_eq!(respond(&cancel(r#""c""#), &mut bridge, Some(&json!("c"))), Action::Cancel(json!("c")));
        assert_eq!(respond(&cancel("5"), &mut bridge, Some(&json!(5))), Action::Cancel(json!(5)));
        assert_eq!(respond(&cancel("6"), &mut bridge, Some(&json!(5))), Action::Nothing);
        assert_eq!(respond(&cancel("5"), &mut bridge, None), Action::Nothing);
    }

    #[test]
    fn an_answer_becomes_the_calls_result() {
        assert_eq!(answered(Reply::Sent { png: "iVBOR".into(), text: "1. here".into() }), json!({ "content": [
            { "type": "image", "data": "iVBOR", "mimeType": "image/png" }, { "type": "text", "text": "1. here" }] }));
        assert_eq!(answered(Reply::Declined)["isError"], true);
        assert_eq!(answered(Reply::Declined)["content"][0]["text"], DECLINED);
        assert_eq!(answered(Reply::Failed("No.".into()))["content"][0]["text"], "No.");
    }

    #[test]
    fn what_a_tool_says_is_shown_as_plain_text() {
        assert_eq!(clean("  the\terror \n dialog  ", 200), "the error dialog");
        // Overrides that would show "exe.txt" reversed, and hidden tag characters, go.
        assert_eq!(clean("invoice\u{202E}txt.exe\u{E0041}\u{E0042}", 200), "invoicetxt.exe");
        assert_eq!(clean("a\u{200B}b\u{2066}c\u{FEFF}", 200), "abc");
        assert_eq!(clean("</script><b>x</b>", 200), "</script><b>x</b>", "markup is text; the page shows it as text");
        let long = clean(&"word ".repeat(100), 40);
        assert_eq!(long.chars().count(), 40);
        assert!(long.ends_with('…'));
        assert_eq!(clean("\u{0}\u{7}", 10), "");
    }

    fn agent<'a>(agents: &'a [Agent], name: &str) -> &'a How {
        &agents.iter().find(|agent| agent.name == name).unwrap_or_else(|| panic!("{name} missing")).how
    }

    #[test]
    fn each_tool_is_pointed_at_this_app_its_own_way() {
        let app = Path::new("/Applications/Mark.app/Contents/MacOS/mark");
        let all = agents(app).unwrap();
        let command = |name| match agent(&all, name) { How::Command { text } => text.clone(), other => panic!("{name}: {other:?}") };
        let config = |name| match agent(&all, name) { How::Config { place, text, restart } => (place.clone(), text.clone(), *restart), other => panic!("{name}: {other:?}") };
        let path = "'/Applications/Mark.app/Contents/MacOS/mark'";
        assert_eq!(command("Claude Code"), format!("claude mcp add --scope user mark -- {path} --mcp"));
        assert_eq!(command("Codex"), format!("codex mcp add mark -- {path} --mcp"));
        assert_eq!(command("Grok Build"), format!("grok mcp add mark -- {path} --mcp"));
        assert_eq!(command("GitHub Copilot CLI"), format!("copilot mcp add --timeout 3600000 mark -- {path} --mcp"));
        assert_eq!(command("Gemini CLI"), format!("gemini mcp add --scope user mark {path} -- --mcp"));
        assert_eq!(command("Qwen Code"), format!("qwen mcp add mark {path} -- --mcp"));
        let server = json!({ "command": "/Applications/Mark.app/Contents/MacOS/mark", "args": ["--mcp"] });
        let stdio = json!({ "type": "stdio", "command": "/Applications/Mark.app/Contents/MacOS/mark", "args": ["--mcp"] });
        for name in ["Claude Desktop", "Warp", "JetBrains AI", "Devin (Windsurf)", "Antigravity"] {
            assert_eq!(serde_json::from_str::<Value>(&config(name).1).unwrap(), json!({ "mcpServers": { "mark": server } }), "{name}");
        }
        assert_eq!(serde_json::from_str::<Value>(&config("Factory Droid").1).unwrap(), json!({ "mcpServers": { "mark": stdio } }));
        assert_eq!(serde_json::from_str::<Value>(&config("Crush").1).unwrap(), json!({ "mcp": { "mark": stdio } }));
        assert_eq!(config("Claude Desktop").2, true);
        assert_eq!(config("ChatGPT (Codex)"), ("~/.codex/config.toml".into(),
            "[mcp_servers.mark]\ncommand = \"/Applications/Mark.app/Contents/MacOS/mark\"\nargs = [\"--mcp\"]".into(), true));
        // Goose's lines go under the extensions it has, so they come indented.
        let (_, goose, _) = config("Goose");
        assert!(goose.starts_with("  mark:\n    enabled: true\n"));
        assert!(goose.contains("    cmd: \"/Applications/Mark.app/Contents/MacOS/mark\"\n    args: [\"--mcp\"]"));
        // Zed's go inside a settings file that has other settings, so they come
        // without braces of their own; read inside some, they are the server.
        let (_, zed, restart) = config("Zed");
        assert!(zed.starts_with("\"context_servers\": {") && !restart);
        assert_eq!(serde_json::from_str::<Value>(&format!("{{{zed}}}")).unwrap()["context_servers"]["mark"]["timeout"], 600);
        // Every name is listed once, under a group the page knows.
        let mut names: Vec<_> = all.iter().map(|agent| agent.name).collect();
        names.sort(); names.dedup();
        assert_eq!(names.len(), all.len());
        assert!(all.iter().all(|agent| ["Command line", "Apps", "Editors"].contains(&agent.group)));
    }

    /// What a link carries, read back the way the tool reads it.
    fn unescape(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' { out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap()); i += 3; } else { out.push(bytes[i]); i += 1; }
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn a_link_carries_the_server_as_each_editor_reads_it() {
        let app = Path::new("/Applications/Mark.app/Contents/MacOS/mark");
        let all = agents(app).unwrap();
        let How::Link { url } = agent(&all, "Cursor") else { panic!("a link") };
        let config = url.strip_prefix("cursor://anysphere.cursor-deeplink/mcp/install?name=mark&config=").unwrap();
        assert!(!config.contains(['+', '/', '=']), "base64's own characters, escaped for a link");
        let decoded = STANDARD.decode(unescape(config)).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&decoded).unwrap(), json!({ "command": app, "args": ["--mcp"] }));
        let How::Link { url } = agent(&all, "VS Code") else { panic!("a link") };
        let config = url.strip_prefix("vscode:mcp/install?").unwrap();
        assert!(config.chars().all(|c| c.is_ascii_alphanumeric() || "%-_.!~*'()".contains(c)));
        assert_eq!(serde_json::from_str::<Value>(&unescape(config)).unwrap(),
                   json!({ "name": "mark", "type": "stdio", "command": app, "args": ["--mcp"] }));
        // VS Code would read a % in the path twice; such a Mark gives its command.
        let odd = agents(Path::new("/Applications/100% Mark.app/Contents/MacOS/mark")).unwrap();
        let How::Command { text } = agent(&odd, "VS Code") else { panic!("a command") };
        assert!(text.starts_with("code --add-mcp '{") && text.contains("100% Mark.app"));
    }

    #[test]
    fn a_path_with_a_quote_is_quoted_and_a_temporary_copy_is_refused() {
        let odd = agents(Path::new("/Users/me/Apps/Tom's Mark.app/Contents/MacOS/mark")).unwrap();
        let How::Command { text } = agent(&odd, "Claude Code") else { panic!("a command") };
        assert!(text.contains(r"'/Users/me/Apps/Tom'\''s Mark.app/Contents/MacOS/mark'"));
        assert!(agents(Path::new("/private/var/folders/x/AppTranslocation/ABC/d/Mark.app/Contents/MacOS/mark")).is_err());
        assert!(agents(Path::new("/Users/me/Mark/src-tauri/target/debug/mark")).is_err());
    }

    #[test]
    fn only_a_link_mark_made_is_opened() {
        let app = Path::new("/Applications/Mark.app/Contents/MacOS/mark");
        assert!(link_for(app, "Cursor").unwrap().starts_with("cursor://anysphere.cursor-deeplink/mcp/install?"));
        assert!(link_for(app, "VS Code").unwrap().starts_with("vscode:mcp/install?"));
        assert!(link_for(app, "Claude Code").is_err(), "a command, not a link");
        assert!(link_for(app, "Nobody").is_err());
        // Every link Mark makes is in a scheme it opens.
        for agent in agents(app).unwrap() {
            if let How::Link { .. } = agent.how { assert!(link_for(app, agent.name).is_ok(), "{}", agent.name); }
        }
    }

    #[test]
    fn a_socket_path_too_long_for_macos_is_refused() {
        assert!(socket_in(Path::new("/Users/someone/Library/Application Support/com.markapp.Mark")).is_ok());
        assert!(socket_in(&Path::new("/Users").join("n".repeat(100))).is_err());
    }

    /// An app that answers every ask the same way, and notes withdrawals.
    struct Fake { answer: Option<Reply>, withdrawn: Mutex<Vec<u64>>, waiting: Mutex<Vec<mpsc::Sender<Reply>>> }
    impl Host for Fake {
        fn ask(&self, ask: Ask) -> Result<(u64, mpsc::Receiver<Reply>), String> {
            if ask.prompt == "refuse" { return Err("Not now.".into()); }
            let (tx, rx) = mpsc::channel();
            match &self.answer { Some(answer) => { tx.send(answer.clone()).unwrap(); } None => self.waiting.lock().unwrap().push(tx) }
            Ok((7, rx))
        }
        fn withdraw(&self, id: u64) {
            self.withdrawn.lock().unwrap().push(id);
            // Withdrawn, the app drops its sender, which ends the connection's wait.
            self.waiting.lock().unwrap().clear();
        }
    }

    fn fake(answer: Option<Reply>) -> (tempfile::TempDir, Arc<Fake>, PathBuf) {
        let folder = tempfile::Builder::new().prefix("m").tempdir_in("/tmp").unwrap();
        let host = Arc::new(Fake { answer, withdrawn: Mutex::default(), waiting: Mutex::default() });
        let bound = bind(folder.path()).unwrap();
        let path = bound.path().to_path_buf();
        serve(bound, host.clone());
        (folder, host, path)
    }

    fn ask_line(stream: &UnixStream, prompt: &str) {
        write_line(stream, &json!({ "v": WIRE, "type": "ask", "client": "Claude Code", "prompt": prompt, "mode": "region" })).unwrap();
    }

    #[test]
    fn an_ask_over_the_socket_gets_the_apps_answer() {
        let sent = Reply::Sent { png: "iVBOR".into(), text: "1. here".into() };
        let (_folder, _host, path) = fake(Some(sent.clone()));
        let stream = UnixStream::connect(&path).unwrap();
        ask_line(&stream, "the error");
        let line = read_line(&mut BufReader::new(stream.try_clone().unwrap()), ANSWER_LIMIT).unwrap();
        assert_eq!(read_answer(&line), Ok(sent));
        // Refused by the app: said so, with its reason.
        let stream = UnixStream::connect(&path).unwrap();
        ask_line(&stream, "refuse");
        let line = read_line(&mut BufReader::new(stream), ANSWER_LIMIT).unwrap();
        assert_eq!(read_answer(&line), Ok(Reply::Failed("Not now.".into())));
    }

    #[test]
    fn a_bridge_that_gives_up_withdraws_its_ask() {
        let (_folder, host, path) = fake(None);
        let stream = UnixStream::connect(&path).unwrap();
        ask_line(&stream, "the error");
        write_line(&stream, &json!({ "v": WIRE, "type": "cancel" })).unwrap();
        let mut rest = String::new();
        // Nothing comes back for a withdrawn ask: the app just closes.
        BufReader::new(stream).read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "");
        assert_eq!(*host.withdrawn.lock().unwrap(), [7]);
    }

    #[test]
    fn a_bridge_from_another_version_is_told_to_restart() {
        let (_folder, _host, path) = fake(Some(Reply::Declined));
        let stream = UnixStream::connect(&path).unwrap();
        write_line(&stream, &json!({ "v": 2, "type": "ask", "prompt": "x" })).unwrap();
        let line = read_line(&mut BufReader::new(stream), ANSWER_LIMIT).unwrap();
        assert!(matches!(read_answer(&line), Ok(Reply::Failed(message)) if message.contains("Restart")));
    }

    #[test]
    fn a_live_socket_is_left_alone_and_a_dead_one_replaced() {
        let folder = tempfile::Builder::new().prefix("m").tempdir_in("/tmp").unwrap();
        let first = bind(folder.path()).unwrap();
        // A second Mark can't take the socket from the first.
        assert!(bind(folder.path()).is_err());
        assert!(UnixStream::connect(first.path()).is_ok());
        // Once the first has gone -- its lock with it -- the socket it left is cleared and bound afresh.
        drop(first);
        assert!(folder.path().join("mcp.sock").exists());
        // Tests run side by side in one process, and one starting a program
        // shares this lock with the child for the moment before it runs; the
        // lock is free once that has passed.
        let mut second = bind(folder.path());
        for _ in 0..50 {
            if second.is_ok() { break; }
            std::thread::sleep(Duration::from_millis(20));
            second = bind(folder.path());
        }
        let second = second.unwrap();
        assert!(UnixStream::connect(second.path()).is_ok());
        let mode = std::fs::metadata(second.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::metadata(folder.path()).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
