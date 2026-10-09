mod capture;
mod glass;
mod macos;
pub mod mcp;
mod session;
mod settings;
mod thumbnail;
mod updates;
mod vision;

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri_plugin_dialog::DialogExt;
use session::{Reply, Session, Snapshot, State};
use std::{path::Path, sync::{Arc, Mutex, atomic::Ordering, mpsc}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu}, tray::TrayIconBuilder};

/// Kept so the tick can be corrected when macOS disagrees with what was asked.
struct LoginToggle(CheckMenuItem<tauri::Wry>);
/// The menu's four ways in, kept so each shows the shortcut chosen for it.
struct CaptureItems([MenuItem<tauri::Wry>; 4]);

/// The four ways into a capture, each of which can have a shortcut.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Way { Region, Window, Display, Timed }

impl Way {
    const ALL: [Way; 4] = [Way::Region, Way::Window, Way::Display, Way::Timed];
    fn named(mode: Option<&str>) -> Result<Way, String> {
        match mode {
            None | Some("region") => Ok(Way::Region),
            Some("window") => Ok(Way::Window),
            Some("display") => Ok(Way::Display),
            Some("timed") => Ok(Way::Timed),
            Some(other) => Err(format!("{other} isn't a way to capture.")),
        }
    }
    fn name(self) -> &'static str {
        match self { Way::Region => "Capture Region", Way::Window => "Capture Window", Way::Display => "Capture Whole Screen", Way::Timed => "Timed Region" }
    }
    /// Its shortcut, if it has one.
    fn shortcut(self, prefs: &settings::Settings) -> Option<&str> {
        match self {
            Way::Region => Some(prefs.shortcut.as_str()),
            Way::Window => prefs.shortcuts.window.as_deref(),
            Way::Display => prefs.shortcuts.display.as_deref(),
            Way::Timed => prefs.shortcuts.timed.as_deref(),
        }
    }
    fn start(self, app: &AppHandle) -> Result<(), String> {
        match self {
            Way::Region => capture_region(app.clone(), None, None),
            Way::Window => capture_region(app.clone(), None, Some(true)),
            Way::Display => capture_display(app.clone(), None),
            Way::Timed => capture_region(app.clone(), Some(5), None),
        }
    }
}

/// Every shortcut that is set, parsed, with the way in it starts.
fn bindings(prefs: &settings::Settings) -> Result<Vec<(Shortcut, Way)>, String> {
    Way::ALL.iter().filter_map(|way| way.shortcut(prefs).map(|text| (text, *way)))
        .map(|(text, way)| Shortcut::from_str(text).map(|shortcut| (shortcut, way)).map_err(|e| e.to_string()))
        .collect()
}

/// Two ways that would answer to one key, if any: the first of them, and the second.
fn clash(prefs: &settings::Settings) -> Option<(Way, Way)> {
    let all = bindings(prefs).ok()?;
    all.iter().enumerate().find_map(|(i, (shortcut, way))| all[i + 1..].iter().find(|(other, _)| other == shortcut).map(|(_, second)| (*way, *second)))
}
/// The settings as last loaded or saved; every window reads from here.
struct Prefs(Mutex<settings::Settings>);
/// The socket AI tools reach this Mark through, if it has it, so it goes when Mark does.
struct Socket(Option<std::path::PathBuf>);
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use std::str::FromStr;

const EDITOR: &str = "editor";
const SETTINGS: &str = "settings";
/// One overlay window per display, labelled selector-0, selector-1, and so on.
const SELECTOR: &str = "selector-";

/// What the editor needs around a capture, in points, mirroring the glass
/// layout in style.css: the title row, the toolbar pane and its gap above the
/// canvas, the gap below, and the footer flush with the bottom. Change both.
const CHROME: f64 = 46.0 + 48.0 + 10.0 + 10.0 + 60.0;
/// Beside it: the margin, the tool rail's pane, the gap to the canvas, and the
/// margin on the far side.
const RAIL: f64 = 44.0;
const SIDES: f64 = 12.0 + 10.0 + 12.0;
/// The rail's two panes, in points: nine tools less crop, then crop alone.
const RAIL_TOP: f64 = 46.0 + 48.0 + 10.0;
const TOOLS_HEIGHT: f64 = 4.0 + 8.0 * 36.0 + 7.0 * 2.0 + 4.0;
const CROP_TOP: f64 = RAIL_TOP + TOOLS_HEIGHT + 8.0;
/// The least canvas height at which all nine tools on the rail are on screen,
/// with a little air under the crop pane. The window never goes shorter: a tool
/// that has slipped below the edge with no scrollbar is a tool that does not
/// exist. Derived from the panes above rather than written out again, so adding
/// or removing a tool cannot leave the two disagreeing.
const RAIL_HEIGHT: f64 = TOOLS_HEIGHT + 8.0 + RAIL + 6.0;
/// Enough for the empty state and a row of recents. Its height is the window's
/// minimum, which the rail sets rather than the empty state; the empty state
/// has room to spare at this size and the footer is not there anyway.
const COMPACT: (f64, f64) = (560.0, CHROME + RAIL_HEIGHT);
/// The bar an AI tool's ask is shown in, and the gap under it, kept clear at
/// the top of the canvas while one waits. Mirrors .request-bar in style.css.
const REQUEST_BAR: f64 = 44.0 + 10.0;

/// Size the window to its contents: the capture at actual size where the screen
/// allows, and small when there is nothing to show. A screenshot editor whose
/// window is whatever size it was left at last time is arbitrary twice over --
/// too big for the empty state, the wrong shape for the next capture.
fn fit_window(app: &AppHandle, to: Option<(f64, f64)>) {
    let Some(window) = app.get_webview_window(EDITOR) else { return };
    let asked = app.state::<State>().lock().unwrap().request.is_some();
    let (mut width, mut height) = match to {
        Some((w, h)) => (w + SIDES + RAIL, h + CHROME + if asked { REQUEST_BAR } else { 0.0 }),
        None => COMPACT,
    };
    // Never larger than the screen it will appear on, less a margin so the
    // window does not sit edge to edge.
    if let Ok(Some(monitor)) = window.current_monitor().or_else(|_| app.primary_monitor()) {
        let visible = monitor.size().to_logical::<f64>(monitor.scale_factor());
        width = width.min(visible.width - 80.0);
        height = height.min(visible.height - 120.0);
    }
    let size = tauri::LogicalSize::new(width.max(380.0), height.max(CHROME + RAIL_HEIGHT));
    if window.set_size(size).is_ok() { let _ = window.center(); }
}

fn changed(app: &AppHandle) {
    if let Err(error) = app.emit_to(EDITOR, "capture-changed", ()) { eprintln!("[Mark] {error}"); }
}

fn present(app: &AppHandle) {
    // The editor takes over from a thumbnail, by whichever way it was opened.
    thumbnail::put_down(app);
    if let Some(window) = app.get_webview_window(EDITOR) {
        if let Err(error) = window.show().and_then(|_| window.set_focus()) { eprintln!("[Mark] {error}"); }
    }
}

fn report(app: &AppHandle, error: String) {
    eprintln!("[Mark] {error}");
    app.state::<State>().lock().unwrap().error = Some(error);
    changed(app); present(app);
}

#[tauri::command]
fn current_capture(app: AppHandle) -> Snapshot { app.state::<State>().lock().unwrap().snapshot() }

/// The overlay, for a region -- or, asked for a window, already picking one.
/// Space switches between the two either way, as it does in macOS's own.
#[tauri::command]
fn capture_region(app: AppHandle, delay: Option<u32>, window: Option<bool>) -> Result<(), String> {
    let delay = delay.unwrap_or(0).min(60);
    let window = window.unwrap_or(false);
    let handle = app.clone();
    app.run_on_main_thread(move || begin_selection(&handle, delay, window)).map_err(|e| e.to_string())
}

