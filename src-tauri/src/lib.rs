mod capture;
mod glass;
mod macos;
mod session;
mod settings;

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri_plugin_dialog::DialogExt;
use session::{Session, Snapshot, State};
use std::{path::Path, sync::{Mutex, atomic::Ordering}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu}, tray::TrayIconBuilder};

/// Kept so the tick can be corrected when macOS disagrees with what was asked.
struct LoginToggle(CheckMenuItem<tauri::Wry>);
/// Kept so its accelerator can follow the shortcut the user chooses.
struct CaptureItem(MenuItem<tauri::Wry>);
/// The settings as last loaded or saved; every window reads from here.
struct Prefs(Mutex<settings::Settings>);
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
const TOOLS_HEIGHT: f64 = 6.0 + 8.0 * 32.0 + 7.0 * 2.0 + 6.0;
const CROP_TOP: f64 = RAIL_TOP + TOOLS_HEIGHT + 8.0;
/// The least canvas height at which all nine tools on the rail are on screen,
/// with a little air under the crop pane. The window never goes shorter: a tool
/// that has slipped below the edge with no scrollbar is a tool that does not exist.
const RAIL_HEIGHT: f64 = 334.0 + 6.0;
/// Enough for the empty state and a row of recents. Its height is the window's
/// minimum, which the rail sets rather than the empty state; the empty state
/// has room to spare at this size and the footer is not there anyway.
const COMPACT: (f64, f64) = (560.0, CHROME + RAIL_HEIGHT);

