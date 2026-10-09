//! The floating thumbnail. When Settings ask for it, a capture taken from
//! another app is copied and waits in the corner of the screen it came from,
//! as macOS's own screenshot thumbnail does: to be clicked open in the editor,
//! dragged into another app as a file, swiped away, or left to go by itself.
//!
//! It is a panel that never activates Mark and never becomes key, so clicking
//! or dragging it leaves the app being worked in exactly as it was -- and,
//! being a panel, it shows over a full-screen app as well.

use crate::{capture, macos, session::State, EDITOR};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelLevel, WebviewWindowExt};

pub const LABEL: &str = "thumbnail";
/// The box a thumbnail fits in, in points, keeping the capture's shape.
const BOX: (f64, f64) = (220.0, 150.0);
/// Room round the picture for its shadow, inside the window. The page's
/// stylesheet has the same number; change both.
const MARGIN: f64 = 16.0;
/// From the edge of the work area to the picture, as macOS keeps its own.
const INSET: f64 = 20.0;
/// What the temporary files of drags and shares are called, so files left by
/// a Mark that quit can be found and cleared at the next launch.
pub const DRAG_PREFIX: &str = "Mark-drag-";
const LEFT_BEHIND: [&str; 2] = [DRAG_PREFIX, "Mark-share-"];

mod panel {
    tauri_nspanel::tauri_panel! {
        panel!(MarkThumbnailPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true,
                hides_on_deactivate: false
            }
        })
    }
}

/// Where the window goes, in points, for a capture of this size in points: the
/// picture fitted to the box -- never shown larger than it was taken -- in the
/// bottom right of the work area, and the shadow's room round it.
pub fn frame(work: capture::Rect, width: f64, height: f64) -> capture::Rect {
    let scale = (BOX.0 / width).min(BOX.1 / height).min(1.0);
    let (w, h) = ((width * scale).round().max(24.0), (height * scale).round().max(24.0));
    capture::Rect {
        x: work.x + work.width - INSET - w - MARGIN,
        y: work.y + work.height - INSET - h - MARGIN,
        width: w + 2.0 * MARGIN,
        height: h + 2.0 * MARGIN,
    }
}

/// The work area -- the screen less the menu bar and the Dock -- of the display
/// a point is on, in global points.
fn work_area(app: &AppHandle, x: f64, y: f64) -> Option<capture::Rect> {
    let monitors = app.available_monitors().ok()?;
    let contains = |monitor: &&tauri::Monitor| {
        let scale = monitor.scale_factor();
        let (at, size) = (monitor.position().to_logical::<f64>(scale), monitor.size().to_logical::<f64>(scale));
        x >= at.x && x < at.x + size.width && y >= at.y && y < at.y + size.height
    };
    let monitor = monitors.iter().find(contains).cloned().or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (at, size) = (area.position.to_logical::<f64>(scale), area.size.to_logical::<f64>(scale));
    Some(capture::Rect { x: at.x, y: at.y, width: size.width, height: size.height })
}

/// The thumbnail's window, made the first time it is wanted and kept: a
/// borderless, transparent panel that never becomes key and never activates
/// Mark, above ordinary windows on every Space. Main thread.
fn window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) { return Ok(window); }
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("thumbnail.html".into()))
        .title("Mark thumbnail").inner_size(BOX.0 + 2.0 * MARGIN, BOX.1 + 2.0 * MARGIN)
        .decorations(false).transparent(true).shadow(false).resizable(false).skip_taskbar(true)
        .visible(false).focused(false).accept_first_mouse(true).disable_drag_drop_handler()
        .build().map_err(|e| e.to_string())?;
    let panel = window.to_panel::<panel::MarkThumbnailPanel>().map_err(|e| e.to_string())?;
    // Added to the window's style, never put in its place: replacing a live
    // window's whole style can take the app down.
    panel.add_style_mask(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel).map_err(|e| e.to_string())?;
    panel.set_level(PanelLevel::Status.value());
    panel.set_collection_behavior(
        CollectionBehavior::new().can_join_all_spaces().stationary().full_screen_auxiliary().ignores_cycle().into());
    panel.set_has_shadow(false);
    let handle = app.clone();
    macos::watch_hover(window.ns_window().map_err(|e| e.to_string())?,
                       move |inside| { let _ = handle.emit_to(LABEL, "thumbnail-hover", inside); })?;
    Ok(window)
}

/// Float this capture in the corner of the display it came from, in place of
/// any thumbnail before it. Main thread.
pub fn show(app: &AppHandle, png: Vec<u8>, width: u32, height: u32, scale: f64, from: capture::Rect) -> Result<(), String> {
    let window = window(app)?;
    let area = work_area(app, from.x + from.width / 2.0, from.y + from.height / 2.0)
        .ok_or("No display was found to show the thumbnail on.")?;
    let at = frame(area, f64::from(width) / scale, f64::from(height) / scale);
    let id = app.state::<State>().lock().unwrap().show_thumb(png, width, height);
    window.set_size(tauri::LogicalSize::new(at.width, at.height)).map_err(|e| e.to_string())?;
    window.set_position(tauri::LogicalPosition::new(at.x, at.y)).map_err(|e| e.to_string())?;
    // The page asks for the picture when it hears this; a page still loading
    // asks once it has.
    let _ = app.emit_to(LABEL, "thumbnail-show", id);
    if let Ok(panel) = app.get_webview_panel(LABEL) { panel.show(); }
    Ok(())
}