/// The whole display the pointer is on, with no overlay in between. The rest of
/// the path is the same as a region: one rectangle handed to screencapture.
#[tauri::command]
fn capture_display(app: AppHandle, delay: Option<u32>) -> Result<(), String> {
    let delay = delay.unwrap_or(0).min(60);
    let monitor = app.cursor_position().ok()
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No display was found to capture.")?;
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    let rect = capture::Rect { x: origin.x, y: origin.y, width: size.width, height: size.height };
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !ready_to_capture(&handle) { return; }
        take_selection(&handle, capture::Target::Region(rect), delay);
    }).map_err(|e| e.to_string())
}

/// Claim the capture guard and get the editor out of the shot. False means
/// something already has it, or screen access is missing and has been reported.
fn ready_to_capture(app: &AppHandle) -> bool {
    {
        let state = app.state::<State>();
        let mut session = state.lock().unwrap();
        if !session.begin_capture() { return false; }
        if let Some(pid) = macos::frontmost_pid().filter(|pid| *pid != std::process::id() as i32) {
            session.previous_pid = Some(pid);
        }
    }
    // A thumbnail still up would be in the shot; the new capture replaces it anyway.
    thumbnail::put_down(app);
    if !macos::screen_access() {
        app.state::<State>().lock().unwrap().busy = false;
        report(app, "Allow Mark's screen access in System Settings, then try Capture Region again. macOS may ask you to quit and reopen Mark.".into());
        return false;
    }
    let visible = app.get_webview_window(EDITOR).is_some_and(|w| w.is_visible().unwrap_or(false));
    app.state::<State>().lock().unwrap().editor_was_visible = visible;
    if let Some(window) = app.get_webview_window(EDITOR) { let _ = window.hide(); }
    changed(app);
    true
}

/// Put Mark's own selection overlay on every display. macOS's picker is not used:
/// it returns an image and nothing else, so it cannot keep a selection alive for
/// resizing, exact sizing, or a delayed shutter.
fn begin_selection(app: &AppHandle, delay: u32, window: bool) {
    if !ready_to_capture(app) { return; }
    if let Err(error) = open_selectors(app, delay, window) {
        close_selectors(app);
        app.state::<State>().lock().unwrap().busy = false;
        report(app, format!("The selection overlay couldn't open ({error})."));
    }
}

fn open_selectors(app: &AppHandle, delay: u32, window: bool) -> Result<(), String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() { return Err("no display was found".into()); }
    // The windows that can be picked, read once, before the overlays cover them,
    // and the pointer, so one is picked under a pointer that has not moved yet.
    let windows = capture::capturable(macos::windows_on_screen(), std::process::id() as i32);
    let pointer = macos::pointer();
    for (index, monitor) in monitors.iter().enumerate() {
        let scale = monitor.scale_factor();
        // Points, not pixels: window geometry and screencapture -R share this space.
        let origin = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        let window = tauri::WebviewWindowBuilder::new(
                app, format!("{SELECTOR}{index}"), tauri::WebviewUrl::App("selector.html".into()))
            .title("Mark selection")
            .position(origin.x, origin.y)
            .inner_size(size.width, size.height)
            .decorations(false).transparent(true).always_on_top(true)
            .skip_taskbar(true).shadow(false).resizable(false).visible(false)
            .accept_first_mouse(true)
            .initialization_script(selector_globals(
                capture::Rect { x: origin.x, y: origin.y, width: size.width, height: size.height }, scale,
                delay, &windows, window, pointer)?)
            .build().map_err(|e| e.to_string())?;
        if let Ok(handle) = window.ns_window() { macos::raise_overlay(handle); }
        window.show().map_err(|e| e.to_string())?;
    }
    macos::activate_self();
    if let Some(first) = app.get_webview_window(&format!("{SELECTOR}0")) { let _ = first.set_focus(); }
    Ok(())
}

/// What an overlay is told before its page runs. It reports a selection in
/// global points, so it needs to know where on the desktop its display starts;
/// and to pick a window, where the windows are, in the same points, and where
/// the pointer is. JSON throughout, so a window's title is only ever a string.
fn selector_globals(display: capture::Rect, scale: f64, delay: u32, windows: &[capture::Window], window: bool,
                    pointer: Option<(f64, f64)>) -> Result<String, String> {
    let json = |value: serde_json::Value| value.to_string();
    let globals = [
        ("__MARK_DISPLAY__", json(serde_json::json!({ "x": display.x, "y": display.y, "width": display.width,
                                                       "height": display.height, "scale": scale }))),
        ("__MARK_DELAY__", json(delay.into())),
        ("__MARK_WINDOWS__", serde_json::to_string(windows).map_err(|e| e.to_string())?),
        ("__MARK_MODE__", json((if window { "window" } else { "region" }).into())),
        ("__MARK_POINTER__", json(pointer.map_or(serde_json::Value::Null, |(x, y)| serde_json::json!({ "x": x, "y": y })))),
    ];
    Ok(globals.iter().map(|(name, value)| format!("window.{name}={value};")).collect())
}

fn close_selectors(app: &AppHandle) {
    let labels: Vec<String> = app.webview_windows().keys()
        .filter(|label| label.starts_with(SELECTOR)).cloned().collect();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); }
    }
}

fn set_tray_title(app: &AppHandle, text: Option<String>) {
    if let Some(tray) = app.tray_by_id("mark") { let _ = tray.set_title(text); }
}

#[tauri::command]
fn capture_rect(app: AppHandle, x: f64, y: f64, width: f64, height: f64, delay: u32) -> Result<(), String> {
    if ![x, y, width, height].iter().all(|value| value.is_finite()) {
        return Err("That selection isn't a valid region.".into());
    }
    if width < 1.0 || height < 1.0 { return Err("Select a larger region.".into()); }
    let rect = capture::Rect { x, y, width, height };
    let delay = delay.min(60);
    let handle = app.clone();
    app.run_on_main_thread(move || take_selection(&handle, capture::Target::Region(rect), delay)).map_err(|e| e.to_string())
}

/// One window, picked in the overlay, by the number the window server gave it.
/// It is looked up again rather than taken on trust: the window has to still be
/// there, and its size here is what the image's density is worked out from.
#[tauri::command]
fn capture_window(app: AppHandle, id: u32, delay: u32) -> Result<(), String> {
    let window = capture::capturable(macos::windows_on_screen(), std::process::id() as i32)
        .into_iter().find(|window| window.id == id)
        .ok_or("That window has closed. Pick another, or press Escape.")?;
    let target = capture::Target::Window { id, bounds: window.bounds() };
    let delay = delay.min(60);
    let handle = app.clone();
    app.run_on_main_thread(move || take_selection(&handle, target, delay)).map_err(|e| e.to_string())
}

