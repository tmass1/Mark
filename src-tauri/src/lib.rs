mod capture;
mod macos;
mod session;

use session::{Session, Snapshot, State};
use std::{path::Path, sync::{Mutex, atomic::Ordering}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, menu::{Menu, MenuItem, PredefinedMenuItem, Submenu}, tray::TrayIconBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const EDITOR: &str = "editor";

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
fn capture_region(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || begin_capture(&handle)).map_err(|e| e.to_string())
}

fn begin_capture(app: &AppHandle) {
    {
        let state = app.state::<State>();
        let mut session = state.lock().unwrap();
        if !session.begin_capture() { return; }
        if let Some(pid) = macos::frontmost_pid().filter(|pid| *pid != std::process::id() as i32) {
            session.previous_pid = Some(pid);
        }
    }
    if !macos::screen_access() {
        app.state::<State>().lock().unwrap().busy = false;
        report(app, "Allow Mark's screen access in System Settings, then try Capture Region again. macOS may ask you to quit and reopen Mark.".into());
        return;
    }
    changed(app);
    let was_visible = app.get_webview_window(EDITOR).is_some_and(|w| w.is_visible().unwrap_or(false));
    if let Some(window) = app.get_webview_window(EDITOR) { let _ = window.hide(); }
    macos::restore_focus(app.state::<State>().lock().unwrap().previous_pid);
    let cancelled = app.state::<State>().lock().unwrap().cancelled.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(180));
        let result = capture::run_capture_cancellable(Path::new("/usr/sbin/screencapture"), &std::env::temp_dir(), &cancelled);
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let show = {
                let state = handle.state::<State>();
                let mut session = state.lock().unwrap();
                session.busy = false;
                if session.quitting { drop(session); handle.exit(0); return; }
                match result {
                    Ok(Some(capture)) => { session.capture = Some(capture); true }
                    Ok(None) => was_visible,
                    Err(error) => { session.error = Some(error); true }
                }
            };
            changed(&handle);
            if show { present(&handle); }
        }) { eprintln!("[Mark] {error}"); }
    });
}

#[tauri::command]
fn copy_and_close(app: AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let session = state.lock().unwrap();
    if session.busy { return Err("Finish selecting the region first.".into()); }
    let capture = session.capture.as_ref().ok_or("There is no screenshot to copy.")?;
    macos::copy_png(&capture.png)?;
    drop(session);
    dismiss_editor(app)
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

#[tauri::command]
fn open_screen_settings() -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn menu_action(app: &AppHandle, id: &str) {
    match id {
        "capture" => { if let Err(e) = capture_region(app.clone()) { report(app, e); } }
        "show" => present(app),
        "copy" => { if let Err(e) = copy_and_close(app.clone()) { report(app, e); } }
        "close" => { let _ = dismiss_editor(app.clone()); }
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
                if let Err(e) = capture_region(app.clone()) { report(app, e); }
            }
        }).build())
        .invoke_handler(tauri::generate_handler![current_capture, capture_region, copy_and_close, dismiss_editor, open_screen_settings])
        .on_menu_event(|app, event| menu_action(app, event.id.as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
            let tray_menu = Menu::with_items(app, &[&capture, &show, &separator, &quit])?;
            TrayIconBuilder::with_id("mark")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true).tooltip("Mark — Capture Region (⌃⌥⌘4)")
                .menu(&tray_menu).build(app)?;
            let copy = MenuItem::with_id(app, "copy", "Copy and Close", true, Some("Super+C"))?;
            let close = MenuItem::with_id(app, "close", "Close", true, Some("Super+W"))?;
            let main = Submenu::with_items(app, "Mark", true, &[&capture, &show, &separator, &quit])?;
            let edit = Submenu::with_items(app, "Edit", true, &[&copy, &close])?;
            app.set_menu(Menu::with_items(app, &[&main, &edit])?)?;
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER), Code::Digit4);
            if let Err(error) = app.global_shortcut().register(shortcut) {
                report(app.handle(), format!("The capture shortcut is unavailable ({error}). Use Capture Region in Mark's menu."));
            }
            // Launching Mark must show something. A tray-only start looks like a
            // failed launch, so open the editor on its empty state, which names the
            // shortcut. Escape or Command-W sends it back to the tray.
            present(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build Mark")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<State>();
                let mut session = state.lock().unwrap();
                if session.busy {
                    api.prevent_exit();
                    session.quitting = true;
                    session.cancelled.store(true, Ordering::SeqCst);
                }
            }
        });
}
