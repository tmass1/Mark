//! Screen recordings, by ScreenCaptureKit: a stream of one display, with Mark's
//! own windows left out of it, or of one window on its own, written straight
//! to an MP4 by the recording output macOS 15 added. What to record and what
//! becomes of the file are recording.rs's to decide.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_av_foundation::{AVFileTypeMPEG4, AVVideoCodecTypeH264};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_media::CMTime;
use objc2_foundation::{NSArray, NSError, NSString, NSURL};
use objc2_screen_capture_kit::{SCContentFilter, SCRecordingOutput, SCRecordingOutputConfiguration, SCRecordingOutputDelegate,
                               SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate};
use std::path::PathBuf;
use std::sync::{mpsc::{self, Sender}, Mutex};
use std::time::Duration;

use crate::capture::Rect;

/// How long macOS gets to answer each step of starting or stopping.
const PATIENCE: Duration = Duration::from_secs(5);
/// The largest frame H.264 takes on every Mac: a recording of anything bigger
/// is scaled down to fit inside it.
const LARGEST: (f64, f64) = (3840.0, 2160.0);
/// Frames a second. Plenty for a screen, where most frames repeat the last.
const RATE: i32 = 30;
/// ScreenCaptureKit's code for a stream stopped from macOS's own menu bar
/// indicator rather than by Mark.
pub const USER_STOPPED: isize = -3817;

/// Recording needs the recording output macOS 15 added. Asked of the runtime,
/// so the same Mark runs on 13 and 14 with recording left out.
pub fn supported() -> bool { AnyClass::get(c"SCRecordingOutput").is_some() }

/// What to record: part of a display, or all of one, in global points; or one
/// window, by the number the window server knows it by.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source { Area(Rect), Window(u32) }

pub struct Options { pub source: Source, pub mic: bool, pub clicks: bool, pub output: PathBuf }

/// What happens to a recording after it starts, from whichever queue macOS
/// says it on. Finished or Failed comes once the file is closed; Ended means
/// the stream stopped without being asked -- the user stopped it from the menu
/// bar, or the display or window went -- with ScreenCaptureKit's code.
#[derive(Clone, Debug, PartialEq)]
pub enum Event { Started, Finished, Failed(String), Ended(isize, String) }

/// The size of what is being recorded: in points, and in the pixels the movie
/// is made of.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape { pub points: (f64, f64), pub pixels: (usize, usize) }

/// The display an area belongs to: the one its middle is on, or failing that,
/// the one it covers most of.
pub fn pick_display(displays: &[Rect], area: Rect) -> Option<usize> {
    let (x, y) = (area.x + area.width / 2.0, area.y + area.height / 2.0);
    displays.iter().position(|d| x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height).or_else(|| {
        let overlap = |d: &Rect| (area.x.max(d.x) - (area.x + area.width).min(d.x + d.width)).min(0.0)
            * (area.y.max(d.y) - (area.y + area.height).min(d.y + d.height)).min(0.0);
        displays.iter().enumerate().filter(|(_, d)| overlap(d) > 0.0)
            .max_by(|a, b| overlap(a.1).total_cmp(&overlap(b.1))).map(|(index, _)| index)
    })
}

/// An area in its display's own points, from the display's top left, and no
/// further out than the display goes.
pub fn local(area: Rect, display: Rect) -> Rect {
    let x = (area.x - display.x).clamp(0.0, display.width);
    let y = (area.y - display.y).clamp(0.0, display.height);
    Rect { x, y, width: area.width.min(display.width - x), height: area.height.min(display.height - y) }
}

/// The movie's size: every pixel the display has for the area, unless that is
/// more than H.264 takes, when it is scaled down to fit. Even both ways, as
/// the encoder needs.
pub fn pixel_size(points: (f64, f64), scale: f64) -> (usize, usize) {
    let (width, height) = (points.0 * scale, points.1 * scale);
    let (most_wide, most_high) = if width >= height { LARGEST } else { (LARGEST.1, LARGEST.0) };
    let fit = (most_wide / width).min(most_high / height).min(1.0);
    let even = |value: f64| ((value * fit / 2.0).floor() as usize * 2).max(2);
    (even(width), even(height))
}

struct Live { stream: Retained<SCStream>, _output: Retained<SCRecordingOutput>, _delegate: Retained<Delegate> }
// SAFETY: ScreenCaptureKit's objects may be used from any thread, and these
// are only ever touched with LIVE locked.
unsafe impl Send for Live {}
/// The recording under way. One at a time: Mark has one capture guard.
static LIVE: Mutex<Option<Live>> = Mutex::new(None);

/// Something made on one of macOS's queues, carried back to the thread that
/// asked for it, which is the only one that uses it.
struct Carried<T>(T);
// SAFETY: see above; each is handed over once and used on one thread after.
unsafe impl<T> Send for Carried<T> {}