/// Size the window to its contents: the capture at actual size where the screen
/// allows, and small when there is nothing to show. A screenshot editor whose
/// window is whatever size it was left at last time is arbitrary twice over --
/// too big for the empty state, the wrong shape for the next capture.
fn fit_window(app: &AppHandle, to: Option<(f64, f64)>) {
    let Some(window) = app.get_webview_window(EDITOR) else { return };
    let (mut width, mut height) = match to {
        Some((w, h)) => (w + SIDES + RAIL, h + CHROME),
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

#[tauri::command]
fn capture_region(app: AppHandle, delay: Option<u32>) -> Result<(), String> {
    let delay = delay.unwrap_or(0).min(60);
    let handle = app.clone();
    app.run_on_main_thread(move || begin_selection(&handle, delay)).map_err(|e| e.to_string())
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
        take_selection(&handle, rect, delay);
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
fn begin_selection(app: &AppHandle, delay: u32) {
    if !ready_to_capture(app) { return; }
    if let Err(error) = open_selectors(app, delay) {
        close_selectors(app);
        app.state::<State>().lock().unwrap().busy = false;
        report(app, format!("The selection overlay couldn't open ({error})."));
    }
}

fn open_selectors(app: &AppHandle, delay: u32) -> Result<(), String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if monitors.is_empty() { return Err("no display was found".into()); }
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
            // The overlay reports its selection in global points, so it needs to
            // know where on the desktop this display starts.
            .initialization_script(format!(
                "window.__MARK_DISPLAY__={{x:{},y:{},width:{},height:{},scale:{}}};window.__MARK_DELAY__={};",
                origin.x, origin.y, size.width, size.height, scale, delay))
            .build().map_err(|e| e.to_string())?;
        if let Ok(handle) = window.ns_window() { macos::raise_overlay(handle); }
        window.show().map_err(|e| e.to_string())?;
    }
    macos::activate_self();
    if let Some(first) = app.get_webview_window(&format!("{SELECTOR}0")) { let _ = first.set_focus(); }
    Ok(())
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
    app.run_on_main_thread(move || take_selection(&handle, rect, delay)).map_err(|e| e.to_string())
}

fn take_selection(app: &AppHandle, rect: capture::Rect, delay: u32) {
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
            Path::new("/usr/sbin/screencapture"), &std::env::temp_dir(), &cancelled, Some(rect));
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let mut wanted: Option<(f64, f64)> = None;
            let show = {
                let state = handle.state::<State>();
                let mut session = state.lock().unwrap();
                session.busy = false; session.capturing = false;
                if session.quitting { drop(session); handle.exit(0); return; }
                match result {
                    Ok(Some(mut capture)) => {
                        // Pixels divided by the points asked for: exactly the
                        // density of the display it came off.
                        if rect.width >= 1.0 { capture.scale = f64::from(capture.width) / rect.width; }
                        wanted = Some((rect.width, rect.height));
                        session.capture = Some(capture);
                        true
                    }
                    Ok(None) => session.editor_was_visible,
                    Err(error) => { session.error = Some(error); true }
                }
            };
            changed(&handle);
            // Resize before showing, so the window arrives at its size rather
            // than being seen to grow into it.
            if wanted.is_some() { fit_window(&handle, wanted); }
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
            (session.editor_was_visible, session.previous_pid)
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

/// The editor sends a flattened PNG only when something was drawn; an untouched
/// capture still takes the copy_and_close path and keeps its original bytes.
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
fn dismiss_editor(app: AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let mut session = state.lock().unwrap();
    if session.busy { return Err("Press Escape to cancel the selection first.".into()); }
    if let Some(window) = app.get_webview_window(EDITOR) { window.hide().map_err(|e| e.to_string())?; }
    session.capture = None; session.error = None;
    let previous = session.previous_pid.take();
    drop(session);
    // Back to the empty state, so back to the small window.
    fit_window(&app, None);
    changed(&app); macos::restore_focus(previous);
    Ok(())
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
fn decode_png(png: &str) -> Result<Vec<u8>, String> {
    if png.len() > 128 * 1024 * 1024 { return Err("That image is too large.".into()); }
    let bytes = STANDARD.decode(png.as_bytes()).map_err(|_| "The edited screenshot couldn't be read.")?;
    capture::validate_png(&bytes)?;
    Ok(bytes)
}

/// An accessory app has no menu bar, so Command-Q never reaches a menu. The
/// editor forwards it here instead.
#[tauri::command]
fn quit_app(app: AppHandle) { app.exit(0); }

#[tauri::command]
fn open_screen_settings() -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The macOS materials the window can sit on, by the names tauri.conf.json
/// uses. They differ a great deal in how much of the desktop they pass, and
/// the only way to choose is to look, so the editor can switch between them
/// live rather than one rebuild at a time.
pub const MATERIALS: &[&str] = &[
    "sidebar", "fullScreenUI", "popover", "menu", "hudWindow", "light", "mediumLight",
    "titlebar", "headerView", "underWindowBackground", "windowBackground",
];

// light and mediumLight are the original vibrancy materials, deprecated in
// favour of the semantic ones but still drawn, and they pass more of the
// desktop than most of their replacements -- which is the point of trying them.
#[allow(deprecated)]
fn material(name: &str) -> Option<tauri::window::Effect> {
    use tauri::window::Effect;
    Some(match name {
        "sidebar" => Effect::Sidebar, "fullScreenUI" => Effect::FullScreenUI, "popover" => Effect::Popover,
        "menu" => Effect::Menu, "hudWindow" => Effect::HudWindow, "light" => Effect::Light,
        "mediumLight" => Effect::MediumLight, "titlebar" => Effect::Titlebar, "headerView" => Effect::HeaderView,
        "underWindowBackground" => Effect::UnderWindowBackground, "windowBackground" => Effect::WindowBackground,
        _ => return None,
    })
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

/// Put the editor window on a different material. Returns the name applied.
#[tauri::command]
fn set_material(app: AppHandle, name: String) -> Result<String, String> {
    let effect = material(&name).ok_or_else(|| format!("No material called {name}."))?;
    let window = app.get_webview_window(EDITOR).ok_or("The editor window isn't available.")?;
    let effects = tauri::window::EffectsBuilder::new().effect(effect)
        .state(tauri::window::EffectState::Active).radius(12.0).build();
    window.set_effects(effects).map_err(|e| e.to_string())?;
    Ok(name)
}

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

/// Replace whichever shortcut is registered with this one. If the new one
/// cannot be taken, the old one is put back, so a failed change never leaves
/// Mark with no shortcut at all.
fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let parsed = Shortcut::from_str(shortcut).map_err(|e| e.to_string())?;
    let previous = app.try_state::<Prefs>().map(|p| p.0.lock().unwrap().shortcut.clone());
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    if let Err(error) = app.global_shortcut().register(parsed) {
        if let Some(old) = previous.and_then(|old| Shortcut::from_str(&old).ok()) { let _ = app.global_shortcut().register(old); }
        return Err(error.to_string());
    }
    Ok(())
}

/// Dark and light are the window's own; system hands the choice back to macOS.
/// The material and the glass follow the window, and the web view's
/// prefers-color-scheme follows the material, so one call themes everything.
fn apply_appearance(app: &AppHandle, appearance: &str) {
    let theme = match appearance { "dark" => Some(tauri::Theme::Dark), "light" => Some(tauri::Theme::Light), _ => None };
    for label in [EDITOR, SETTINGS] {
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

#[tauri::command]
fn set_shortcut(app: AppHandle, shortcut: String) -> Result<settings::Settings, String> {
    register_shortcut(&app, &shortcut).map_err(|error| {
        if error.contains("already") || error.contains("in use") { "Something else on this Mac already uses that shortcut.".to_string() } else { error }
    })?;
    let state = app.state::<Prefs>();
    let updated = { let mut prefs = state.0.lock().unwrap(); prefs.shortcut = shortcut; prefs.clone() };
    settings::save(&app, &updated)?;
    let _ = app.state::<CaptureItem>().0.set_accelerator(Some(updated.shortcut.as_str()));
    if let Some(tray) = app.tray_by_id("mark") { let _ = tray.set_tooltip(Some(tooltip(&updated.shortcut))); }
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
        None => {
            let appearance = app.state::<Prefs>().0.lock().unwrap().appearance.clone();
            let theme = match appearance.as_str() { "dark" => Some(tauri::Theme::Dark), "light" => Some(tauri::Theme::Light), _ => None };
            tauri::WebviewWindowBuilder::new(&app, SETTINGS, tauri::WebviewUrl::App("settings.html".into()))
                .title("Mark Settings").inner_size(460.0, 244.0).resizable(false).maximizable(false).minimizable(false)
                .transparent(true).theme(theme)
                .effects(tauri::window::EffectsBuilder::new().effect(tauri::window::Effect::Sidebar)
                    .state(tauri::window::EffectState::Active).radius(12.0).build())
                .center().build().map_err(|e| e.to_string())?
        }
    };
    macos::activate_self();
    window.show().and_then(|_| window.set_focus()).map_err(|e| e.to_string())
}

fn menu_action(app: &AppHandle, id: &str) {
    match id {
        "capture" => { if let Err(e) = capture_region(app.clone(), None) { report(app, e); } }
        "show" => present(app),
        "copy" => { if let Err(e) = copy_capture(app.clone(), true) { report(app, e); } }
        "close" => { let _ = dismiss_editor(app.clone()); }
        "login" => toggle_login_item(app),
        "settings" => { if let Err(e) = open_settings(app.clone()) { report(app, e); } }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Session::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state() == ShortcutState::Pressed {
                if let Err(e) = capture_region(app.clone(), None) { report(app, e); }
            }
        }).build())
        .invoke_handler(tauri::generate_handler![current_capture, capture_region, capture_display, capture_rect, cancel_selection,
            copy_capture, copy_edited, save_image, share_image, dismiss_editor, open_screen_settings, set_material, glass_available, set_glass,
            get_settings, set_appearance, set_shortcut, login_enabled, set_login, open_settings, quit_app])
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
            let capture = MenuItem::with_id(app, "capture", "Capture Region", true, Some(prefs.shortcut.as_str()))?;
            let show = MenuItem::with_id(app, "show", "Show Editor", true, None::<&str>)?;
            let preferences = MenuItem::with_id(app, "settings", "Settings…", true, Some("Super+Comma"))?;
            let quit = MenuItem::with_id(app, "quit", "Quit Mark", true, Some("Super+Q"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let login = CheckMenuItem::with_id(app, "login", "Open at Login", true,
                macos::login_item_status() == macos::LOGIN_ENABLED, None::<&str>)?;
            app.manage(LoginToggle(login.clone()));
            app.manage(CaptureItem(capture.clone()));
            let tray_menu = Menu::with_items(app, &[&capture, &show, &separator, &login, &preferences, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::with_id("mark")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true).tooltip(tooltip(&prefs.shortcut))
                .menu(&tray_menu).build(app)?;
            let copy = MenuItem::with_id(app, "copy", "Copy and Close", true, Some("Super+C"))?;
            let close = MenuItem::with_id(app, "close", "Close", true, Some("Super+W"))?;
            let main = Submenu::with_items(app, "Mark", true, &[&capture, &show, &separator, &login, &preferences, &separator, &quit])?;
            let edit = Submenu::with_items(app, "Edit", true, &[&copy, &close])?;
            app.set_menu(Menu::with_items(app, &[&main, &edit])?)?;
            install_glass(app.handle());
            apply_appearance(app.handle(), &prefs.appearance);
            if let Err(error) = register_shortcut(app.handle(), &prefs.shortcut) {
                report(app.handle(), format!("The capture shortcut is unavailable ({error}). Use Capture Region in Mark's menu."));
            }
            app.manage(Prefs(Mutex::new(prefs)));
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
            if !at_login { present(app.handle()); }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build Mark")
        .run(|app, event| {
            // Opening a menu bar app that is already running has to show
            // something. Without this the editor stays hidden and re-opening
            // Mark looks exactly like a launch that failed.
            if let tauri::RunEvent::Reopen { .. } = event { present(app); }
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
    use super::{pretty_shortcut, safe_name};

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