fn take_selection(app: &AppHandle, target: capture::Target, delay: u32) {
    close_selectors(app);
    let (cancelled, previous) = {
        let state = app.state::<State>();
        let mut session = state.lock().unwrap();
        session.capturing = true;
        (session.cancelled.clone(), session.previous_pid)
    };
    macos::restore_focus(previous);
    let app = app.clone();
    std::thread::spawn(move || {
        // The screen must stay clear during a delay so the user can open the menu
        // or hover state they are capturing. The count goes in the menu bar
        // instead of on top of the shot.
        for remaining in (1..=delay).rev() {
            if cancelled.load(Ordering::SeqCst) { break; }
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || set_tray_title(&handle, Some(format!(" {remaining}"))));
            std::thread::sleep(Duration::from_secs(1));
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || set_tray_title(&handle, None));
        // Let the overlay actually leave the screen before the shutter.
        std::thread::sleep(Duration::from_millis(180));
        let result = capture::run_capture_cancellable(
            Path::new("/usr/sbin/screencapture"), &std::env::temp_dir(), &cancelled, Some(target));
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let mut wanted: Option<(f64, f64)> = None;
            let thumbnail_wanted = handle.state::<Prefs>().0.lock().unwrap().thumbnail();
            let mut thumb: Option<(Vec<u8>, u32, u32, f64)> = None;
            let show = {
                let state = handle.state::<State>();
                let mut session = state.lock().unwrap();
                session.busy = false; session.capturing = false;
                if session.quitting { drop(session); handle.exit(0); return; }
                match result {
                    Ok(Some(mut capture)) => {
                        // Pixels divided by the points asked for: exactly the
                        // density of the display it came off.
                        let (width, height) = target.size();
                        if width >= 1.0 { capture.scale = f64::from(capture.width) / width; }
                        wanted = Some((width, height));
                        // Taken from another app with the thumbnail chosen, and no AI
                        // tool waiting on it: the corner, not the editor.
                        if thumbnail_wanted && session.request.is_none() && !session.editor_was_visible {
                            thumb = Some((capture.png.clone(), capture.width, capture.height, capture.scale));
                        }
                        session.capture = Some(capture);
                        true
                    }
                    // Nothing taken: the editor comes back if it was there, or if
                    // an AI tool's ask is waiting in it.
                    Ok(None) => session.editor_was_visible || session.request.is_some(),
                    Err(error) => { session.error = Some(error); true }
                }
            };
            changed(&handle);
            // Resize before showing, so the window arrives at its size rather
            // than being seen to grow into it.
            if wanted.is_some() { fit_window(&handle, wanted); }
            if let Some((png, width, height, scale)) = thumb {
                // Copied at once, so it is on the clipboard whether or not
                // anyone opens it. If either fails, the editor says so, with
                // the capture in it.
                let floated = macos::copy_png(&png)
                    .and_then(|()| thumbnail::show(&handle, png, width, height, scale, target.rect()));
                if let Err(error) = floated { report(&handle, error); }
                return;
            }
            if show { present(&handle); }
        }) { eprintln!("[Mark] {error}"); }
    });
}

#[tauri::command]
fn cancel_selection(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        close_selectors(&handle);
        let (restore, previous) = {
            let state = handle.state::<State>();
            let mut session = state.lock().unwrap();
            session.busy = false;
            // Backing out of the overlay isn't backing out of an AI tool's ask:
            // the editor comes back with it, to capture again or decline.
            (session.editor_was_visible || session.request.is_some(), session.previous_pid)
        };
        changed(&handle);
        if restore { present(&handle); } else { macos::restore_focus(previous); }
    }).map_err(|e| e.to_string())
}

/// Closing is the caller's choice: copying to keep working is as common as
/// copying to be done.
#[tauri::command]
fn copy_capture(app: AppHandle, close: bool) -> Result<(), String> {
    let state = app.state::<State>();
    let session = state.lock().unwrap();
    if session.busy { return Err("Finish selecting the region first.".into()); }
    let capture = session.capture.as_ref().ok_or("There is no screenshot to copy.")?;
    macos::copy_png(&capture.png)?;
    drop(session);
    if close { dismiss_editor(app) } else { Ok(()) }
}

/// Plain text for the clipboard: the steps as a list, or the words read off the
/// image. Capped well past any real list, or any screenful of words.
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    if text.len() > 256 * 1024 { return Err("That's too much text to copy.".into()); }
    macos::copy_text(&text)
}

/// Copy Text: every line of words in the image, with where each word is, read
/// by Vision on the Mac. The editor sends the capture as it stands -- cropped,
/// without its marks -- and decides what to copy and in what order. Off the
/// main thread: reading a full screen takes a moment.
#[tauri::command]
async fn recognize_text(png: String) -> Result<Vec<vision::Line>, String> {
    let (bytes, width, height) = decode_png_sized(&png)?;
    tauri::async_runtime::spawn_blocking(move || vision::recognize(&bytes, width, height))
        .await.map_err(|e| e.to_string())?
}

/// Hide Sensitive: the words and where they are, as for Copy Text, and the
/// faces, in one reading of the image. The editor finds what in them should be
/// hidden.
#[tauri::command]
async fn scan_image(png: String) -> Result<vision::Scan, String> {
    let (bytes, width, height) = decode_png_sized(&png)?;
    tauri::async_runtime::spawn_blocking(move || vision::scan(&bytes, width, height, true))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn copy_edited(app: AppHandle, png: String, close: bool) -> Result<(), String> {
    // Roughly 96 MB of image once decoded, well past any real screenshot.
    if png.len() > 128 * 1024 * 1024 { return Err("The edited screenshot is too large to copy.".into()); }
    // No check for a live session capture: the editor also sends images it
    // restored from its own history, which Rust no longer holds. The bytes are
    // validated below, which is what actually matters here.
    if app.state::<State>().lock().unwrap().busy {
        return Err("Finish selecting the region first.".into());
    }
    let bytes = STANDARD.decode(png.as_bytes()).map_err(|_| "The edited screenshot couldn't be read.")?;
    capture::validate_png(&bytes)?;
    macos::copy_png(&bytes)?;
    if close { dismiss_editor(app) } else { Ok(()) }
}

#[tauri::command]
fn dismiss_editor(app: AppHandle) -> Result<(), String> { put_away(&app, None) }

/// The editor out of sight and empty, and the focus back where it was: with
/// the app named, or else the AI tool whose ask is closed unanswered, or else
/// the app in front before the capture. Closing the editor is a no to an ask
/// still waiting in it -- ⌘W, Escape, the close button and the menu all come
/// here -- so the tool hears that rather than waiting on.
fn put_away(app: &AppHandle, focus: Option<i32>) -> Result<(), String> {
    let state = app.state::<State>();
    let mut session = state.lock().unwrap();
    if session.busy { return Err("Press Escape to cancel the selection first.".into()); }
    if let Some(window) = app.get_webview_window(EDITOR) { window.hide().map_err(|e| e.to_string())?; }
    session.capture = None; session.error = None;
    let asked_from = session.request.as_ref().and_then(|request| request.return_to);
    session.end_request(Reply::Declined);
    let previous = session.previous_pid.take();
    drop(session);
    // Back to the empty state, so back to the small window.
    fit_window(app, None);
    changed(app); macos::restore_focus(focus.or(asked_from).or(previous));
    Ok(())
}

/// The capture out of the editor, as Copy and Close takes it, but with the
/// editor left as it is -- out of sight -- and the focus too: the thumbnail
/// that showed it has gone, and it waits in Recent, which the editor's own
/// render keeps as a capture leaves.
fn release_capture(app: &AppHandle) {
    {
        let state = app.state::<State>();
        let mut session = state.lock().unwrap();
        // A capture under way replaces it anyway.
        if session.busy { return; }
        session.capture = None; session.error = None; session.previous_pid = None;
    }
    fit_window(app, None);
    changed(app);
}

/// Send: the capture, as the editor flattened it for the AI tool that asked,
/// with what to say about it. Then the editor is put away as Copy and Close
/// puts it away, except that the focus goes back to the tool -- the app that
/// asked, not the app that was captured. A sync command, so it runs on the
/// main thread and must not wait: it hands the answer over and returns.
#[tauri::command]
fn send_capture(app: AppHandle, id: u64, png: String, text: String) -> Result<(), String> {
    // The size, the marks and the words read off it: generous, well short of a
    // tool's own limit on what a call may return.
    if text.len() > 160 * 1024 { return Err("The note to send with the screenshot is too long.".into()); }
    decode_png(&png)?;
    let return_to = {
        let state = app.state::<State>();
        let mut session = state.lock().unwrap();
        if session.busy { return Err("Finish selecting the region first.".into()); }
        session.answer(id, Reply::Sent { png, text })?
    };
    put_away(&app, return_to)
}

/// Don't Send: the tool is told no, and the editor stays as it is, capture and
/// all. An ask that has already ended needs no answer.
#[tauri::command]
fn decline_request(app: AppHandle, id: u64) {
    let _ = app.state::<State>().lock().unwrap().answer(id, Reply::Declined);
    changed(&app);
}

/// The running app, as AI tools reach it through the socket.
struct AppHost(AppHandle);

impl mcp::Host for AppHost {
    fn ask(&self, ask: mcp::Ask) -> Result<(u64, mpsc::Receiver<Reply>), String> {
        let app = &self.0;
        if !app.state::<Prefs>().0.lock().unwrap().mcp {
            return Err("The user has turned off screenshots for AI tools in Mark's Settings.".into());
        }
        // The selftest build answers with a fixture, so it needs no screen access.
        if !cfg!(feature = "mcp-selftest") && !macos::screen_access_granted() {
            return Err("Mark can't capture the screen until the user allows it in System Settings, under Privacy & \
                        Security, Screen & System Audio Recording.".into());
        }
        // Whatever arrives on the socket is cleaned here, once, so the editor
        // and anything after it only ever see text fit to show.
        let client = mcp::clean(&ask.client, 40);
        let prompt = mcp::clean(&ask.prompt, 200);
        if prompt.is_empty() { return Err("The request didn't say what to show.".into()); }
        let client = if client.is_empty() { "An AI tool".into() } else { client };
        let mode = if matches!(ask.mode.as_str(), "window" | "display") { ask.mode } else { "region".into() };
        // A tool that will give up says how soon; the editor counts down to it.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let deadline = ask.wait.map(|seconds| now + (seconds * 1000.0) as u64);
        let (reply, answer) = mpsc::channel();
        let id = app.state::<State>().lock().unwrap().ask(client, prompt, mode, deadline, reply)?;
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || show_request(&handle, id)) {
            app.state::<State>().lock().unwrap().withdraw(id);
            return Err(error.to_string());
        }
        #[cfg(feature = "mcp-selftest")]
        selftest::answer(app.clone(), id);
        Ok((id, answer))
    }

    fn withdraw(&self, id: u64) {
        let Some(client) = self.0.state::<State>().lock().unwrap().withdraw(id) else { return };
        let handle = self.0.clone();
        let _ = self.0.run_on_main_thread(move || {
            changed(&handle);
            let _ = handle.emit_to(EDITOR, "request-withdrawn", client);
        });
    }
}

