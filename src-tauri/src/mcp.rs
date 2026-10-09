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
const PROTOCOLS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
/// The line protocol between bridge and app. A bridge started before Mark
/// updated itself keeps running the old code, so each side checks the other's.
const WIRE: u64 = 1;
const TOOL: &str = "capture_screen";
/// The ask is a few lines of text; this is far more than one needs.
const ASK_LIMIT: u64 = 64 * 1024;
/// The answer can carry a whole screenshot.
const ANSWER_LIMIT: u64 = 96 * 1024 * 1024;
/// How often a waiting call tells the tool it is still waiting. Claude Code
/// gives a stdio server thirty quiet minutes; each of these starts them again.
const PROGRESS_EVERY: Duration = Duration::from_secs(10);
/// How long the bridge waits for a Mark it had to open.
const LAUNCH_WAIT: Duration = Duration::from_secs(15);
/// How long a tool built on the MCP SDK waits for a call, unless it asks for
/// longer: a minute, which progress does not extend. Claude Desktop is one.
/// Claude Code is not: it waits a day, and progress keeps its idle limit off.
const SDK_PATIENCE: f64 = 60.0;

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

/// What to paste where, for the Mark at this path: a command for Claude Code,
/// and the entry for Claude Desktop's settings file.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup { pub claude_code: String, pub claude_desktop: String }

pub fn setup(binary: &Path) -> Result<Setup, String> {
    let text = binary.to_str().ok_or("Mark's location can't be written down as text.")?;
    if text.contains("/AppTranslocation/") {
        return Err("Move Mark to your Applications folder first: macOS is running it from a temporary copy.".into());
    }
    if app_of(binary).is_none() { return Err("This Mark isn't running from its app, so there's nothing for an AI tool to start.".into()); }
    // Single quotes keep any character in a path as itself, but a single quote.
    let quoted = format!("'{}'", text.replace('\'', r"'\''"));
    let entry = json!({ "mcpServers": { "mark": { "command": text, "args": ["--mcp"] } } });
    Ok(Setup {
        claude_code: format!("claude mcp add --scope user mark -- {quoted} --mcp"),
        claude_desktop: serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?,
    })
}

// ---- the bridge ------------------------------------------------------------

/// What the bridge knows of the conversation: who it is talking to, and
/// whether that tool waits for as long as a call takes.
#[derive(Default)]
pub struct Bridge { client: Option<String>, patient: bool }

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
            bridge.patient = patient(&params);
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
    let wait = (!bridge.patient).then_some(SDK_PATIENCE);
    Action::Call { id, ask: Ask { client, prompt: prompt.into(), mode: mode.into(), wait }, progress }
}

/// The tool's own name for itself, as a person would say it.
fn client_name(params: &Value) -> Option<String> {
    let info = params.get("clientInfo")?;
    let text = |key: &str| info.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    if let Some(title) = text("title") { return Some(title.into()); }
    Some(match text("name")? {
        "claude-code" => "Claude Code",
        "claude-ai" | "claude-desktop" | "claude-desktop-3p" => "Claude",
        "cursor-vscode" => "Cursor",
        other => other,
    }.into())
}

/// Whether the tool waits for as long as a call takes rather than the SDK's
/// minute. Only Claude Code is known to; a tool that is not known is taken at
/// the SDK's word, and the editor counts its minute down.
fn patient(params: &Value) -> bool { params["clientInfo"]["name"].as_str() == Some("claude-code") }

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
    let mut waited = 0;
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
                if let Some(token) = &progress {
                    send(&json!({ "jsonrpc": "2.0", "method": "notifications/progress",
                                  "params": { "progressToken": token, "progress": waited, "message": "Waiting for the screenshot" } }));
                }
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

    #[test]
    fn setup_points_at_the_app_and_quotes_it() {
        let made = setup(Path::new("/Applications/Mark.app/Contents/MacOS/mark")).unwrap();
        assert_eq!(made.claude_code, "claude mcp add --scope user mark -- '/Applications/Mark.app/Contents/MacOS/mark' --mcp");
        let entry: Value = serde_json::from_str(&made.claude_desktop).unwrap();
        assert_eq!(entry, json!({ "mcpServers": { "mark": { "command": "/Applications/Mark.app/Contents/MacOS/mark", "args": ["--mcp"] } } }));
        let odd = setup(Path::new("/Users/me/Apps/Tom's Mark.app/Contents/MacOS/mark")).unwrap();
        assert!(odd.claude_code.contains(r"'/Users/me/Apps/Tom'\''s Mark.app/Contents/MacOS/mark'"));
        assert!(setup(Path::new("/private/var/folders/x/AppTranslocation/ABC/d/Mark.app/Contents/MacOS/mark")).is_err());
        assert!(setup(Path::new("/Users/me/Mark/src-tauri/target/debug/mark")).is_err());
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
        let second = bind(folder.path()).unwrap();
        assert!(UnixStream::connect(second.path()).is_ok());
        let mode = std::fs::metadata(second.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::metadata(folder.path()).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
