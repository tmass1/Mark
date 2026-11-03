//! Screen recordings, end to end. One starts from the overlay as a capture
//! does, runs with a small bar beside what is being recorded to stop it, and
//! ends as a capture: the movie's first frame is the picture, and the movie
//! goes with it, to the editor or the thumbnail. Then what the editor does with
//! one: the frames to trim against, and Copy, Save and Share of all of it or of
//! the part kept.

use crate::{capture, macos, movie, sck, session::{Live, Recorded, State, Stop}, thumbnail};
use crate::settings::{ClickLook, Look, PointerLook};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_nspanel::{CollectionBehavior, ManagerExt, PanelLevel, WebviewWindowExt};
use tauri_plugin_dialog::DialogExt;

pub const BAR: &str = "recording";
pub const OUTLINE: &str = "recording-outline";
/// The count before a delayed screenshot or recording: a panel of the same
/// page, centred on what will be taken, which clicks go straight through.
pub const COUNTDOWN: &str = "recording-countdown";
/// Its window: the disc, 148 across, with room all round for its shadow,
/// most below, where it falls. Mirrors .count in recording.css.
const COUNTDOWN_SIZE: (f64, f64) = (260.0, 260.0);
/// Recordings stop by themselves after this long. Mark is for short ones.
pub const LONGEST: Duration = Duration::from_secs(300);
/// The trim strip under a recording in the editor and the gap above it, kept
/// clear when the window is fitted to it. Mirrors .trim in style.css.
pub const STRIP: f64 = 12.0 + 52.0;
/// The bar's window, its shadow's room included. Mirrors recording.css.
const BAR_SIZE: (f64, f64) = (256.0, 88.0);
/// Between what is recorded and the bar.
const GAP: f64 = 6.0;
/// The outline sits this far outside the area, so it never covers an edge of it.
const OUTSET: f64 = 3.0;
/// How long the movie's file gets to close once the stream has stopped.
const CLOSING: Duration = Duration::from_secs(10);
const GONE: &str = "That recording is no longer kept. Record it again.";

mod panel {
    tauri_nspanel::tauri_panel! {
        panel!(MarkRecordingPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true,
                hides_on_deactivate: false
            }
        })
    }
}

/// Where recordings are kept until Recent lets them go: a folder of Mark's in
/// the caches, which a development build keeps apart from the installed one's.
pub fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(debug_assertions) { "Recordings-dev" } else { "Recordings" };
    app.path().app_cache_dir().map(|dir| dir.join(name)).map_err(|e| e.to_string())
}

/// Recent is gone when Mark quits, so whatever it kept is too.
pub fn sweep(app: &AppHandle) {
    if let Ok(folder) = folder(app) { let _ = std::fs::remove_dir_all(folder); }
}

/// What a recording is called: what Save calls a screenshot, as macOS would.
fn stamp() -> String {
    // SAFETY: localtime_r fills the tm it is given and nothing else.
    let tm = unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        tm
    };
    format!("Mark {:04}-{:02}-{:02} at {:02}.{:02}.{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

/// "0:12", "4:05": how long a recording has run, or runs.
pub fn clock(seconds: u64) -> String { format!("{}:{:02}", seconds / 60, seconds % 60) }

/// Where the bar goes, in global points, for a recording of `area` on a
/// display whose work area is `work`: centred under it; above it if there is
/// no room below; along the inside of its bottom if there is no room either
/// way, as for a whole display. Never off the work area.
pub fn bar_place(area: capture::Rect, work: capture::Rect, size: (f64, f64)) -> (f64, f64) {
    let x = (area.x + (area.width - size.0) / 2.0).clamp(work.x, (work.x + work.width - size.0).max(work.x));
    let below = area.y + area.height + GAP;
    let above = area.y - GAP - size.1;
    let y = if below + size.1 <= work.y + work.height { below }
        else if above >= work.y { above }
        else { (area.y + area.height - GAP - size.1).clamp(work.y, (work.y + work.height - size.1).max(work.y)) };
    (x, y)
}

/// Run on the main thread and wait for the answer. From the main thread itself
/// the work runs at once.
fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (sent, received) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = sent.send(work(&handle)); }).map_err(|e| e.to_string())?;
    received.recv().map_err(|_| "Mark didn't finish that.".to_string())?
}