/// An AI tool's ask, on screen: the editor, in front, with the ask in its bar
/// and the empty state or the capture under it -- unless a capture is under
/// way, which opens in the editor with the bar when it is done. The app that
/// asked is noted now, while it is still in front, to go back to on Send.
fn show_request(app: &AppHandle, id: u64) {
    let own = std::process::id() as i32;
    let (busy, shown) = {
        let state = app.state::<State>();
        let mut session = state.lock().unwrap();
        if let Some(request) = session.request.as_mut().filter(|request| request.id == id) {
            request.return_to = macos::frontmost_pid().filter(|pid| *pid != own);
        }
        let shown = session.capture.as_ref().map(|capture| (f64::from(capture.width) / capture.scale, f64::from(capture.height) / capture.scale));
        (session.busy, shown)
    };
    changed(app);
    if busy { return; }
    let Some(window) = app.get_webview_window(EDITOR) else { return };
    // Opening, it fits what it shows and the bar; already open, it is left
    // the size the user has it.
    if !window.is_visible().unwrap_or(false) { fit_window(app, shown); }
    if let Err(error) = window.show() { eprintln!("[Mark] {error}"); }
    if let Ok(handle) = window.ns_window() { macos::bring_forward(handle); }
    let _ = window.set_focus();
}

/// Which Mark this is, to an AI tool: the command for Claude Code and the entry
/// for Claude Desktop that start this copy of it as their bridge.
#[tauri::command]
fn mcp_setup() -> Result<mcp::Setup, String> {
    mcp::setup(&std::env::current_exe().map_err(|e| e.to_string())?)
}

/// A build for testing the bridge end to end, with no screen access and no
/// one at the keyboard: it answers each ask itself a moment after showing it.
/// A prompt with "decline" in it is declined, and one with "wait" is left
/// waiting, so a test can withdraw it or quit under it.
#[cfg(feature = "mcp-selftest")]
mod selftest {
    use super::*;
    pub fn answer(app: AppHandle, id: u64) {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            let (client, prompt) = app.state::<State>().lock().unwrap().request.as_ref()
                .map(|r| (r.client.clone(), r.prompt.clone())).unwrap_or_default();
            eprintln!("[Mark] selftest: request {id} from {client:?} to see {prompt:?}");
            if prompt.contains("wait") { eprintln!("[Mark] selftest: leaving request {id} waiting"); return; }
            let reply = if prompt.contains("decline") { Reply::Declined } else {
                Reply::Sent { png: STANDARD.encode(include_bytes!("../tests/text.png")), text: "Selftest: the text fixture.".into() }
            };
            let answered = app.state::<State>().lock().unwrap().answer(id, reply);
            eprintln!("[Mark] selftest: answered request {id}: {:?}", answered.as_ref().map(|_| ()));
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || { let _ = put_away(&handle, answered.ok().flatten()); });
        });
    }

    /// With MARK_SELFTEST_THUMBNAIL set to "x,y": the fixture, floated as a
    /// capture taken at that point would be -- without the clipboard, which is
    /// the user's -- and whether showing it moved the focus, and whether it
    /// went by itself, written to stderr. Where it went is the window server's
    /// to say.
    pub fn thumbnail(app: AppHandle) {
        let Some(point) = std::env::var("MARK_SELFTEST_THUMBNAIL").ok() else { return };
        let (x, y) = point.split_once(',').and_then(|(x, y)| Some((x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?)))
            .unwrap_or((400.0, 350.0));
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let before = macos::frontmost_pid();
                let png = include_bytes!("../tests/text.png").to_vec();
                let from = capture::Rect { x: x - 200.0, y: y - 150.0, width: 400.0, height: 300.0 };
                let shown = thumbnail::show(&handle, png, 800, 600, 2.0, from);
                let after = macos::frontmost_pid();
                eprintln!("[Mark] selftest: thumbnail for a capture at {x},{y} shown: {shown:?}; frontmost before {before:?}, after {after:?}");
            });
            for second in [3, 7] {
                std::thread::sleep(Duration::from_secs(if second == 3 { 3 } else { 4 }));
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let visible = handle.get_webview_window(thumbnail::LABEL).and_then(|w| w.is_visible().ok());
                    let held = handle.state::<State>().lock().unwrap().thumb.is_some();
                    eprintln!("[Mark] selftest: {second}s after: visible {visible:?}, thumbnail held {held}");
                });
            }
        });
    }
}

/// Keep a suggested filename to a filename: no separators, no traversal, and a
/// png extension whatever was asked for.
fn safe_name(name: &str) -> String {
    let trimmed: String = name.chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '\0'))
        .take(120).collect();
    let stem = trimmed.trim().trim_start_matches('.');
    let stem = stem.strip_suffix(".png").unwrap_or(stem);
    if stem.is_empty() { "Mark capture.png".into() } else { format!("{stem}.png") }
}

