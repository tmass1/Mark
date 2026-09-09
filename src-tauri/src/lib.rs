mod capture;
mod macos;
mod session;

use base64::{engine::general_purpose::STANDARD, Engine};
use session::{Session, Snapshot, State};
use std::{path::Path, sync::{Mutex, atomic::Ordering}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu}, tray::TrayIconBuilder};

/// Kept so the tick can be corrected when macOS disagrees with what was asked.
struct LoginToggle(CheckMenuItem<tauri::Wry>);
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const EDITOR: &str = "editor";
/// One overlay window per display, labelled selector-0, selector-1, and so on.
const SELECTOR: &str = "selector-";

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
            let show = {
                let state = handle.state::<State>();
                let mut session = state.lock().unwrap();
                session.busy = false; session.capturing = false;
                if session.quitting { drop(session); handle.exit(0); return; }
                match result {
                    Ok(Some(capture)) => { session.capture = Some(capture); true }
                    Ok(None) => session.editor_was_visible,
                    Err(error) => { session.error = Some(error); true }
                }
            };
            changed(&handle);
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
    changed(&app); macos::restore_focus(previous);
    Ok(())
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

fn menu_action(app: &AppHandle, id: &str) {
    match id {
        "capture" => { if let Err(e) = capture_region(app.clone(), None) { report(app, e); } }
        "show" => present(app),
        "copy" => { if let Err(e) = copy_capture(app.clone(), true) { report(app, e); } }
        "close" => { let _ = dismiss_editor(app.clone()); }
        "login" => toggle_login_item(app),
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Session::default()))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
            if event.state() == ShortcutState::Pressed {
                if let Err(e) = capture_region(app.clone(), None) { report(app, e); }
            }
        }).build())
        .invoke_handler(tauri::generate_handler![current_capture, capture_region, capture_display, capture_rect, cancel_selection,
            copy_capture, copy_edited, dismiss_editor, open_screen_settings, quit_app])
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
            let capture = MenuItem::with_id(app, "capture", "Capture Region", true, Some("Ctrl+Alt+Super+4"))?;
            let show = MenuItem::with_id(app, "show", "Show Editor", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Mark", true, Some("Super+Q"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let login = CheckMenuItem::with_id(app, "login", "Open at Login", true,
                macos::login_item_status() == macos::LOGIN_ENABLED, None::<&str>)?;
            app.manage(LoginToggle(login.clone()));
            let tray_menu = Menu::with_items(app, &[&capture, &show, &separator, &login, &separator, &quit])?;
            TrayIconBuilder::with_id("mark")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true).tooltip("Mark — Capture Region (⌃⌥⌘4)")
                .menu(&tray_menu).build(app)?;
            let copy = MenuItem::with_id(app, "copy", "Copy and Close", true, Some("Super+C"))?;
            let close = MenuItem::with_id(app, "close", "Close", true, Some("Super+W"))?;
            let main = Submenu::with_items(app, "Mark", true, &[&capture, &show, &separator, &login, &separator, &quit])?;
            let edit = Submenu::with_items(app, "Edit", true, &[&copy, &close])?;
            app.set_menu(Menu::with_items(app, &[&main, &edit])?)?;
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER), Code::Digit4);
            if let Err(error) = app.global_shortcut().register(shortcut) {
                report(app.handle(), format!("The capture shortcut is unavailable ({error}). Use Capture Region in Mark's menu."));
            }
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