/// Down and forgotten: the editor has the capture now, or a new one is coming
/// and the thumbnail must not be in it. Main thread.
pub fn put_down(app: &AppHandle) {
    app.state::<State>().lock().unwrap().thumb = None;
    hide(app);
}

fn hide(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(LABEL) { if panel.is_visible() { panel.hide(); } }
}

/// Down, if it is still the one with this number.
fn take(app: &AppHandle, id: u64) -> bool {
    let taken = app.state::<State>().lock().unwrap().take_thumb(id);
    if taken { hide(app); }
    taken
}

/// Clear away drag and share files a Mark left when it quit before the next
/// one replaced them.
pub fn sweep() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if LEFT_BEHIND.iter().any(|prefix| name.to_string_lossy().starts_with(prefix)) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The picture, as the page shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown { id: u64, data_url: String, width: u32, height: u32 }

#[tauri::command]
pub fn thumbnail_image(app: AppHandle) -> Option<Shown> {
    let state = app.state::<State>();
    let session = state.lock().unwrap();
    session.thumb.as_ref().map(|thumb| Shown {
        id: thumb.id, data_url: format!("data:image/png;base64,{}", STANDARD.encode(&thumb.png)),
        width: thumb.width, height: thumb.height,
    })
}

/// Clicked: the editor, on the capture, which it has had all along.
#[tauri::command]
pub fn open_thumbnail(app: AppHandle, id: u64) {
    if take(&app, id) { crate::present(&app); }
}

/// Gone by itself, swiped or closed away, or dropped somewhere: the capture
/// leaves the editor as Copy and Close would take it, to wait in Recent -- if
/// the editor is out of sight. Opened meanwhile, the editor keeps it.
#[tauri::command]
pub fn close_thumbnail(app: AppHandle, id: u64) {
    if !take(&app, id) { return; }
    let editing = app.get_webview_window(EDITOR).is_some_and(|window| window.is_visible().unwrap_or(false));
    if !editing { crate::release_capture(&app); }
}

/// Dragged: the capture, as a file named as Save names one, picked up from
/// where the picture sits in the window -- `x`, `y`, `width` and `height`, in
/// the page's points.
#[tauri::command]
pub fn drag_thumbnail(app: AppHandle, id: u64, name: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if ![x, y, width, height].iter().all(|value| value.is_finite()) || width <= 0.0 || height <= 0.0 {
        return Err("That isn't where the thumbnail is.".into());
    }
    let png = {
        let state = app.state::<State>();
        let session = state.lock().unwrap();
        session.thumb.as_ref().filter(|thumb| thumb.id == id).map(|thumb| thumb.png.clone()).ok_or("That thumbnail has gone.")?
    };
    let directory = tempfile::Builder::new().prefix(DRAG_PREFIX).tempdir()
        .map_err(|e| format!("Nowhere to put the image to drag it ({e})."))?;
    let file = directory.path().join(crate::safe_name(&name));
    std::fs::write(&file, &png).map_err(|e| format!("The image couldn't be prepared ({e})."))?;
    let window = app.get_webview_window(LABEL).ok_or("The thumbnail isn't open.")?;
    let handle = app.clone();
    macos::drag_file(window.ns_window().map_err(|e| e.to_string())?, &file, &png, capture::Rect { x, y, width, height },
                     move |landed| { let _ = handle.emit_to(LABEL, "thumbnail-dropped", landed); })?;
    // Replacing the last drag's directory removes it; this one stays for
    // whatever app it lands in to read.
    app.state::<State>().lock().unwrap().drag_dir = Some(directory);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: capture::Rect = capture::Rect { x: 0.0, y: 25.0, width: 1512.0, height: 870.0 };

    #[test]
    fn a_thumbnail_sits_in_the_bottom_right_of_the_work_area_in_the_capture_s_shape() {
        // A wide capture fills the box's width; the picture ends INSET from
        // the work area's right and bottom, with the shadow's room beyond.
        let at = frame(WORK, 1400.0, 700.0);
        assert_eq!((at.width, at.height), (220.0 + 2.0 * MARGIN, 110.0 + 2.0 * MARGIN));
        assert_eq!(at.x + at.width - MARGIN, WORK.x + WORK.width - INSET);
        assert_eq!(at.y + at.height - MARGIN, WORK.y + WORK.height - INSET);
        // A tall one fills its height.
        let tall = frame(WORK, 400.0, 1200.0);
        assert_eq!((tall.width - 2.0 * MARGIN, tall.height - 2.0 * MARGIN), (50.0, 150.0));
    }

    #[test]
    fn a_small_capture_is_never_blown_up_and_a_sliver_is_still_something_to_grab() {
        let small = frame(WORK, 120.0, 80.0);
        assert_eq!((small.width - 2.0 * MARGIN, small.height - 2.0 * MARGIN), (120.0, 80.0));
        let sliver = frame(WORK, 2000.0, 10.0);
        assert_eq!((sliver.width - 2.0 * MARGIN, sliver.height - 2.0 * MARGIN), (220.0, 24.0));
    }

    #[test]
    fn on_a_second_display_it_goes_to_that_display_s_corner() {
        let left = capture::Rect { x: -1920.0, y: 0.0, width: 1920.0, height: 1055.0 };
        let at = frame(left, 800.0, 600.0);
        assert!(at.x < 0.0 && at.x + at.width <= 0.0);
        assert_eq!(at.x + at.width - MARGIN, -INSET);
    }
}