/// Ask where to put it, then write it. Async so it runs off the main thread,
/// which is what lets the save panel block without deadlocking the app.
#[tauri::command]
async fn save_image(app: AppHandle, png: String, name: String) -> Result<Option<String>, String> {
    let bytes = decode_png(&png)?;
    let chosen = app.dialog().file()
        .add_filter("PNG image", &["png"])
        .set_file_name(safe_name(&name))
        .blocking_save_file();
    let Some(chosen) = chosen else { return Ok(None) };      // cancelled
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| format!("The image couldn't be saved ({e})."))?;
    Ok(Some(path.file_name().unwrap_or_default().to_string_lossy().into_owned()))
}

/// Hand the image to macOS's share sheet. Synchronous, so it runs on the main
/// thread, which AppKit requires for showing the picker.
#[tauri::command]
fn share_image(app: AppHandle, png: String, name: String) -> Result<(), String> {
    let bytes = decode_png(&png)?;
    let directory = tempfile::Builder::new().prefix("Mark-share-").tempdir()
        .map_err(|e| format!("Nowhere to put the image to share it ({e})."))?;
    let path = directory.path().join(safe_name(&name));
    std::fs::write(&path, &bytes).map_err(|e| format!("The image couldn't be prepared ({e})."))?;
    let window = app.get_webview_window(EDITOR).ok_or("Mark's editor isn't open.")?;
    macos::share_file(window.ns_window().map_err(|e| e.to_string())?, &path)?;
    // Replacing this drops the previous share's directory, which removes it.
    app.state::<State>().lock().unwrap().share_dir = Some(directory);
    Ok(())
}

/// Base64 in, verified PNG bytes out. Everything leaving the editor as a file
/// or to another app goes through here first.
fn decode_png(png: &str) -> Result<Vec<u8>, String> { decode_png_sized(png).map(|(bytes, _, _)| bytes) }

/// The same, with the image's size in pixels.
fn decode_png_sized(png: &str) -> Result<(Vec<u8>, u32, u32), String> {
    if png.len() > 128 * 1024 * 1024 { return Err("That image is too large.".into()); }
    let bytes = STANDARD.decode(png.as_bytes()).map_err(|_| "The edited screenshot couldn't be read.")?;
    let (width, height) = capture::validate_png(&bytes)?;
    Ok((bytes, width, height))
}

/// Command-Q from the editor, which sees keys before the app's hidden menu
/// does and takes this one itself.
#[tauri::command]
fn quit_app(app: AppHandle) { app.exit(0); }

#[tauri::command]
fn open_screen_settings() -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}

thread_local! {
    /// Window views belong to the main thread, and so does this. Commands run
    /// there too, so they see the same value; anything else sees nothing and
    /// does nothing.
    static GLASS: std::cell::RefCell<Option<glass::Glass>> = const { std::cell::RefCell::new(None) };
}

/// Lay Liquid Glass under the editor's panes, where the stylesheet puts them.
/// The numbers are the stylesheet's; change both.
fn install_glass(app: &AppHandle) {
    let Some(window) = app.get_webview_window(EDITOR) else { return };
    let Ok(handle) = window.ns_window() else { return };
    let panes = [
        glass::Pane { x: 12.0, offset: 46.0, width: 0.0, height: 48.0, radius: 24.0, stretch: true, bottom: false },
        glass::Pane { x: 12.0, offset: RAIL_TOP, width: RAIL, height: TOOLS_HEIGHT, radius: 22.0, stretch: false, bottom: false },
        glass::Pane { x: 12.0, offset: CROP_TOP, width: RAIL, height: RAIL, radius: 22.0, stretch: false, bottom: false },
    ];
    let installed = glass::Glass::install(handle, &panes);
    eprintln!("[Mark] glass panes: {}", if installed.is_some() { "installed" } else { "unavailable" });
    GLASS.with(|slot| *slot.borrow_mut() = installed);
}

/// Whether the panes are on real glass, so the stylesheet can draw them bare.
#[tauri::command]
fn glass_available() -> bool { GLASS.with(|slot| slot.borrow().is_some()) }

/// The panes exist only while a capture is open.
#[tauri::command]
fn set_glass(visible: bool) { GLASS.with(|slot| { if let Some(glass) = slot.borrow().as_ref() { glass.set_visible(visible); } }); }

fn open_settings_pane(pane: &str) {
    let _ = std::process::Command::new("/usr/bin/open").arg(pane).spawn();
}

/// macOS is the source of truth here, not the menu: the tick is set from the
/// status after the change, never from what was requested.
fn toggle_login_item(app: &AppHandle) {
    let was_on = macos::login_item_status() == macos::LOGIN_ENABLED;
    if let Err(error) = macos::set_login_item(!was_on) {
        app.state::<LoginToggle>().0.set_checked(was_on).ok();
        report(app, error);
        return;
    }
    let status = macos::login_item_status();
    app.state::<LoginToggle>().0.set_checked(status == macos::LOGIN_ENABLED).ok();
    if status == macos::LOGIN_NEEDS_APPROVAL {
        report(app, "Allow Mark under Login Items in System Settings to finish turning this on.".into());
        open_settings_pane("x-apple.systempreferences:com.apple.LoginItems-Settings.extension");
    }
}

fn tooltip(shortcut: &str) -> String { format!("Mark — Capture Region ({})", pretty_shortcut(shortcut)) }

/// "Super+Alt+Digit4" as a person reads it: ⌥⌘4, modifiers in the order the
/// Mac prints them. The web side has the same function; this one is for the
/// tray, which the web side cannot reach.
pub fn pretty_shortcut(shortcut: &str) -> String {
    let mut symbols = String::new();
    let mut key = String::new();
    for part in shortcut.split('+') {
        match part.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => symbols.insert(0, '⌃'),
            "alt" | "option" => { let at = symbols.find(['⇧', '⌘']).unwrap_or(symbols.len()); symbols.insert(at, '⌥'); }
            "shift" => { let at = symbols.find('⌘').unwrap_or(symbols.len()); symbols.insert(at, '⇧'); }
            "super" | "cmd" | "command" | "meta" => symbols.push('⌘'),
            _ => key = part.strip_prefix("Digit").or_else(|| part.strip_prefix("Key")).unwrap_or(part).to_string(),
        }
    }
    format!("{symbols}{key}")
}

/// Replace whichever shortcuts are registered with these. If any one cannot be
/// taken, the ones before are put back, so a failed change never leaves Mark
/// with fewer shortcuts than it had.
fn register_shortcuts(app: &AppHandle, wanted: &settings::Settings, before: Option<&settings::Settings>) -> Result<(), String> {
    let shortcuts = bindings(wanted)?;
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    for (shortcut, _) in &shortcuts {
        if let Err(error) = app.global_shortcut().register(*shortcut) {
            let _ = app.global_shortcut().unregister_all();
            for (old, _) in before.and_then(|before| bindings(before).ok()).unwrap_or_default() { let _ = app.global_shortcut().register(old); }
            return Err(error.to_string());
        }
    }
    Ok(())
}

/// The menu's four ways in, each showing its shortcut, and the menu bar
/// item's tooltip Capture Region's.
fn show_shortcuts(app: &AppHandle, prefs: &settings::Settings) {
    if let Some(items) = app.try_state::<CaptureItems>() {
        for (item, way) in items.0.iter().zip(Way::ALL) { let _ = item.set_accelerator(way.shortcut(prefs)); }
    }
    if let Some(tray) = app.tray_by_id("mark") { let _ = tray.set_tooltip(Some(tooltip(&prefs.shortcut))); }
}