fn described(error: *mut NSError) -> String {
    // SAFETY: macOS hands over a valid NSError or none.
    match unsafe { error.as_ref() } { Some(error) => error.localizedDescription().to_string(), None => "no reason was given".into() }
}

fn rect(rect: CGRect) -> Rect { Rect { x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height } }

/// What is on screen to record, as ScreenCaptureKit sees it.
fn content() -> Result<Retained<SCShareableContent>, String> {
    let (sent, received) = mpsc::channel();
    let answered = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: a valid object or nil, which is retained to outlive the block.
        let _ = sent.send(unsafe { Retained::retain(content) }.map(Carried).ok_or_else(|| described(error)));
    });
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(false, true, &answered) };
    match received.recv_timeout(PATIENCE) {
        Ok(Ok(content)) => Ok(content.0),
        Ok(Err(reason)) => Err(format!("Mark can't see the screen to record it ({reason}).")),
        Err(_) => Err("macOS didn't say what's on screen to record.".into()),
    }
}

/// Wait for a completion handler that says only whether it worked.
fn completion() -> (RcBlock<dyn Fn(*mut NSError)>, mpsc::Receiver<Result<(), String>>) {
    let (sent, received) = mpsc::channel();
    let block = RcBlock::new(move |error: *mut NSError| {
        let _ = sent.send(if error.is_null() { Ok(()) } else { Err(described(error)) });
    });
    (block, received)
}

/// Start recording, and return once the stream is running. Events about the
/// recording go to `events` from then on. Not on the main thread: it waits
/// for macOS.
pub fn start(options: Options, events: Sender<Event>) -> Result<Shape, String> {
    if !supported() { return Err("Recording the screen needs macOS 15 or later.".into()); }
    if LIVE.lock().unwrap().is_some() { return Err("Mark is already recording.".into()); }
    let content = content()?;
    let own = std::process::id() as i32;
    let (filter, area) = match options.source {
        Source::Window(id) => {
            let window = unsafe { content.windows() }.iter().find(|window| unsafe { window.windowID() } == id)
                .ok_or("That window has closed. Pick another to record.")?;
            (unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) }, None)
        }
        Source::Area(area) => {
            let displays = unsafe { content.displays() };
            let frames: Vec<Rect> = displays.iter().map(|display| rect(unsafe { display.frame() })).collect();
            let index = pick_display(&frames, area).ok_or("That part of the screen isn't on a display.")?;
            // Everything on the display but Mark: its overlay is gone by now,
            // and its recording bar and outline are never in the movie.
            let mine: Vec<Retained<SCRunningApplication>> = unsafe { content.applications() }.iter()
                .filter(|app| unsafe { app.processID() } == own).collect();
            let filter = unsafe { SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(), &displays.objectAtIndex(index), &NSArray::from_retained_slice(&mine), &NSArray::new()) };
            (filter, Some(local(area, frames[index])))
        }
    };
    let scale = f64::from(unsafe { filter.pointPixelScale() }).max(1.0);
    let points = match area { Some(area) => (area.width, area.height), None => { let r = rect(unsafe { filter.contentRect() }); (r.width, r.height) } };
    let pixels = pixel_size(points, scale);

    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(pixels.0);
        config.setHeight(pixels.1);
        if let Some(area) = area {
            config.setSourceRect(CGRect::new(CGPoint::new(area.x, area.y), CGSize::new(area.width, area.height)));
        }
        config.setScalesToFit(true);
        config.setShowsCursor(true);
        config.setShowMouseClicks(options.clicks);
        config.setCaptureMicrophone(options.mic);
        config.setMinimumFrameInterval(CMTime::new(1, RATE));
    }

    let path = options.output.to_str().ok_or("The recording's path isn't usable.")?;
    let file = unsafe { SCRecordingOutputConfiguration::new() };
    unsafe {
        file.setOutputURL(&NSURL::fileURLWithPath(&NSString::from_str(path)));
        if let Some(mp4) = AVFileTypeMPEG4 { file.setOutputFileType(mp4); }
        if let Some(h264) = AVVideoCodecTypeH264 { file.setVideoCodecType(h264); }
    }
    let delegate = Delegate::new(events);
    let output = unsafe { SCRecordingOutput::initWithConfiguration_delegate(SCRecordingOutput::alloc(), &file, ProtocolObject::from_ref(&*delegate)) };
    let stream = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, Some(ProtocolObject::from_ref(&*delegate))) };
    unsafe { stream.addRecordingOutput_error(&output) }
        .map_err(|error| format!("The recording couldn't be set up ({}).", error.localizedDescription()))?;

    let (started, result) = completion();
    *LIVE.lock().unwrap() = Some(Live { stream: stream.clone(), _output: output, _delegate: delegate });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&started)) };
    let outcome = result.recv_timeout(PATIENCE).unwrap_or_else(|_| Err("macOS didn't start the recording".into()));
    if let Err(reason) = outcome {
        release();
        return Err(format!("The recording couldn't start ({reason}). Check Mark's screen access in System Settings."));
    }
    Ok(Shape { points, pixels })
}

