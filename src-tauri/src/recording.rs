//! Screen recordings, end to end. One starts from the overlay as a capture
//! does, runs with a small bar beside what is being recorded to stop it, and
//! ends as a capture: the movie's first frame is the picture, and the movie
//! goes with it, to the editor or the thumbnail. Then what the editor does with
//! one: the frames to trim against, and Copy, Save and Share of all of it or of
//! the part kept.

use crate::{capture, macos, movie, sck, session::{Live, Recorded, State, Stop}, thumbnail};
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
/// Recordings stop by themselves after this long. Mark is for short ones.
pub const LONGEST: Duration = Duration::from_secs(300);
/// The trim strip under a recording in the editor and the gap above it, kept
/// clear when the window is fitted to it. Mirrors .trim in style.css.
pub const STRIP: f64 = 12.0 + 52.0;
/// The bar's window, its shadow's room included. Mirrors recording.css.
const BAR_SIZE: (f64, f64) = (232.0, 64.0);
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
    let (mic, clicks) = {
        let prefs = app.state::<crate::Prefs>();
        let prefs = prefs.0.lock().unwrap();
        (prefs.record_mic, prefs.record_clicks)
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
    let shape = match sck::start(sck::Options { source, mic, clicks, output: file.clone() }, events) {
        Ok(shape) => shape,
        Err(error) => { let _ = std::fs::remove_dir_all(&folder); return Err(error); }
    };
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
        std::thread::sleep(Duration::from_millis(50));
    }
    app.state::<State>().lock().unwrap().recording = None;
    let _ = on_main(app, |app| { hide_bar(app); crate::recording_menu(app, false); crate::set_tray_title(app, None); Ok(()) });

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
    let gone = app.state::<State>().lock().unwrap().keep_video(Recorded {
        id, folder, file, duration: info.duration, pixels: (info.width, info.height), scale, edited: None,
    });
    for folder in gone { let _ = std::fs::remove_dir_all(folder); }
    Ok(Some(capture::Capture { png: poster, width: info.width, height: info.height, scale, video: Some(video) }))
}

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

struct Found { file: PathBuf, folder: PathBuf, duration: f64, pixels: (u32, u32), scale: f64, edited: Option<(movie::Edit, PathBuf)> }

fn find(app: &AppHandle, id: u64) -> Result<Found, String> {
    let state = app.state::<State>();
    let mut session = state.lock().unwrap();
    let video = session.video(id).ok_or(GONE)?;
    Ok(Found { file: video.file.clone(), folder: video.folder.clone(), duration: video.duration, pixels: video.pixels,
               scale: video.scale, edited: video.edited.clone() })
}

/// What the editor drew on a recording, as it sends it: a PNG of the marks,
/// base64, for each moment one appears at, and the parts to pixelate.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Marks {
    #[serde(default)] overlays: Vec<Overlay>,
    #[serde(default)] redactions: Vec<movie::Hidden>,
}
#[derive(Clone, Debug, Deserialize)]
struct Overlay { at: f64, png: String }

/// Far more moments than anyone marks a short recording at.
const MOST_MOMENTS: usize = 200;

/// The marks made ready to draw, with a fingerprint to tell one set from
/// another by: each picture checked to be a whole PNG the recording's size,
/// and every time and area a number. Nothing drawn is None.
fn drawn(marks: Option<Marks>, pixels: (u32, u32)) -> Result<Option<(movie::Drawn, u64)>, String> {
    use std::hash::{Hash, Hasher};
    let Some(marks) = marks else { return Ok(None) };
    if marks.overlays.is_empty() && marks.redactions.is_empty() { return Ok(None); }
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
        for n in numbers { n.to_bits().hash(&mut print); }
    }
    Ok(Some((movie::Drawn { overlays, redactions: marks.redactions }, print.finish())))
}