/// Dark and light are the window's own; system hands the choice back to macOS.
/// The material and the glass follow the window, and the web view's
/// prefers-color-scheme follows the material, so one call themes everything.
fn apply_appearance(app: &AppHandle, appearance: &str) {
    let theme = match appearance { "dark" => Some(tauri::Theme::Dark), "light" => Some(tauri::Theme::Light), _ => None };
    for label in [EDITOR, SETTINGS, updates::WINDOW] {
        if let Some(window) = app.get_webview_window(label) { let _ = window.set_theme(theme); }
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> settings::Settings { app.state::<Prefs>().0.lock().unwrap().clone() }

#[tauri::command]
fn set_appearance(app: AppHandle, appearance: String) -> Result<settings::Settings, String> {
    if !settings::Settings::appearance_is_valid(&appearance) { return Err(format!("{appearance} isn't an appearance.")); }
    let state = app.state::<Prefs>();
    let updated = { let mut prefs = state.0.lock().unwrap(); prefs.appearance = appearance; prefs.clone() };
    settings::save(&app, &updated)?;
    apply_appearance(&app, &updated.appearance);
    let _ = app.emit("settings-changed", &updated);
    Ok(updated)
}

/// A shortcut for one way in: Capture Region's when no mode is named, as it was
/// before there were others. An empty shortcut clears one -- all but Capture
/// Region's, which every launch shows and which always has one.
#[tauri::command]
fn set_shortcut(app: AppHandle, shortcut: String, mode: Option<String>) -> Result<settings::Settings, String> {
    let way = Way::named(mode.as_deref())?;
    let state = app.state::<Prefs>();
    let before = state.0.lock().unwrap().clone();
    let mut wanted = before.clone();
    let chosen = (!shortcut.trim().is_empty()).then_some(shortcut);
    match way {
        Way::Region => wanted.shortcut = chosen.ok_or("Capture Region always has a shortcut.")?,
        Way::Window => wanted.shortcuts.window = chosen,
        Way::Display => wanted.shortcuts.display = chosen,
        Way::Timed => wanted.shortcuts.timed = chosen,
    }
    // One key, one way: two that shared a key would race for it.
    if let Some((first, second)) = clash(&wanted) {
        let other = if first == way { second } else { first };
        return Err(format!("{} already uses {}.", other.name(), pretty_shortcut(way.shortcut(&wanted).unwrap_or_default())));
    }
    register_shortcuts(&app, &wanted, Some(&before)).map_err(|error| {
        if error.contains("already") || error.contains("in use") { "Something else on this Mac already uses that shortcut.".to_string() } else { error }
    })?;
    *state.0.lock().unwrap() = wanted.clone();
    settings::save(&app, &wanted)?;
    show_shortcuts(&app, &wanted);
    let _ = app.emit("settings-changed", &wanted);
    Ok(wanted)
}

/// The editor's Frame panel, remembered so the next capture is framed the same.
/// No settings-changed event: the editor is the only window that frames, and
/// it already knows what it just chose.
#[tauri::command]
fn set_frame(app: AppHandle, frame: settings::Frame) -> Result<settings::Settings, String> {
    let state = app.state::<Prefs>();
    let updated = { let mut prefs = state.0.lock().unwrap(); prefs.frame = frame.sanitized(); prefs.clone() };
    settings::save(&app, &updated)?;
    Ok(updated)
}

/// Open the editor after a capture, or float a thumbnail in the corner.
#[tauri::command]
fn set_after_capture(app: AppHandle, value: String) -> Result<settings::Settings, String> {
    if !settings::Settings::after_capture_is_valid(&value) { return Err(format!("{value} isn't something Mark does after a capture.")); }
    let state = app.state::<Prefs>();
    let updated = { let mut prefs = state.0.lock().unwrap(); prefs.after_capture = value; prefs.clone() };
    settings::save(&app, &updated)?;
    let _ = app.emit("settings-changed", &updated);
    Ok(updated)
}

/// Whether AI tools may ask. Turned off, an ask already waiting is ended too,
/// and its tool told why.
#[tauri::command]
fn set_mcp(app: AppHandle, enabled: bool) -> Result<settings::Settings, String> {
    let state = app.state::<Prefs>();
    let updated = { let mut prefs = state.0.lock().unwrap(); prefs.mcp = enabled; prefs.clone() };
    settings::save(&app, &updated)?;
    let ended = !enabled && app.state::<State>().lock().unwrap()
        .end_request(Reply::Failed("The user has turned off screenshots for AI tools in Mark's Settings.".into()));
    if ended { changed(&app); }
    let _ = app.emit("settings-changed", &updated);
    Ok(updated)
}

#[tauri::command]
fn login_enabled() -> bool { macos::login_item_status() == macos::LOGIN_ENABLED }

/// Returns whether it is on afterwards, which macOS decides, not the request:
/// a first turn-on may need approving under Login Items in System Settings.
#[tauri::command]
fn set_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    macos::set_login_item(enabled)?;
    let status = macos::login_item_status();
    app.state::<LoginToggle>().0.set_checked(status == macos::LOGIN_ENABLED).ok();
    if status == macos::LOGIN_NEEDS_APPROVAL {
        open_settings_pane("x-apple.systempreferences:com.apple.LoginItems-Settings.extension");
        return Err("Allow Mark under Login Items in System Settings to finish turning this on.".into());
    }
    Ok(status == macos::LOGIN_ENABLED)
}

/// One settings window, made the first time it is asked for and shown after.
#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(SETTINGS) {
        Some(window) => window,
        None => panel(&app, SETTINGS, "settings.html", "Mark Settings", 460.0, 716.0, true)?,
    };
    macos::activate_self();
    window.show().and_then(|_| window.set_focus()).map_err(|e| e.to_string())
}

/// A small window of Mark's own, in its glass and the appearance chosen in
/// Settings: Settings itself, and Software Update. Each grows to fit what it
/// shows, so the height given here is only where it starts. One made hidden
/// is shown by its own page, once it fits.
pub(crate) fn panel(app: &AppHandle, label: &str, page: &str, title: &str, width: f64, height: f64, visible: bool)
    -> Result<tauri::WebviewWindow, String> {
    let appearance = app.state::<Prefs>().0.lock().unwrap().appearance.clone();
    let theme = match appearance.as_str() { "dark" => Some(tauri::Theme::Dark), "light" => Some(tauri::Theme::Light), _ => None };
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(page.into()))
        .title(title).inner_size(width, height).visible(visible).resizable(false).maximizable(false).minimizable(false)
        // The editor floats above other windows; a window at the normal level
        // would open underneath the very window that opened it.
        .always_on_top(true)
        .transparent(true).theme(theme)
        .effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Sidebar)
            .state(tauri::window::EffectState::Active).radius(12.0).build())
        .center().build().map_err(|e| e.to_string())
}