/// Record `target` from now until something stops it, and hand back what was
/// recorded as a capture: None if it was thrown away, or Mark is quitting. On
/// the capture thread, which it holds for the whole recording.
pub fn record(app: &AppHandle, target: capture::Target, cancelled: &AtomicBool) -> Result<Option<capture::Capture>, String> {
    let (mic, look, zoom) = {
        let prefs = app.state::<crate::Prefs>();
        let prefs = prefs.0.lock().unwrap();
        (prefs.record_mic, prefs.look(), prefs.record_zoom)
    };
    // Asked for here, before anything is on screen, the first time: macOS's
    // own question comes up while the overlay is gone and nothing is recording.
    if mic { movie::microphone()?; }
    if cancelled.load(Ordering::SeqCst) { return Ok(None); }
    let id = app.state::<State>().lock().unwrap().next_video_id();
    let folder = folder(app)?.join(id.to_string());
    std::fs::create_dir_all(&folder).map_err(|e| format!("There's nowhere to keep the recording ({e})."))?;
    let file = folder.join(format!("{}.mp4", stamp()));
    let source = match target {
        capture::Target::Region(rect) => sck::Source::Area(rect),
        capture::Target::Window { id, .. } => sck::Source::Window(id),
    };
    let (events, heard) = mpsc::channel();
    // macOS draws the arrow and its rings into the movie; anything else is
    // Mark's to draw over it, from what it follows here.
    let options = sck::Options { source, mic, clicks: look.rings(), pointer: look.arrow(), output: file.clone() };
    let shape = match sck::start(options, events) {
        Ok(shape) => shape,
        Err(error) => { let _ = std::fs::remove_dir_all(&folder); return Err(error); }
    };
    // Where the pointer goes, from the moment the movie starts, for a halo to
    // follow: in points from the top left of what is recorded.
    let began = Instant::now();
    let mut track = Vec::new();
    // And when the button goes down and comes up, on the same clock. Without
    // them the movie is still a movie, so a failure here only loses them.
    let presses = on_main(app, move |_| Ok(macos::watch_presses(began))).unwrap_or_default();
    let (stop, stopped) = mpsc::channel();
    app.state::<State>().lock().unwrap().recording = Some(Live { stop, mic, started: Some(Instant::now()) });
    let outline = matches!(target, capture::Target::Region(_));
    let area = target.rect();
    let _ = on_main(app, move |app| { show_bar(app, area, outline, mic); crate::recording_menu(app, true); Ok(()) });

    let started = Instant::now();
    let (mut keep, mut ended, mut failed) = (true, false, None);
    let mut shown = None;
    loop {
        if cancelled.load(Ordering::SeqCst) { keep = false; break; }
        match stopped.try_recv() {
            Ok(Stop::Keep) => break,
            Ok(Stop::Discard) => { keep = false; break; }
            Err(_) => {}
        }
        match heard.try_recv() {
            // Stopped from macOS's own menu bar, or what was recorded went:
            // what there is so far is kept.
            Ok(sck::Event::Ended(code, reason)) => {
                if code != sck::USER_STOPPED { eprintln!("[Mark] the recording stream ended ({code}): {reason}"); }
                ended = true; break;
            }
            Ok(sck::Event::Failed(reason)) => { failed = Some(reason); break; }
            _ => {}
        }
        let elapsed = started.elapsed();
        if elapsed >= LONGEST { break; }
        let second = elapsed.as_secs();
        if shown != Some(second) { shown = Some(second); tick(app, second, mic); }
        if let Some((x, y)) = pointer_in(&target) { track.push((began.elapsed().as_secs_f64(), x, y)); }
        // A frame's time at the 30 a second recorded: the pointer is looked
        // for as often as there is a frame for it to be on.
        std::thread::sleep(Duration::from_millis(33));
    }
    app.state::<State>().lock().unwrap().recording = None;
    let _ = on_main(app, |app| {
        macos::unwatch_presses();
        hide_bar(app); crate::recording_menu(app, false); crate::set_tray_title(app, None); Ok(())
    });
    // A press still down as it stopped ends there.
    let end = began.elapsed().as_secs_f64();
    let presses: Vec<(f64, f64)> = presses.lock()
        .map(|noted| noted.iter().map(|&(down, up)| (down, up.unwrap_or(end).max(down))).collect()).unwrap_or_default();

    if !ended && failed.is_none() {
        if let Err(error) = sck::stop() { eprintln!("[Mark] stopping the recording: {error}"); }
    }
    // Only once the file is closed is the movie whole.
    let deadline = Instant::now() + CLOSING;
    while failed.is_none() {
        match heard.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(sck::Event::Finished) => break,
            Ok(sck::Event::Failed(reason)) => failed = Some(reason),
            Ok(_) => continue,
            Err(_) => { eprintln!("[Mark] the recording's file wasn't said to be closed"); break; }
        }
    }
    sck::release();
    if !keep { let _ = std::fs::remove_dir_all(&folder); return Ok(None); }
    let kept = (|| {
        if let Some(reason) = failed { return Err(format!("The recording couldn't be saved ({reason}).")); }
        let info = movie::info(&file)?;
        let poster = movie::poster(&file)?;
        Ok((info, poster))
    })();
    let (info, poster) = match kept {
        Ok(kept) => kept,
        Err(error) => { let _ = std::fs::remove_dir_all(&folder); return Err(error); }
    };
    let scale = if shape.points.0 >= 1.0 { f64::from(info.width) / shape.points.0 } else { 1.0 };
    let video = capture::Video { id, path: file.to_string_lossy().into_owned(), duration: info.duration, sound: info.sound };
    let pointer = track.into_iter().map(|(at, x, y)| (at, x * scale, y * scale)).collect();
    let gone = app.state::<State>().lock().unwrap().keep_video(Recorded {
        id, folder, file, duration: info.duration, pixels: (info.width, info.height), scale, edited: None, pointer, presses, look, zoom,
    });
    for folder in gone { let _ = std::fs::remove_dir_all(folder); }
    Ok(Some(capture::Capture { png: poster, width: info.width, height: info.height, scale, video: Some(video) }))
}

/// Where the pointer is, in points from the top left of what is recorded:
/// the area, or the window wherever it is now. None if either can't be found.
fn pointer_in(target: &capture::Target) -> Option<(f64, f64)> {
    let (x, y) = macos::pointer()?;
    let origin = match target {
        capture::Target::Region(rect) => (rect.x, rect.y),
        capture::Target::Window { id, .. } => {
            let window = macos::windows_on_screen().into_iter().find(|window| window.id == *id)?;
            (window.bounds.x, window.bounds.y)
        }
    };
    Some(relative((x, y), origin))
}