/// Stop the stream. The file is closed after: Finished or Failed says when,
/// and only then may `release` let the recording go.
pub fn stop() -> Result<(), String> {
    let stream = LIVE.lock().unwrap().as_ref().map(|live| live.stream.clone()).ok_or("Nothing is recording.")?;
    let (stopped, result) = completion();
    unsafe { stream.stopCaptureWithCompletionHandler(Some(&stopped)) };
    result.recv_timeout(PATIENCE).unwrap_or_else(|_| Err("macOS didn't stop the recording".into()))
}

/// Let go of the stream, its output and their delegate.
pub fn release() { LIVE.lock().unwrap().take(); }

struct DelegateIvars { events: Sender<Event> }

define_class!(
    /// Hears from the recording output and the stream, and passes it on.
    #[unsafe(super(NSObject))]
    #[name = "MarkRecordingDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl SCRecordingOutputDelegate for Delegate {
        #[unsafe(method(recordingOutputDidStartRecording:))]
        fn started(&self, _output: &SCRecordingOutput) { let _ = self.ivars().events.send(Event::Started); }

        #[unsafe(method(recordingOutput:didFailWithError:))]
        fn failed(&self, _output: &SCRecordingOutput, error: &NSError) {
            let _ = self.ivars().events.send(Event::Failed(error.localizedDescription().to_string()));
        }

        #[unsafe(method(recordingOutputDidFinishRecording:))]
        fn finished(&self, _output: &SCRecordingOutput) { let _ = self.ivars().events.send(Event::Finished); }
    }

    unsafe impl SCStreamDelegate for Delegate {
        #[unsafe(method(stream:didStopWithError:))]
        fn ended(&self, _stream: &SCStream, error: &NSError) {
            let _ = self.ivars().events.send(Event::Ended(error.code(), error.localizedDescription().to_string()));
        }
    }
);

impl Delegate {
    fn new(events: Sender<Event>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { events });
        unsafe { msg_send![super(this), init] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    const BESIDE: Rect = Rect { x: 1512.0, y: -200.0, width: 2560.0, height: 1440.0 };

    #[test]
    fn an_area_belongs_to_the_display_its_middle_is_on() {
        let displays = [MAIN, BESIDE];
        assert_eq!(pick_display(&displays, Rect { x: 100.0, y: 100.0, width: 400.0, height: 300.0 }), Some(0));
        assert_eq!(pick_display(&displays, Rect { x: 1400.0, y: 0.0, width: 600.0, height: 300.0 }), Some(1));
        // Its middle in a gap between displays: the one it covers most of.
        assert_eq!(pick_display(&displays, Rect { x: 1300.0, y: 1000.0, width: 400.0, height: 300.0 }), Some(1));
        assert_eq!(pick_display(&displays, Rect { x: 9000.0, y: 9000.0, width: 10.0, height: 10.0 }), None);
    }

    #[test]
    fn an_area_is_recorded_in_its_displays_own_points() {
        assert_eq!(local(Rect { x: 1612.0, y: -150.0, width: 640.0, height: 400.0 }, BESIDE),
                   Rect { x: 100.0, y: 50.0, width: 640.0, height: 400.0 });
        // A whole display is all of it.
        assert_eq!(local(BESIDE, BESIDE), Rect { x: 0.0, y: 0.0, width: 2560.0, height: 1440.0 });
        // Never past its edge.
        assert_eq!(local(Rect { x: 1400.0, y: 900.0, width: 300.0, height: 300.0 }, MAIN),
                   Rect { x: 1400.0, y: 900.0, width: 112.0, height: 82.0 });
    }

    #[test]
    fn a_movie_is_every_pixel_up_to_what_h264_takes_and_even() {
        assert_eq!(pixel_size((640.0, 400.0), 2.0), (1280, 800));
        assert_eq!(pixel_size((641.0, 401.0), 1.0), (640, 400));
        // A 5K display, whole: scaled to fit inside 3840 × 2160.
        assert_eq!(pixel_size((2560.0, 1440.0), 2.0), (3840, 2160));
        // Tall fits the other way round.
        assert_eq!(pixel_size((1000.0, 3000.0), 2.0), (1280, 3840));
        assert_eq!(pixel_size((0.4, 0.4), 1.0), (2, 2));
    }
}