fn menu_action(app: &AppHandle, id: &str) {
    match id {
        "capture" => { if let Err(e) = Way::Region.start(app) { report(app, e); } }
        "window" => { if let Err(e) = Way::Window.start(app) { report(app, e); } }
        "display" => { if let Err(e) = Way::Display.start(app) { report(app, e); } }
        "timed" => { if let Err(e) = Way::Timed.start(app) { report(app, e); } }
        "show" => present(app),
        // The editor copies: it alone can flatten the drawing into the image.
        // Copying the capture from here would copy it without its marks.
        "copy" => { if let Err(error) = app.emit_to(EDITOR, "copy-and-close", ()) { eprintln!("[Mark] {error}"); } }
        "close" => { let _ = dismiss_editor(app.clone()); }
        "login" => toggle_login_item(app),
        "settings" => { if let Err(e) = open_settings(app.clone()) { report(app, e); } }
        "updates" => { if let Err(e) = updates::show(app, true) { report(app, e); } }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Session::default()))
        .manage(updates::Pending::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, pressed, event| {
            if event.state() != ShortcutState::Pressed { return; }
            // Whichever way the key belongs to; Capture Region, before settings are in.
            let way = app.try_state::<Prefs>()
                .and_then(|prefs| bindings(&prefs.0.lock().unwrap()).ok())
                .and_then(|all| all.into_iter().find(|(shortcut, _)| shortcut == pressed).map(|(_, way)| way))
                .unwrap_or(Way::Region);
            if let Err(e) = way.start(app) { report(app, e); }
        }).build())
        .invoke_handler(tauri::generate_handler![current_capture, capture_region, capture_display, capture_rect, capture_window, cancel_selection,
            copy_capture, copy_edited, copy_text, recognize_text, scan_image, save_image, share_image, dismiss_editor, open_screen_settings, glass_available, set_glass,
            send_capture, decline_request, mcp_setup,
            thumbnail::thumbnail_image, thumbnail::open_thumbnail, thumbnail::close_thumbnail, thumbnail::drag_thumbnail,
            get_settings, set_appearance, set_shortcut, set_frame, set_after_capture, set_mcp, login_enabled, set_login, open_settings, quit_app,
            updates::check_for_update, updates::pending_update, updates::install_update, updates::skip_update,
            updates::set_auto_update, updates::open_updates])
        .on_menu_event(|app, event| menu_action(app, event.id.as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != EDITOR { return; }
                api.prevent_close();
                let _ = dismiss_editor(window.app_handle().clone());
            }
        })
        .setup(|app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let prefs = settings::load(app.handle());
            let capture = MenuItem::with_id(app, "capture", Way::Region.name(), true, Way::Region.shortcut(&prefs))?;
            let window = MenuItem::with_id(app, "window", Way::Window.name(), true, Way::Window.shortcut(&prefs))?;
            let display = MenuItem::with_id(app, "display", Way::Display.name(), true, Way::Display.shortcut(&prefs))?;
            let timed = MenuItem::with_id(app, "timed", Way::Timed.name(), true, Way::Timed.shortcut(&prefs))?;
            let show = MenuItem::with_id(app, "show", "Show Editor", true, None::<&str>)?;
            let preferences = MenuItem::with_id(app, "settings", "Settings…", true, Some("Super+Comma"))?;
            let quit = MenuItem::with_id(app, "quit", "Quit Mark", true, Some("Super+Q"))?;
            let check = MenuItem::with_id(app, "updates", "Check for Updates…", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let login = CheckMenuItem::with_id(app, "login", "Open at Login", true,
                macos::login_item_status() == macos::LOGIN_ENABLED, None::<&str>)?;
            app.manage(LoginToggle(login.clone()));
            app.manage(CaptureItems([capture.clone(), window.clone(), display.clone(), timed.clone()]));
            let tray_menu = Menu::with_items(app, &[&capture, &window, &display, &timed, &show, &separator, &login, &preferences, &check, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("mark")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true).tooltip(tooltip(&prefs.shortcut))
                .menu(&tray_menu).build(app)?;
            let copy = MenuItem::with_id(app, "copy", "Copy and Close", true, Some("Alt+Super+C"))?;
            let close = MenuItem::with_id(app, "close", "Close", true, Some("Super+W"))?;
            let main = Submenu::with_items(app, "Mark", true, &[&capture, &window, &display, &timed, &show, &separator, &login, &preferences, &check, &separator, &quit])?;
            // Never shown, since an accessory app has no menu bar, but still
            // where AppKit sends a key the page leaves alone. That is how a text
            // field gets its editing keys: the page lets ⌘C, ⌘X, ⌘V, ⌘A and ⌘Z
            // through inside a field, and without these items they did nothing
            // -- or, for ⌘C, found Copy and Close.
            let edit = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?, &PredefinedMenuItem::select_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &copy, &close,
            ])?;
            app.set_menu(Menu::with_items(app, &[&main, &edit])?)?;
            install_glass(app.handle());
            apply_appearance(app.handle(), &prefs.appearance);
            if let Err(error) = register_shortcuts(app.handle(), &prefs, None) {
                report(app.handle(), format!("A capture shortcut is unavailable ({error}). Use Mark's menu to capture, or choose another in Settings."));
            }
            app.manage(Prefs(Mutex::new(prefs)));
            // AI tools reach Mark through a socket only this user can open, for
            // as long as Mark runs. A Mark that can't have it -- another one is
            // answering already -- runs on without.
            let socket = match mcp::folder().and_then(|folder| mcp::bind(&folder)) {
                Ok(bound) => {
                    let path = bound.path().to_path_buf();
                    mcp::serve(bound, Arc::new(AppHost(app.handle().clone())));
                    Some(path)
                }
                Err(error) => { eprintln!("[Mark] AI tools can't reach this Mark: {error}"); None }
            };
            app.manage(Socket(socket));
            std::thread::spawn(thumbnail::sweep);
            #[cfg(feature = "mcp-selftest")]
            selftest::thumbnail(app.handle().clone());
            updates::watch(app.handle().clone());
            // Say up front that capture will not work, rather than letting the
            // first Capture Region be the thing that discovers it.
            if !macos::screen_access_granted() {
                app.state::<State>().lock().unwrap().error =
                    Some("Mark needs screen access to capture. Open System Settings to allow it, then reopen Mark.".into());
            }
            // A login launch should be silent; every other launch must show
            // something, because a tray-only start looks like a failed one. Both
            // signals have to agree, so anything ambiguous -- a login item opened
            // by hand, a second session without a reboot -- errs towards showing
            // the window, which is the harmless direction to be wrong in.
            let at_login = macos::login_item_status() == macos::LOGIN_ENABLED
                && macos::seconds_since_boot() < 300.0;
            // Opened by an AI tool's bridge, the ask it brings is what to show.
            let for_request = std::env::args().any(|arg| arg == "--for-request");
            if !at_login && !for_request { present(app.handle()); }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build Mark")
        .run(|app, event| {
            // Opening a menu bar app that is already running has to show
            // something. Without this the editor stays hidden and re-opening
            // Mark looks exactly like a launch that failed.
            if let tauri::RunEvent::Reopen { .. } = event { present(app); }
            if let tauri::RunEvent::Exit = event {
                // A tool still waiting hears why no screenshot is coming, and the
                // socket goes with the app that answered on it.
                app.state::<State>().lock().unwrap().end_request(Reply::Failed(mcp::QUIT.into()));
                if let Some(path) = app.try_state::<Socket>().and_then(|socket| socket.0.clone()) { let _ = std::fs::remove_file(path); }
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Only a shutter already in flight is worth delaying a quit for.
                // A selection still on screen just goes away.
                let capturing = {
                    let state = app.state::<State>();
                    let mut session = state.lock().unwrap();
                    if session.capturing {
                        session.quitting = true;
                        session.cancelled.store(true, Ordering::SeqCst);
                    }
                    session.capturing
                };
                if capturing { api.prevent_exit(); } else { close_selectors(app); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{bindings, capture, clash, pretty_shortcut, safe_name, selector_globals, settings, Way};

    /// Each shortcut that is set starts its own way in; one that is not, none.
    #[test]
    fn each_shortcut_belongs_to_its_way_in() {
        let mut prefs = settings::Settings::default();
        prefs.shortcuts.window = Some("Alt+Super+Digit4".into());
        prefs.shortcuts.timed = Some("Shift+Super+KeyT".into());
        let ways: Vec<Way> = bindings(&prefs).unwrap().into_iter().map(|(_, way)| way).collect();
        assert_eq!(ways, [Way::Region, Way::Window, Way::Timed]);
        assert_eq!(Way::named(None), Ok(Way::Region));
        assert_eq!(Way::named(Some("display")), Ok(Way::Display));
        assert!(Way::named(Some("video")).is_err());
    }

    /// Two ways may not share a key, however each is written.
    #[test]
    fn two_ways_cannot_share_a_key() {
        let mut prefs = settings::Settings::default();
        assert_eq!(clash(&prefs), None);
        prefs.shortcuts.display = Some("Super+Digit4".into());                  // Capture Region's own
        assert_eq!(clash(&prefs), Some((Way::Region, Way::Display)));
        prefs.shortcuts.display = Some("Command+Digit4".into());                // the same key, spelled otherwise
        assert_eq!(clash(&prefs), Some((Way::Region, Way::Display)));
        prefs.shortcuts.display = Some("Alt+Super+Digit4".into());
        assert_eq!(clash(&prefs), None);
    }

    /// The overlay's whole picture of the screen arrives as this one script; a
    /// slip in it and the overlay knows nothing -- not even where its display is.
    #[test]
    fn an_overlay_is_told_its_display_the_windows_and_the_pointer_as_plain_data() {
        let display = capture::Rect { x: 1440.0, y: -120.0, width: 1728.0, height: 1117.0 };
        let windows = [capture::Window { id: 7, app: "Notes".into(), title: "\"Quotes\" </script> and \\".into(),
                                         x: 1500.0, y: 40.5, width: 800.0, height: 600.0 }];
        assert_eq!(selector_globals(display, 2.0, 5, &windows, true, Some((1600.25, 300.0))).unwrap(),
            "window.__MARK_DISPLAY__={\"height\":1117.0,\"scale\":2.0,\"width\":1728.0,\"x\":1440.0,\"y\":-120.0};\
             window.__MARK_DELAY__=5;\
             window.__MARK_WINDOWS__=[{\"id\":7,\"app\":\"Notes\",\"title\":\"\\\"Quotes\\\" </script> and \\\\\",\"x\":1500.0,\"y\":40.5,\"width\":800.0,\"height\":600.0}];\
             window.__MARK_MODE__=\"window\";\
             window.__MARK_POINTER__={\"x\":1600.25,\"y\":300.0};");
        let region = selector_globals(display, 1.0, 0, &[], false, None).unwrap();
        assert!(region.contains("window.__MARK_WINDOWS__=[];") && region.contains("window.__MARK_MODE__=\"region\";")
                && region.ends_with("window.__MARK_POINTER__=null;"));
    }

    /// A command a window may not call fails at runtime with "not allowed by
    /// ACL", and a call whose error is caught fails silently. Every command
    /// declared here must be registered in build.rs, wired into the invoke
    /// handler, and granted to at least one window; anything else is a
    /// feature that quietly does nothing.
    /// Every file of a kind in one of the crate's folders, read now, so a
    /// module or a window added later is checked without anyone listing it here.
    fn every(folder: &str, extension: &str) -> Vec<String> {
        let mut files: Vec<_> = std::fs::read_dir(format!("{}/{folder}", env!("CARGO_MANIFEST_DIR"))).unwrap()
            .map(|entry| entry.unwrap().path()).filter(|path| path.extension().is_some_and(|e| e == extension)).collect();
        files.sort();
        files.iter().map(|path| std::fs::read_to_string(path).unwrap()).collect()
    }

    #[test]
    fn every_command_is_registered_wired_and_granted() {
        let sources = every("src", "rs").join("\n");
        let build = include_str!("../build.rs");
        let capabilities = every("capabilities", "json").concat();
        let handler = include_str!("lib.rs").split("generate_handler![").nth(1).and_then(|rest| rest.split("])").next()).expect("an invoke handler");
        let lines: Vec<&str> = sources.lines().collect();
        let mut problems = Vec::new();
        let mut seen = 0;
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" { continue; }
            let bare = |l: &&str| l.trim_start().trim_start_matches("pub(crate) ").trim_start_matches("pub ").to_string();
            let signature = lines[i + 1..].iter().map(bare).find(|l| l.starts_with("fn ") || l.starts_with("async fn "))
                .expect("a function after the attribute");
            let name = signature.trim_start_matches("async ").trim_start_matches("fn ").split('(').next().unwrap().to_string();
            let name = name.as_str();
            seen += 1;
            if !build.contains(&format!("\"{name}\"")) { problems.push(format!("{name}: not in build.rs, so no permission exists for it")); }
            if !handler.contains(name) { problems.push(format!("{name}: not in the invoke handler")); }
            if !capabilities.contains(&format!("allow-{}", name.replace('_', "-"))) { problems.push(format!("{name}: no window is allowed to call it")); }
        }
        assert!(seen >= 20, "found only {seen} commands; the scan is broken");
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }

    /// A capability file that is not named in tauri.conf.json is written into
    /// the generated schemas and never compiled into the app -- which is how
    /// the settings window came to be refused every command while every check
    /// of the generated output said it was granted them.
    #[test]
    fn every_capability_file_is_compiled_in() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let compiled: Vec<&str> = config["app"]["security"]["capabilities"].as_array().expect("an explicit capability list")
            .iter().filter_map(|v| v.as_str()).collect();
        for file in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).unwrap() {
            let path = file.unwrap().path();
            let capability: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let id = capability["identifier"].as_str().unwrap();
            assert!(compiled.contains(&id), "{}: capability '{id}' is not in app.security.capabilities, so it does nothing", path.display());
        }
    }

    /// The tray shows the shortcut the way the Mac prints it, and must agree
    /// with the web side's prettyShortcut on every case that side tests.
    #[test]
    fn a_shortcut_reads_the_way_the_mac_prints_it() {
        assert_eq!(pretty_shortcut("Super+Digit4"), "⌘4");
        assert_eq!(pretty_shortcut("Control+Alt+Super+Digit4"), "⌃⌥⌘4");
        assert_eq!(pretty_shortcut("Super+Shift+KeyM"), "⇧⌘M");
        assert_eq!(pretty_shortcut("Alt+Shift+Super+KeyM"), "⌥⇧⌘M");
        assert_eq!(pretty_shortcut("ctrl+option+F5"), "⌃⌥F5");
    }

    #[test]
    fn a_suggested_filename_stays_a_filename() {
        assert_eq!(safe_name("Mark 2026-09-09 at 10.35.42.png"), "Mark 2026-09-09 at 10.35.42.png");
        assert_eq!(safe_name("Mark capture"), "Mark capture.png");
    }

    #[test]
    fn a_suggested_filename_cannot_climb_out_of_the_folder() {
        // Separators and leading dots go, so nothing here can name a directory.
        assert_eq!(safe_name("../../etc/passwd"), "etcpasswd.png");
        assert_eq!(safe_name("/tmp/evil"), "tmpevil.png");
        assert_eq!(safe_name(".ssh/id_rsa"), "sshid_rsa.png");
        for name in ["../../etc/passwd", "/tmp/evil", "a\\b", "x:y"] {
            let safe = safe_name(name);
            assert!(!safe.contains('/') && !safe.contains('\\') && !safe.contains(':'));
            assert!(!safe.starts_with('.'));
        }
    }

    #[test]
    fn an_empty_or_absurd_name_still_gives_a_usable_one() {
        assert_eq!(safe_name(""), "Mark capture.png");
        assert_eq!(safe_name("   "), "Mark capture.png");
        assert_eq!(safe_name("...."), "Mark capture.png");
        assert!(safe_name(&"n".repeat(500)).len() <= 124);
        assert!(safe_name("anything").ends_with(".png"));
    }
}