/// A point on screen, from an origin on it.
fn relative(point: (f64, f64), origin: (f64, f64)) -> (f64, f64) { (point.0 - origin.0, point.1 - origin.1) }

/// Another second: in the menu bar, and on the bar.
fn tick(app: &AppHandle, second: u64, mic: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::set_tray_title(&handle, Some(format!(" {}", clock(second))));
        let _ = handle.emit_to(BAR, "recording-tick", Status { elapsed: second, limit: LONGEST.as_secs(), mic });
    });
}

/// End the recording under way, keeping it or not. False if there is none.
pub fn stop(app: &AppHandle, how: Stop) -> bool {
    let state = app.state::<State>();
    let session = state.lock().unwrap();
    session.recording.as_ref().is_some_and(|live| live.stop.send(how).is_ok())
}

/// A panel of Mark's for the recording: borderless, transparent, never key and
/// never activating Mark, above ordinary windows on every Space. Main thread.
fn panel_window(app: &AppHandle, label: &str, page: &str, size: (f64, f64)) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) { return Ok(window); }
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(page.into()))
        .title("Mark recording").inner_size(size.0, size.1)
        .decorations(false).transparent(true).shadow(false).resizable(false).skip_taskbar(true)
        .visible(false).focused(false).accept_first_mouse(true).disable_drag_drop_handler()
        .build().map_err(|e| e.to_string())?;
    let panel = window.to_panel::<panel::MarkRecordingPanel>().map_err(|e| e.to_string())?;
    panel.add_style_mask(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel).map_err(|e| e.to_string())?;
    panel.set_level(PanelLevel::Status.value());
    panel.set_collection_behavior(
        CollectionBehavior::new().can_join_all_spaces().stationary().full_screen_auxiliary().ignores_cycle().into());
    panel.set_has_shadow(false);
    Ok(window)
}