/// The movie to hand on for recording `id`: all of it as it was made, or the
/// part between `start` and `end`, with what was drawn on it drawn in -- made
/// once for each such copy, and kept beside the movie, under the same name,
/// until another replaces it.
fn movie_for(app: &AppHandle, id: u64, start: f64, end: f64, marks: Option<Marks>) -> Result<PathBuf, String> {
    let found = find(app, id)?;
    let trim = movie::Trim::new(start, end, found.duration)?;
    let drawn = drawn(marks, found.pixels)?;
    if trim.is_none() && drawn.is_none() { return Ok(found.file); }
    let edit = movie::Edit { trim, marks: drawn.as_ref().map(|(_, print)| *print) };
    if let Some((made, path)) = found.edited { if made == edit && path.exists() { return Ok(path); } }
    let out = found.folder.join("Edited").join(found.file.file_name().ok_or(GONE)?);
    std::fs::create_dir_all(out.parent().ok_or(GONE)?).map_err(|e| e.to_string())?;
    movie::export(&found.file, trim, drawn.as_ref().map(|(drawn, _)| drawn), &out)?;
    if let Some(video) = app.state::<State>().lock().unwrap().video(id) { video.edited = Some((edit, out.clone())); }
    Ok(out)
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
pub async fn copy_video(app: AppHandle, id: u64, start: f64, end: f64, close: bool, marks: Option<Marks>) -> Result<(), String> {
    if app.state::<State>().lock().unwrap().busy { return Err("Finish the capture under way first.".into()); }
    let handle = app.clone();
    let movie = blocking(move || movie_for(&handle, id, start, end, marks)).await?;
    on_main(&app, move |app| {
        macos::copy_file(&movie)?;
        if close { crate::put_away(app, None) } else { Ok(()) }
    })
}

/// Save: the movie, or the part kept, with what was drawn on it, as an MP4 --
/// or as a GIF that loops. Returns the name it was saved under, or None if
/// Save was cancelled.
#[tauri::command]
pub async fn save_video(app: AppHandle, id: u64, start: f64, end: f64, gif: bool, name: String, marks: Option<Marks>)
    -> Result<Option<String>, String> {
    let found = find(&app, id)?;
    let (extension, kind) = if gif { ("gif", "GIF image") } else { ("mp4", "MPEG-4 movie") };
    let chosen = app.dialog().file().add_filter(kind, &[extension]).set_file_name(crate::safe_name(&name, extension)).blocking_save_file();
    let Some(chosen) = chosen else { return Ok(None) };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    let target = path.clone();
    let handle = app.clone();
    blocking(move || {
        if gif {
            let trim = movie::Trim::new(start, end, found.duration)?.unwrap_or(movie::Trim { start: 0.0, end: found.duration });
            let drawn = drawn(marks, found.pixels)?;
            movie::gif(&found.file, &movie::gif_plan(trim, found.pixels, found.scale), drawn.as_ref().map(|(drawn, _)| drawn), &target)
        } else {
            let movie = movie_for(&handle, id, start, end, marks)?;
            std::fs::copy(&movie, &target).map(|_| ()).map_err(|e| format!("The recording couldn't be saved ({e})."))
        }
    }).await?;
    Ok(Some(path.file_name().unwrap_or_default().to_string_lossy().into_owned()))
}

/// Share: the movie, or the part kept, with what was drawn on it, to macOS's
/// share sheet.
#[tauri::command]
pub async fn share_video(app: AppHandle, id: u64, start: f64, end: f64, marks: Option<Marks>) -> Result<(), String> {
    let handle = app.clone();
    let movie = blocking(move || movie_for(&handle, id, start, end, marks)).await?;
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
            movie::export(&file, Some(movie::Trim { start: 0.5, end: 1.5 }), None, &trimmed)?;
            eprintln!("[Mark] selftest: trim -> {:?}", movie::info(&trimmed));
            let plan = movie::gif_plan(movie::Trim { start: 0.0, end: video.duration.min(2.0) }, (made.width, made.height), made.scale);
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