/// The bar beside `area`, and for an area rather than a window, a line round
/// it. Both are Mark's, which the recording leaves out. Main thread.
fn show_bar(app: &AppHandle, area: capture::Rect, outline: bool, mic: bool) {
    let placed = (|| {
        let bar = panel_window(app, BAR, "recording.html", BAR_SIZE)?;
        let work = thumbnail::work_area(app, area.x + area.width / 2.0, area.y + area.height / 2.0)
            .ok_or("No display was found for the recording's bar.")?;
        let (x, y) = bar_place(area, work, BAR_SIZE);
        bar.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        let _ = app.emit_to(BAR, "recording-tick", Status { elapsed: 0, limit: LONGEST.as_secs(), mic });
        if let Ok(panel) = app.get_webview_panel(BAR) { panel.show(); }
        if outline {
            let line = panel_window(app, OUTLINE, "recording.html?outline", (area.width, area.height))?;
            line.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
            line.set_size(tauri::LogicalSize::new(area.width + 2.0 * OUTSET, area.height + 2.0 * OUTSET)).map_err(|e| e.to_string())?;
            line.set_position(tauri::LogicalPosition::new(area.x - OUTSET, area.y - OUTSET)).map_err(|e| e.to_string())?;
            if let Ok(panel) = app.get_webview_panel(OUTLINE) { panel.show(); }
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = placed { eprintln!("[Mark] the recording's bar: {error}"); }
}

/// The countdown's page: when it ends, in milliseconds since 1970 -- the clock
/// the page reads too, so it counts by itself without being told each second
/// -- and whether a recording follows it.
fn countdown_page(until: u128, record: bool) -> String {
    format!("recording.html?countdown&until={until}{}", if record { "&video" } else { "" })
}

/// Count `seconds` down over the middle of `area`, ending as the delay does.
/// The page counts by the clock; this only puts it there. Main thread.
pub fn show_countdown(app: &AppHandle, area: capture::Rect, seconds: u32, record: bool) {
    let shown = (|| {
        let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?;
        let page = countdown_page(since.as_millis() + u128::from(seconds) * 1000, record);
        // Made once and kept: after the first, it is sent to the new count.
        let fresh = app.get_webview_window(COUNTDOWN).is_none();
        let window = panel_window(app, COUNTDOWN, &page, COUNTDOWN_SIZE)?;
        if !fresh { window.eval(format!("location.replace({page:?})")).map_err(|e| e.to_string())?; }
        window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        let work = thumbnail::work_area(app, area.x + area.width / 2.0, area.y + area.height / 2.0).unwrap_or(area);
        let x = (area.x + (area.width - COUNTDOWN_SIZE.0) / 2.0).clamp(work.x, (work.x + work.width - COUNTDOWN_SIZE.0).max(work.x));
        let y = (area.y + (area.height - COUNTDOWN_SIZE.1) / 2.0).clamp(work.y, (work.y + work.height - COUNTDOWN_SIZE.1).max(work.y));
        window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        if let Ok(panel) = app.get_webview_panel(COUNTDOWN) { panel.show(); }
        Ok::<(), String>(())
    })();
    if let Err(error) = shown { eprintln!("[Mark] the countdown: {error}"); }
}

/// The countdown gone, before the shutter. Main thread.
pub fn hide_countdown(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(COUNTDOWN) { if panel.is_visible() { panel.hide(); } }
}

fn hide_bar(app: &AppHandle) {
    for label in [BAR, OUTLINE] {
        if let Ok(panel) = app.get_webview_panel(label) { if panel.is_visible() { panel.hide(); } }
    }
}

/// How long the recording under way has run, what it may run to, and whether
/// it takes in the microphone, for the bar.
#[derive(Clone, Serialize)]
pub struct Status { elapsed: u64, limit: u64, mic: bool }

#[tauri::command]
pub fn recording_status(app: AppHandle) -> Option<Status> {
    let state = app.state::<State>();
    let session = state.lock().unwrap();
    session.recording.as_ref().map(|live| Status {
        elapsed: live.started.map_or(0, |at| at.elapsed().as_secs()), limit: LONGEST.as_secs(), mic: live.mic,
    })
}

#[tauri::command]
pub fn stop_recording(app: AppHandle) -> Result<(), String> {
    if stop(&app, Stop::Keep) { Ok(()) } else { Err("Nothing is recording.".into()) }
}

#[tauri::command]
pub fn discard_recording(app: AppHandle) -> Result<(), String> {
    if stop(&app, Stop::Discard) { Ok(()) } else { Err("Nothing is recording.".into()) }
}

/// Whether this Mac can record: macOS 15 or later.
#[tauri::command]
pub fn recording_supported() -> bool { sck::supported() }

struct Found {
    file: PathBuf, folder: PathBuf, duration: f64, pixels: (u32, u32), scale: f64, edited: Option<(movie::Edit, PathBuf)>,
    pointer: Vec<(f64, f64, f64)>, presses: Vec<(f64, f64)>, look: Look,
}

fn find(app: &AppHandle, id: u64) -> Result<Found, String> {
    let state = app.state::<State>();
    let mut session = state.lock().unwrap();
    let video = session.video(id).ok_or(GONE)?;
    Ok(Found { file: video.file.clone(), folder: video.folder.clone(), duration: video.duration, pixels: video.pixels,
               scale: video.scale, edited: video.edited.clone(), pointer: video.pointer.clone(), presses: video.presses.clone(),
               look: video.look })
}

/// What the editor drew on a recording, as it sends it: a PNG of the marks,
/// base64, for each moment one appears at, the parts to pixelate, the frame
/// it is set in, if it is framed, and where the camera is through each zoom.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Marks {
    #[serde(default)] overlays: Vec<Overlay>,
    #[serde(default)] redactions: Vec<movie::Hidden>,
    #[serde(default)] frame: Option<Framing>,
    #[serde(default)] camera: Vec<(f64, f64, f64, f64)>,
}
#[derive(Clone, Debug, Deserialize)]
struct Overlay { at: f64, png: String }
/// The frame as the editor paints it: a canvas `width` × `height` pixels, the
/// recording's top left at `x`, `y` on it, what lies under it, the screen's
/// shape, and what goes over it, if anything does -- a phone's island -- all
/// PNGs, base64, the canvas's size.
#[derive(Clone, Debug, Deserialize)]
struct Framing { width: u32, height: u32, x: f64, y: f64, under: String, mask: String, #[serde(default)] over: Option<String> }

/// No frame is wider or taller than this: a canvas past it is a mistake.
const LARGEST_CANVAS: u32 = 8192;
/// The camera is followed a thirtieth of a second at a time, through no more
/// than five minutes of zooms, and comes no closer than this.
const MOST_CAMERA: usize = 30 * 600;
const CLOSEST: f64 = 5.0;

/// Far more moments than anyone marks a short recording at.
const MOST_MOMENTS: usize = 200;

/// The marks made ready to draw, with a fingerprint to tell one set from
/// another by: each picture checked to be a whole PNG the recording's size,
/// and every time and area a number. Nothing drawn is None.
fn drawn(marks: Option<Marks>, pixels: (u32, u32)) -> Result<Option<(movie::Drawn, u64)>, String> {
    use std::hash::{Hash, Hasher};
    let Some(marks) = marks else { return Ok(None) };
    if marks.overlays.is_empty() && marks.redactions.is_empty() && marks.frame.is_none() && marks.camera.is_empty() { return Ok(None); }
    if marks.overlays.len() > MOST_MOMENTS || marks.redactions.len() > MOST_MOMENTS {
        return Err("There's too much drawn on the recording to put into it.".into());
    }
    let mut print = std::collections::hash_map::DefaultHasher::new();
    let mut overlays = Vec::with_capacity(marks.overlays.len());
    for overlay in marks.overlays {
        let png = crate::decode_png(&overlay.png)?;
        if capture::validate_png(&png)? != pixels { return Err("What was drawn isn't the recording's size.".into()); }
        if !overlay.at.is_finite() { return Err("A mark's time isn't a time.".into()); }
        overlay.at.to_bits().hash(&mut print);
        png.hash(&mut print);
        overlays.push((overlay.at.max(0.0), png));
    }
    for part in &marks.redactions {
        let numbers = [part.x, part.y, part.width, part.height, part.at, part.block];
        if !numbers.iter().all(|n| n.is_finite()) { return Err("A redaction isn't a place on the recording.".into()); }
        if part.until.is_some_and(|until| !until.is_finite() || until <= part.at) {
            return Err("A redaction has to go after it starts.".into());
        }
        for n in numbers { n.to_bits().hash(&mut print); }
        part.until.map(f64::to_bits).hash(&mut print);
    }
    let frame = marks.frame.map(|framing| framed(framing, pixels)).transpose()?;
    if let Some(plates) = &frame {
        (plates.size, plates.at.0.to_bits(), plates.at.1.to_bits(), &plates.under, &plates.mask, &plates.over).hash(&mut print);
    }
    let camera = followed(marks.camera)?;
    for sample in camera.iter().flatten() { [sample.0, sample.1, sample.2, sample.3].map(f64::to_bits).hash(&mut print); }
    Ok(Some((movie::Drawn { overlays, redactions: marks.redactions, pointer: None, frame, camera }, print.finish())))
}

/// The camera's track made ready to follow: numbers, in order of time, no
/// closer than CLOSEST and no further than the whole picture. None if empty.
fn followed(track: Vec<(f64, f64, f64, f64)>) -> Result<Option<Vec<(f64, f64, f64, f64)>>, String> {
    if track.is_empty() { return Ok(None); }
    if track.len() > MOST_CAMERA { return Err("There's too much zooming to put into the recording.".into()); }
    let sound = track.iter().all(|&(at, x, y, scale)| [at, x, y, scale].iter().all(|n| n.is_finite()) && (1.0..=CLOSEST).contains(&scale))
        && track.windows(2).all(|pair| pair[0].0 <= pair[1].0);
    if !sound { return Err("A zoom isn't one the recording can take.".into()); }
    Ok(Some(track))
}

/// The frame made ready to draw: both pictures whole PNGs the canvas's size,
/// and the recording wholly on the canvas.
fn framed(framing: Framing, pixels: (u32, u32)) -> Result<movie::Plates, String> {
    let size = (framing.width, framing.height);
    if size.0 > LARGEST_CANVAS || size.1 > LARGEST_CANVAS { return Err("The frame is too large to make.".into()); }
    let fits = framing.x.is_finite() && framing.y.is_finite() && framing.x >= 0.0 && framing.y >= 0.0
        && framing.x + f64::from(pixels.0) <= f64::from(size.0) && framing.y + f64::from(pixels.1) <= f64::from(size.1);
    if !fits { return Err("The recording isn't inside its frame.".into()); }
    let (under, mask) = (crate::decode_png(&framing.under)?, crate::decode_png(&framing.mask)?);
    let over = framing.over.as_deref().map(crate::decode_png).transpose()?;
    for png in [Some(&under), Some(&mask), over.as_ref()].into_iter().flatten() {
        if capture::validate_png(png)? != size { return Err("The frame isn't the size it says.".into()); }
    }
    Ok(movie::Plates { size, at: (framing.x, framing.y), under, mask, over })
}

/// The movie to hand on for recording `id`: all of it as it was made, or the
/// part between `start` and `end`, with what was drawn on it drawn in -- made
/// once for each such copy, and kept beside the movie, under the same name,
/// until another replaces it.
#[allow(clippy::too_many_arguments)]
fn movie_for(app: &AppHandle, id: u64, start: f64, end: f64, cuts: &[(f64, f64)], speed: f64, look: Option<Look>, marks: Option<Marks>)
    -> Result<PathBuf, String> {
    let found = find(app, id)?;
    let timeline = movie::Timeline::new(start, end, cuts, speed, found.duration)?;
    let drawn = with_pointer(drawn(marks, found.pixels)?, look, &found);
    if timeline.is_none() && drawn.is_none() { return Ok(found.file); }
    let edit = movie::Edit { timeline: timeline.clone(), marks: drawn.as_ref().map(|(_, print)| *print) };
    if let Some((made, path)) = found.edited { if made == edit && path.exists() { return Ok(path); } }
    let out = found.folder.join("Edited").join(found.file.file_name().ok_or(GONE)?);
    std::fs::create_dir_all(out.parent().ok_or(GONE)?).map_err(|e| e.to_string())?;
    movie::export(&found.file, timeline.as_ref(), drawn.as_ref().map(|(drawn, _)| drawn), &out)?;
    if let Some(video) = app.state::<State>().lock().unwrap().video(id) { video.edited = Some((edit, out.clone())); }
    Ok(out)
}

/// How far the pointer's halo reaches, the fingertip's radius, and a ripple's
/// at its widest, in points. The editor draws them the same.
const HALO: f64 = 28.0;
const TOUCH: f64 = 20.0;
const RIPPLE: f64 = 30.0;

/// What Mark draws of the pointer, as `look` asks, or as the recording was
/// made: only what the movie can take. A halo needs the arrow macOS put into
/// it, a fingertip needs the movie without one, and a ripple without macOS's
/// rings. None where nothing is drawn.
fn pointing(look: Option<Look>, found: &Found) -> Option<movie::Pointer> {
    let look = look.unwrap_or(found.look);
    let shape = match look.pointer {
        PointerLook::Halo if found.look.arrow() => Some(movie::Shape::Halo(HALO * found.scale)),
        PointerLook::Touch if !found.look.arrow() => Some(movie::Shape::Touch(TOUCH * found.scale)),
        _ => None,
    };
    let ripple = (look.clicks == ClickLook::Ripple && !found.look.rings() && !found.presses.is_empty())
        .then_some(RIPPLE * found.scale);
    if found.pointer.is_empty() || (shape.is_none() && ripple.is_none()) { return None; }
    Some(movie::Pointer { track: found.pointer.clone(), presses: found.presses.clone(), shape, ripple })
}

/// What is drawn on a recording, and what Mark draws of the pointer, told
/// apart by the fingerprint.
fn with_pointer(drawn: Option<(movie::Drawn, u64)>, look: Option<Look>, found: &Found) -> Option<(movie::Drawn, u64)> {
    use std::hash::{Hash, Hasher};
    let Some(pointer) = pointing(look, found) else { return drawn };
    let (mut drawn, print) = drawn.unwrap_or_default();
    let mut drew = std::collections::hash_map::DefaultHasher::new();
    (pointer.shape.map(|shape| matches!(shape, movie::Shape::Touch(_))), pointer.ripple.is_some()).hash(&mut drew);
    drawn.pointer = Some(pointer);
    Some((drawn, print ^ drew.finish()))
}

/// Where the pointer went through a recording, in its pixels, and when the
/// button went down and up, for the editor to draw over the movie -- how the
/// pointer and clicks were shown as it was made, and whether it was made to
/// zoom in on its clicks.
#[derive(Serialize)]
pub struct Followed { track: Vec<(f64, f64, f64)>, presses: Vec<(f64, f64)>, look: Look, zoom: bool }

#[tauri::command]
pub fn video_pointer(app: AppHandle, id: u64) -> Result<Followed, String> {
    let state = app.state::<State>();
    let mut session = state.lock().unwrap();
    let video = session.video(id).ok_or(GONE)?;
    Ok(Followed { track: video.pointer.clone(), presses: video.presses.clone(), look: video.look, zoom: video.zoom })
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Small frames from through the recording, for the editor's trim strip.
#[tauri::command]
pub async fn video_frames(app: AppHandle, id: u64, count: usize) -> Result<Vec<String>, String> {
    let found = find(&app, id)?;
    let count = count.clamp(1, 24);
    let frames = blocking(move || movie::frames(&found.file, found.duration, count, 72.0)).await?;
    Ok(frames.iter().map(|jpeg| format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg))).collect())
}

/// Copy: the movie, or the part kept, with what was drawn on it, on the
/// clipboard as a file. Closing is the caller's choice, as for a screenshot.
#[tauri::command]
pub async fn copy_video(app: AppHandle, id: u64, start: f64, end: f64, cuts: Option<Vec<(f64, f64)>>, speed: Option<f64>,
                        look: Option<Look>, close: bool, marks: Option<Marks>) -> Result<(), String> {
    if app.state::<State>().lock().unwrap().busy { return Err("Finish the capture under way first.".into()); }
    let handle = app.clone();
    let movie = blocking(move || movie_for(&handle, id, start, end, &cuts.unwrap_or_default(), speed.unwrap_or(1.0), look, marks)).await?;
    on_main(&app, move |app| {
        macos::copy_file(&movie)?;
        if close { crate::put_away(app, None) } else { Ok(()) }
    })
}

/// What Save made: the name it was saved under, and how big it came out.
#[derive(Serialize)]
pub struct Saved { name: String, bytes: u64 }

/// Save: the movie, or the part kept, with what was drawn on it, as an MP4 --
/// or as a GIF that loops, full size or small. None if Save was cancelled.
#[tauri::command]
pub async fn save_video(app: AppHandle, id: u64, start: f64, end: f64, cuts: Option<Vec<(f64, f64)>>, speed: Option<f64>,
                        look: Option<Look>, gif: bool, small: Option<bool>, name: String, marks: Option<Marks>)
    -> Result<Option<Saved>, String> {
    let found = find(&app, id)?;
    let (extension, kind) = if gif { ("gif", "GIF image") } else { ("mp4", "MPEG-4 movie") };
    let chosen = app.dialog().file().add_filter(kind, &[extension]).set_file_name(crate::safe_name(&name, extension)).blocking_save_file();
    let Some(chosen) = chosen else { return Ok(None) };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    let target = path.clone();
    let handle = app.clone();
    let (cuts, speed) = (cuts.unwrap_or_default(), speed.unwrap_or(1.0));
    let bytes = blocking(move || {
        if gif {
            make_gif(&found, start, end, &cuts, speed, look, small.unwrap_or(false), marks, &target)
        } else {
            let movie = movie_for(&handle, id, start, end, &cuts, speed, look, marks)?;
            std::fs::copy(&movie, &target).map_err(|e| format!("The recording couldn't be saved ({e})."))
        }
    }).await?;
    Ok(Some(Saved { name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), bytes }))
}

/// A GIF of what is kept, with what was drawn on it, written to `out`: its size in bytes.
#[allow(clippy::too_many_arguments)]
fn make_gif(found: &Found, start: f64, end: f64, cuts: &[(f64, f64)], speed: f64, look: Option<Look>, small: bool, marks: Option<Marks>,
            out: &std::path::Path) -> Result<u64, String> {
    let timeline = movie::Timeline::new(start, end, cuts, speed, found.duration)?.unwrap_or_else(|| movie::Timeline::whole(found.duration));
    let drawn = with_pointer(drawn(marks, found.pixels)?, look, found);
    let drawn = drawn.as_ref().map(|(drawn, _)| drawn);
    // Framed, the GIF is the canvas's shape, not the recording's.
    movie::gif(&found.file, &movie::gif_plan(&timeline, movie::output_size(drawn, found.pixels), found.scale, small), drawn, out)
}

/// Copy as GIF: what is kept, with what was drawn on it, as a GIF that loops,
/// on the clipboard as a file and as the GIF itself. Its size in bytes.
#[tauri::command]
pub async fn copy_gif(app: AppHandle, id: u64, start: f64, end: f64, cuts: Option<Vec<(f64, f64)>>, speed: Option<f64>,
                      look: Option<Look>, small: Option<bool>, name: String, marks: Option<Marks>) -> Result<u64, String> {
    if app.state::<State>().lock().unwrap().busy { return Err("Finish the capture under way first.".into()); }
    let found = find(&app, id)?;
    let out = found.folder.join("Edited").join(crate::safe_name(&name, "gif"));
    let target = out.clone();
    let bytes = blocking(move || {
        std::fs::create_dir_all(target.parent().ok_or(GONE)?).map_err(|e| e.to_string())?;
        make_gif(&found, start, end, &cuts.unwrap_or_default(), speed.unwrap_or(1.0), look, small.unwrap_or(false), marks, &target)
    }).await?;
    on_main(&app, move |_| macos::copy_gif(&out))?;
    Ok(bytes)
}

/// Share: the movie, or the part kept, with what was drawn on it, to macOS's
/// share sheet.
#[tauri::command]
pub async fn share_video(app: AppHandle, id: u64, start: f64, end: f64, cuts: Option<Vec<(f64, f64)>>, speed: Option<f64>,
                         look: Option<Look>, marks: Option<Marks>) -> Result<(), String> {
    let handle = app.clone();
    let movie = blocking(move || {
        movie_for(&handle, id, start, end, &cuts.unwrap_or_default(), speed.unwrap_or(1.0), look, marks)
    }).await?;
    on_main(&app, move |app| {
        let window = app.get_webview_window(crate::EDITOR).ok_or("Mark's editor isn't open.")?;
        macos::share_file(window.ns_window().map_err(|e| e.to_string())?, &movie)
    })
}

/// A build for proving recording end to end, which no one need watch. With
/// MARK_SELFTEST_RECORD set to "x,y,width,height" in global points -- or to
/// "window", for the frontmost window -- it records that for three seconds,
/// with the microphone if MARK_SELFTEST_MIC is set, and with the editor laid
/// over it, which being Mark's must not be in the movie. Then it writes the
/// movie, its poster and strip, a trim and a GIF into MARK_SELFTEST_OUT, says
/// what AVFoundation reads back from each, and quits.
#[cfg(feature = "record-selftest")]
pub fn selftest(app: AppHandle) {
    let Ok(asked) = std::env::var("MARK_SELFTEST_RECORD") else { return };
    let out = std::env::var("MARK_SELFTEST_OUT").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    if std::env::var("MARK_SELFTEST_MIC").is_ok() { app.state::<crate::Prefs>().0.lock().unwrap().record_mic = true; }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let target = if asked == "window" {
            match capture::capturable(macos::windows_on_screen(), std::process::id() as i32).into_iter().next() {
                Some(window) => capture::Target::Window { id: window.id, bounds: window.bounds() },
                None => { eprintln!("[Mark] selftest: no window to record"); app.exit(1); return; }
            }
        } else {
            let n: Vec<f64> = asked.split(',').filter_map(|part| part.trim().parse().ok()).collect();
            if n.len() != 4 { eprintln!("[Mark] selftest: MARK_SELFTEST_RECORD should be x,y,width,height"); app.exit(1); return; }
            capture::Target::Region(capture::Rect { x: n[0], y: n[1], width: n[2], height: n[3] })
        };
        let area = target.rect();
        let _ = on_main(&app, move |app| {
            if let Some(editor) = app.get_webview_window(crate::EDITOR) {
                let _ = editor.set_position(tauri::LogicalPosition::new(area.x + 20.0, area.y + 20.0));
                let _ = editor.show();
            }
            Ok(())
        });
        // Three seconds from when it is recording, not from now: macOS may
        // first ask about the microphone, and wait for an answer.
        let stopper = app.clone();
        std::thread::spawn(move || {
            while stopper.state::<State>().lock().unwrap().recording.is_none() { std::thread::sleep(Duration::from_millis(50)); }
            std::thread::sleep(Duration::from_secs(3));
            eprintln!("[Mark] selftest: stop sent: {}", stop(&stopper, Stop::Keep));
        });
        let began = Instant::now();
        let result = record(&app, target, &AtomicBool::new(false));
        eprintln!("[Mark] selftest: recorded {target:?} for {:.1}s", began.elapsed().as_secs_f64());
        let report = (|| -> Result<(), String> {
            let made = result?.ok_or("nothing was kept")?;
            let video = made.video.ok_or("no video with the capture")?;
            let file = PathBuf::from(&video.path);
            let _ = std::fs::create_dir_all(&out);
            std::fs::copy(&file, out.join("recording.mp4")).map_err(|e| e.to_string())?;
            eprintln!("[Mark] selftest: {} -> {:?}", file.display(), movie::info(&file));
            eprintln!("[Mark] selftest: poster {}×{} at scale {:.2}, sound {}", made.width, made.height, made.scale, video.sound);
            std::fs::write(out.join("poster.png"), &made.png).map_err(|e| e.to_string())?;
            let strip = movie::frames(&file, video.duration, 10, 72.0)?;
            std::fs::write(out.join("strip-5.jpg"), &strip[5]).map_err(|e| e.to_string())?;
            eprintln!("[Mark] selftest: strip of {} frames", strip.len());
            let trimmed = out.join("trim.mp4");
            movie::export(&file, Some(&movie::Timeline { parts: vec![movie::Trim { start: 0.5, end: 1.5 }], speed: 1.0 }), None, &trimmed)?;
            eprintln!("[Mark] selftest: trim -> {:?}", movie::info(&trimmed));
            let plan = movie::gif_plan(&movie::Timeline { parts: vec![movie::Trim { start: 0.0, end: video.duration.min(2.0) }], speed: 1.0 }, (made.width, made.height), made.scale, false);
            let began = Instant::now();
            movie::gif(&file, &plan, None, &out.join("clip.gif"))?;
            eprintln!("[Mark] selftest: gif of {} frames at {:?} in {:.1}s, {} bytes", plan.times.len(), plan.size,
                      began.elapsed().as_secs_f64(), std::fs::metadata(out.join("clip.gif")).map(|m| m.len()).unwrap_or(0));
            Ok(())
        })();
        eprintln!("[Mark] selftest: done: {report:?}");
        let _ = on_main(&app, |app| { app.exit(0); Ok(()) });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clear PNG `width` × `height`, base64, as the editor sends a plate.
    fn plate(width: u32, height: u32) -> String {
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.write_header().unwrap().write_image_data(&vec![0; (width * height * 4) as usize]).unwrap();
        STANDARD.encode(png)
    }

    #[test]
    fn a_frame_is_taken_only_whole_and_round_the_recording() {
        let framing = |width, height, x, y| Framing { width, height, x, y, under: plate(width, height), mask: plate(width, height), over: None };
        let plates = framed(framing(60, 50, 10.0, 5.0), (40, 30)).unwrap();
        assert_eq!((plates.size, plates.at), ((60, 50), (10.0, 5.0)));
        // The recording has to be wholly on the canvas.
        assert!(framed(framing(60, 50, 30.0, 5.0), (40, 30)).is_err());
        assert!(framed(framing(60, 50, -1.0, 5.0), (40, 30)).is_err());
        assert!(framed(framing(60, 50, f64::NAN, 5.0), (40, 30)).is_err());
        // The pictures have to be the size it says.
        let mut wrong = framing(60, 50, 10.0, 5.0);
        wrong.mask = plate(61, 50);
        assert!(framed(wrong, (40, 30)).is_err());
        // What goes over it, too.
        let mut over = framing(60, 50, 10.0, 5.0);
        over.over = Some(plate(60, 50));
        assert!(framed(over.clone(), (40, 30)).unwrap().over.is_some());
        over.over = Some(plate(20, 50));
        assert!(framed(over, (40, 30)).is_err());
        // And a canvas can't be enormous.
        assert!(framed(Framing { width: 9000, height: 50, x: 0.0, y: 0.0, under: String::new(), mask: String::new(), over: None }, (40, 30)).is_err());
        // A frame alone is something drawn.
        let marks = Marks { frame: Some(framing(60, 50, 10.0, 5.0)), ..Marks::default() };
        assert!(drawn(Some(marks), (40, 30)).unwrap().is_some_and(|(drawn, _)| drawn.frame.is_some()));
    }

    #[test]
    fn a_camera_is_taken_only_in_order_and_within_its_bounds() {
        assert_eq!(followed(vec![]).unwrap(), None);
        let fine = vec![(1.0, 10.0, 10.0, 1.0), (1.1, 12.0, 10.0, 2.0)];
        assert_eq!(followed(fine.clone()).unwrap(), Some(fine));
        assert!(followed(vec![(1.0, 10.0, 10.0, 6.0)]).is_err(), "closer than it may come");
        assert!(followed(vec![(1.0, 10.0, 10.0, 0.5)]).is_err(), "further than the whole picture");
        assert!(followed(vec![(1.1, 10.0, 10.0, 2.0), (1.0, 10.0, 10.0, 2.0)]).is_err(), "out of order");
        assert!(followed(vec![(1.0, f64::NAN, 10.0, 2.0)]).is_err());
        assert!(followed(vec![(1.0, 0.0, 0.0, 1.0); MOST_CAMERA + 1]).is_err());
    }

    #[test]
    fn a_countdown_is_told_when_it_ends_and_whether_a_recording_follows() {
        assert_eq!(countdown_page(1_790_000_005_000, false), "recording.html?countdown&until=1790000005000");
        assert_eq!(countdown_page(1_790_000_003_000, true), "recording.html?countdown&until=1790000003000&video");
    }

    #[test]
    fn the_pointer_is_followed_from_the_top_left_of_what_is_recorded() {
        // A region at 400, 300: the pointer at 450, 320 is 50, 20 into it.
        assert_eq!(relative((450.0, 320.0), (400.0, 300.0)), (50.0, 20.0));
        // A window that moved to -120, 40 on a second display, the pointer still on it.
        assert_eq!(relative((-100.0, 70.0), (-120.0, 40.0)), (20.0, 30.0));
    }
    use capture::Rect;

    const WORK: Rect = Rect { x: 0.0, y: 33.0, width: 1512.0, height: 849.0 };

    #[test]
    fn the_bar_sits_under_what_is_recorded_or_above_it_or_inside_it() {
        let size = (200.0, 50.0);
        // Room below: centred under it.
        assert_eq!(bar_place(Rect { x: 100.0, y: 100.0, width: 400.0, height: 300.0 }, WORK, size), (200.0, 406.0));
        // None below: above.
        assert_eq!(bar_place(Rect { x: 100.0, y: 500.0, width: 400.0, height: 360.0 }, WORK, size), (200.0, 444.0));
        // None either way, as for the whole display: inside, along its bottom.
        assert_eq!(bar_place(Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 }, WORK, size), (656.0, 832.0));
        // Never off the side of the screen.
        assert_eq!(bar_place(Rect { x: 1450.0, y: 100.0, width: 60.0, height: 60.0 }, WORK, size).0, 1312.0);
    }

    #[test]
    fn the_clock_reads_minutes_and_seconds() {
        assert_eq!(clock(0), "0:00");
        assert_eq!(clock(12), "0:12");
        assert_eq!(clock(245), "4:05");
        assert_eq!(clock(300), "5:00");
    }

    #[test]
    fn a_recording_is_named_as_save_names_a_screenshot() {
        let name = stamp();
        assert!(name.starts_with("Mark 20") && name.contains(" at "), "{name}");
        assert_eq!(name.len(), "Mark 2026-10-29 at 10.41.22".len());
    }
}
