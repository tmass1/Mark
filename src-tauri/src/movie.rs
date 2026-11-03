//! A finished recording, read back with AVFoundation: how long and how big it
//! is, a still of it for the editor and Recent, a strip of small frames to trim
//! against, and a copy of it -- trimmed, with what was drawn on it drawn into
//! its frames by Core Image -- as an MP4, or as a GIF written with ImageIO. And
//! whether Mark may use the microphone, which AVFoundation also answers.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{AVAsset, AVAudioTimePitchAlgorithmSpectral, AVMutableComposition, AVAssetExportPresetHighestQuality, AVAssetExportSession, AVAssetExportSessionStatus,
                          AVAssetImageGenerator, AVAssetTrack, AVAsynchronousCIImageFilteringRequest, AVAuthorizationStatus,
                          AVCaptureDevice, AVFileTypeMPEG4, AVMediaTypeAudio, AVMediaTypeVideo, AVMutableVideoComposition, AVURLAsset,
                          AVVideoComposition};
use objc2_core_foundation::{CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType, CFURL, CGAffineTransform, CGPoint, CGRect, CGSize};
use objc2_core_image::{CIColor, CIFilter, CIImage, CIVector};
use objc2_core_graphics::CGImage;
use objc2_core_media::{CMTime, CMTimeRange};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSNumber, NSString, NSURL};
use serde::Deserialize;
use objc2_image_io::{kCGImageDestinationLossyCompressionQuality, kCGImagePropertyGIFDelayTime, kCGImagePropertyGIFDictionary,
                     kCGImagePropertyGIFLoopCount, kCGImagePropertyGIFUnclampedDelayTime, CGImageDestination};
use std::path::Path;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

/// The shortest a trim may leave: less is a still, not a recording.
pub const SHORTEST: f64 = 0.5;
/// A trim this close to an end is that end: less than two frames.
const NEAR: f64 = 0.05;
/// GIFs play at this many frames a second, at points rather than pixels, and
/// no larger than this along their long side: past that they grow too large
/// to send for what they show. A small one, for a chat, is fewer and smaller.
const GIF_RATE: f64 = 15.0;
const GIF_LONGEST: f64 = 1280.0;
const SMALL_GIF_RATE: f64 = 10.0;
const SMALL_GIF_LONGEST: f64 = 640.0;
/// How much faster than it was recorded a copy may play, and how much slower.
const FASTEST: f64 = 4.0;
const SLOWEST: f64 = 0.25;
/// How long one still may take to come out of the movie.
const PATIENCE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Info { pub duration: f64, pub width: u32, pub height: u32, pub sound: bool }

/// The part of a recording to keep, in seconds from its start.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trim { pub start: f64, pub end: f64 }

/// What is drawn on a recording, ready to go into its frames: a picture of
/// the marks for each moment one appears at -- all of those due by then -- and
/// the parts to pixelate, each from its own moment. Pixelated afresh in every
/// frame, since a recording's pixels change under a redaction.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Drawn {
    pub overlays: Vec<(f64, Vec<u8>)>, pub redactions: Vec<Hidden>, pub pointer: Option<Pointer>, pub frame: Option<Plates>,
    /// Where the camera is through each zoom: seconds in, the middle of the
    /// view on the canvas, and how much closer than the whole. The editor
    /// works it out; this follows it.
    pub camera: Option<Vec<(f64, f64, f64, f64)>>,
}

/// The camera `time` seconds in: between the two samples either side, in
/// proportion, if they are of one zoom -- the editor sends them a thirtieth
/// of a second apart -- and None where there is no zoom, which is the whole
/// picture.
pub fn camera_at(track: &[(f64, f64, f64, f64)], time: f64) -> Option<(f64, f64, f64)> {
    const APART: f64 = 0.11;
    let after = track.partition_point(|sample| sample.0 <= time);
    let (at, x, y, scale) = *track.get(after.checked_sub(1)?)?;
    let (x, y, scale) = match track.get(after) {
        Some(&(next, nx, ny, nscale)) if next - at <= APART => {
            let share = if next > at { (time - at) / (next - at) } else { 0.0 };
            (x + (nx - x) * share, y + (ny - y) * share, scale + (nscale - scale) * share)
        }
        _ if time == at => (x, y, scale),
        _ => return None,
    };
    (scale > 1.0 + 1e-6).then_some((x, y, scale))
}

/// The frame round a recording: a canvas `size` pixels across, with the
/// recording set on it, its top left at `at`, over `under` -- the background,
/// the shadow, and a title bar or a phone -- showing through `mask`, the
/// screen's rounded shape, and under `over`, if anything goes over it: a
/// phone's island. All PNGs the canvas's size, which the editor paints as it
/// paints a framed screenshot.
#[derive(Clone, Debug, PartialEq)]
pub struct Plates { pub size: (u32, u32), pub at: (f64, f64), pub under: Vec<u8>, pub mask: Vec<u8>, pub over: Option<Vec<u8>> }

/// The largest frame H.264 takes on every Mac, as sck.rs records at most: a
/// framed copy larger than this is scaled down to fit.
const LARGEST: (f64, f64) = (3840.0, 2160.0);

/// The size a copy of a recording `pixels` across comes out: its own, or the
/// frame's canvas, fitted inside LARGEST, in even pixels as H.264 wants.
pub fn output_size(drawn: Option<&Drawn>, pixels: (u32, u32)) -> (u32, u32) {
    let Some(plates) = drawn.and_then(|drawn| drawn.frame.as_ref()) else { return pixels };
    let (width, height) = (f64::from(plates.size.0), f64::from(plates.size.1));
    let fit = (LARGEST.0 / width).min(LARGEST.1 / height).min(1.0);
    let even = |side: f64| ((side * fit / 2.0).floor() * 2.0).max(2.0) as u32;
    (even(width), even(height))
}

/// What Mark draws of the pointer: something following it along `track` --
/// seconds in, and x and y in the recording's pixels from its top left, in
/// order -- and a ripple, `ripple` pixels across at its widest, where each of
/// `presses` went down. A press is the seconds in that the button went down
/// and came up.
#[derive(Clone, Debug, PartialEq)]
pub struct Pointer { pub track: Vec<(f64, f64, f64)>, pub presses: Vec<(f64, f64)>, pub shape: Option<Shape>, pub ripple: Option<f64> }

/// A soft yellow halo, so many pixels from its centre to where it fades out;
/// or a fingertip, so many pixels across, pressed in while the button is down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape { Halo(f64), Touch(f64) }

/// A press too quick to see -- a trackpad's tap is over in a hundredth of a
/// second -- is shown pressed for this long. And a ripple runs for this long.
pub const PRESS_SHORTEST: f64 = 0.12;
pub const RIPPLE_TIME: f64 = 0.45;

/// Whether the button is down `time` seconds in, as the fingertip shows it.
pub fn pressed_at(presses: &[(f64, f64)], time: f64) -> bool {
    presses.iter().any(|&(down, up)| down <= time && time < up.max(down + PRESS_SHORTEST))
}

/// The ripples under way `time` seconds in: when each began, and how far
/// through it is, from 0 to 1.
pub fn ripples_at(presses: &[(f64, f64)], time: f64) -> Vec<(f64, f64)> {
    presses.iter().filter(|&&(down, _)| down <= time && time < down + RIPPLE_TIME)
        .map(|&(down, _)| (down, (time - down) / RIPPLE_TIME)).collect()
}

/// How wide a ripple is, as a share of its widest, and how solid, `progress`
/// through it: quick to spread, slowing as it fades.
pub fn ripple_shape(progress: f64) -> (f64, f64) {
    let p = progress.clamp(0.0, 1.0);
    (0.35 + 0.65 * (1.0 - (1.0 - p).powi(2)), 1.0 - p)
}

/// Where the pointer was `time` seconds in: between the two moments either
/// side, in proportion, or at the last one before -- if that was recently
/// enough to say. None before the track starts or after it ends.
pub fn pointer_at(track: &[(f64, f64, f64)], time: f64) -> Option<(f64, f64)> {
    const STALE: f64 = 0.25;
    let after = track.partition_point(|(at, _, _)| *at <= time);
    let (at, x, y) = *track.get(after.checked_sub(1)?)?;
    match track.get(after) {
        Some(&(next, nx, ny)) if next - at <= STALE => {
            let share = if next > at { (time - at) / (next - at) } else { 0.0 };
            Some((x + (nx - x) * share, y + (ny - y) * share))
        }
        _ => (time - at <= STALE).then_some((x, y)),
    }
}

/// Red, green, blue and how solid, from 0 to 1.
type Rgba = [f64; 4];

/// Core Image's circles, centred on the origin: `inner` all the way in from
/// `inner_radius`, `outer` all the way out from `outer_radius`, and a blend
/// between. Endless, until cropped.
fn gradient(inner_radius: f64, inner: Rgba, outer_radius: f64, outer: Rgba) -> Result<Retained<CIImage>, String> {
    let color = |[r, g, b, a]: Rgba| unsafe { CIColor::colorWithRed_green_blue_alpha(r, g, b, a) };
    let keys = ["inputCenter", "inputRadius0", "inputRadius1", "inputColor0", "inputColor1"].map(NSString::from_str);
    let centre = unsafe { CIVector::vectorWithX_Y(0.0, 0.0) };
    let (r0, r1) = (NSNumber::new_f64(inner_radius.max(0.0)), NSNumber::new_f64(outer_radius.max(0.0)));
    let (c0, c1) = (color(inner), color(outer));
    let values: [&AnyObject; 5] = [&centre, &r0, &r1, &c0, &c1];
    let keys: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
    let settings = NSDictionary::<NSString, AnyObject>::from_slices(&keys, &values);
    let filter = unsafe { CIFilter::filterWithName_withInputParameters(&NSString::from_str("CIRadialGradient"), Some(&settings)) }
        .ok_or("The pointer couldn't be drawn.")?;
    unsafe { filter.outputImage() }.ok_or_else(|| "The pointer couldn't be drawn.".into())
}

/// Cropped to the square round a circle `radius` across.
fn around(image: &CIImage, radius: f64) -> Retained<CIImage> {
    let side = radius.ceil() + 1.0;
    unsafe { image.imageByCroppingToRect(CGRect::new(CGPoint::new(-side, -side), CGSize::new(side * 2.0, side * 2.0))) }
}

/// A disc, its edge softened over a pixel.
fn disc(radius: f64, color: Rgba) -> Result<Retained<CIImage>, String> {
    let image = gradient(radius - 1.0, color, radius, [color[0], color[1], color[2], 0.0])?;
    Ok(around(&image, radius))
}

/// A ring from `inner` to `outer`: what lies outside the inner edge, kept
/// only where the outer disc is.
fn ring(inner: f64, outer: f64, color: Rgba) -> Result<Retained<CIImage>, String> {
    let outside = gradient(inner - 1.0, [color[0], color[1], color[2], 0.0], inner, color)?;
    let within = disc(outer, [1.0, 1.0, 1.0, 1.0])?;
    let settings = NSDictionary::<NSString, AnyObject>::from_slices(&[&*NSString::from_str("inputBackgroundImage")], &[&*within as &AnyObject]);
    let kept = unsafe { outside.imageByApplyingFilter_withInputParameters(&NSString::from_str("CISourceInCompositing"), &settings) };
    Ok(around(&kept, outer))
}

/// The halo, centred on the origin, as Core Image draws it: yellow fading to
/// nothing, solid enough near the middle to find at a glance.
fn halo_image(radius: f64) -> Result<Retained<CIImage>, String> {
    let image = gradient(radius * 0.35, [1.0, 0.84, 0.04, 0.42], radius, [1.0, 0.84, 0.04, 0.0])?;
    Ok(around(&image, radius))
}

/// The fingertip's grey, which shows on a white screen and a black one; its
/// rim, which lifts it off a dark one; and how solid each is, resting and
/// pressed. The editor's style.css draws it the same.
const TOUCH_GREY: [f64; 3] = [0.47, 0.47, 0.5];
const TOUCH_FILL: (f64, f64) = (0.3, 0.5);
const TOUCH_RIM: (f64, f64) = (0.7, 0.9);
/// The rim's width, and a press's size, as shares of the fingertip's radius.
const TOUCH_RIM_SHARE: f64 = 0.075;
const TOUCH_PRESSED: f64 = 0.88;
/// A ripple's ring, as a share of its widest radius, and how solid it starts.
const RIPPLE_STROKE: f64 = 0.08;
const RIPPLE_SOLID: f64 = 0.75;

/// The fingertip, resting or pressed, centred on the origin: a grey disc in a
/// white rim.
fn touch_image(radius: f64, pressed: bool) -> Result<Retained<CIImage>, String> {
    let radius = if pressed { radius * TOUCH_PRESSED } else { radius };
    let (fill, rim) = if pressed { (TOUCH_FILL.1, TOUCH_RIM.1) } else { (TOUCH_FILL.0, TOUCH_RIM.0) };
    let inner = radius * (1.0 - TOUCH_RIM_SHARE);
    let [r, g, b] = TOUCH_GREY;
    let (middle, edge) = (disc(inner, [r, g, b, fill])?, ring(inner, radius, [1.0, 1.0, 1.0, rim])?);
    Ok(unsafe { middle.imageByCompositingOverImage(&edge) })
}

/// A ripple `progress` through, its widest `radius`, centred on the origin.
fn ripple_image(radius: f64, progress: f64) -> Result<Retained<CIImage>, String> {
    let (share, solid) = ripple_shape(progress);
    let (outer, [r, g, b]) = (radius * share, TOUCH_GREY);
    ring(outer - radius * RIPPLE_STROKE, outer, [r, g, b, RIPPLE_SOLID * solid])
}

/// A part to pixelate, in the recording's pixels from its top left, from `at`
/// seconds in -- until `until`, if it goes before the end -- in blocks
/// `block` pixels across.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Hidden {
    pub x: f64, pub y: f64, pub width: f64, pub height: f64, pub at: f64,
    #[serde(default)] pub until: Option<f64>,
    pub block: f64,
}

impl Hidden {
    /// Whether it is pixelated in the frame `time` seconds in: due a frame
    /// early, as a mark is, and gone a frame early too.
    fn due(&self, time: f64) -> bool { self.at <= time + DUE && self.until.is_none_or(|until| time + DUE < until) }
}

/// A copy of a recording as asked for: part of it or all of it, and with what
/// was drawn on it -- told apart by a fingerprint -- or not.
#[derive(Clone, Debug, PartialEq)]
pub struct Edit { pub timeline: Option<Timeline>, pub marks: Option<u64> }

/// What a copy keeps of a recording, in order: the part between the handles,
/// less any parts cut out of its middle -- and how fast it plays, 2 for
/// twice as fast. One part at its own speed is a plain trim.
#[derive(Clone, Debug, PartialEq)]
pub struct Timeline { pub parts: Vec<Trim>, pub speed: f64 }

/// Far more parts cut out than anyone cuts from a short recording.
const MOST_CUTS: usize = 100;

/// A mark is due a frame early rather than a frame late: drawn at a moment,
/// it is on that moment's frame.
const DUE: f64 = 1.0 / 60.0;

/// Which of the overlays, latest last, a frame `time` seconds in shows: the
/// last one due by then, if any is.
pub fn overlay_at(moments: &[f64], time: f64) -> Option<usize> { moments.iter().rposition(|at| *at <= time + DUE) }

/// A part to pixelate as Core Image counts, up from the bottom of a frame
/// `height` pixels tall.
fn flipped(part: &Hidden, height: f64) -> CGRect {
    CGRect::new(CGPoint::new(part.x, height - part.y - part.height), CGSize::new(part.width, part.height))
}

impl Trim {
    /// The part of a recording `duration` long between `start` and `end`, or
    /// None for all of it.
    pub fn new(start: f64, end: f64, duration: f64) -> Result<Option<Trim>, String> {
        if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
            return Err("That part of the recording can't be kept.".into());
        }
        let (start, end) = (start, end.min(duration));
        if end - start < SHORTEST - 1e-9 { return Err("Keep at least half a second of the recording.".into()); }
        if start <= NEAR && end >= duration - NEAR { return Ok(None); }
        Ok(Some(Trim { start, end }))
    }
}

impl Timeline {
    /// All of a recording `duration` long, as it was made.
    pub fn whole(duration: f64) -> Timeline { Timeline { parts: vec![Trim { start: 0.0, end: duration }], speed: 1.0 } }

    /// What is kept between `start` and `end` of a recording `duration` long,
    /// less `cuts`, which must be in order, apart and inside the handles, at
    /// `speed` -- or None for all of it, as it was made.
    pub fn new(start: f64, end: f64, cuts: &[(f64, f64)], speed: f64, duration: f64) -> Result<Option<Timeline>, String> {
        if !speed.is_finite() || !(SLOWEST..=FASTEST).contains(&speed) { return Err("That isn't a speed a copy can play at.".into()); }
        let trim = Trim::new(start, end, duration)?;
        if cuts.is_empty() {
            let kept = trim.unwrap_or(Trim { start: 0.0, end: duration });
            return Ok((trim.is_some() || speed != 1.0).then(|| Timeline { parts: vec![kept], speed }));
        }
        if cuts.len() > MOST_CUTS { return Err("Too many parts are cut out of the recording.".into()); }
        let kept = trim.unwrap_or(Trim { start: 0.0, end: duration });
        let (mut parts, mut from) = (Vec::new(), kept.start);
        for &(cut_start, cut_end) in cuts {
            if !cut_start.is_finite() || !cut_end.is_finite() || cut_end <= cut_start || cut_start < from - 1e-6 || cut_end > kept.end + 1e-6 {
                return Err("A part cut out isn't inside what is kept.".into());
            }
            if cut_start > from + 1e-3 { parts.push(Trim { start: from, end: cut_start }); }
            from = cut_end;
        }
        if kept.end > from + 1e-3 { parts.push(Trim { start: from, end: kept.end }); }
        let timeline = Timeline { parts, speed };
        if timeline.kept() < SHORTEST - 1e-9 { return Err("Keep at least half a second of the recording.".into()); }
        Ok(Some(timeline))
    }

    /// How much of the recording it keeps, in the recording's seconds.
    fn kept(&self) -> f64 { self.parts.iter().map(|part| part.end - part.start).sum() }

    /// How long a copy of it runs.
    pub fn length(&self) -> f64 { self.kept() / self.speed }

    /// Whether a copy is a range of the recording as it is, rather than parts
    /// joined, or played faster or slower.
    fn plain(&self) -> Option<Trim> { (self.parts.len() == 1 && self.speed == 1.0).then(|| self.parts[0]) }

    /// Where the moment `time` seconds into a copy is in the recording.
    pub fn source(&self, time: f64) -> f64 {
        let mut left = time.max(0.0) * self.speed;
        for part in &self.parts {
            let length = part.end - part.start;
            if left < length { return part.start + left; }
            left -= length;
        }
        self.parts.last().map_or(time, |part| part.end)
    }
}

/// The frames a GIF of what `timeline` keeps is made of -- times in the
/// recording -- how long each shows, and the largest each may be, in pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct GifPlan { pub times: Vec<f64>, pub delay: f64, pub size: (f64, f64) }

pub fn gif_plan(timeline: &Timeline, pixels: (u32, u32), scale: f64, small: bool) -> GifPlan {
    let (rate, longest) = if small { (SMALL_GIF_RATE, SMALL_GIF_LONGEST) } else { (GIF_RATE, GIF_LONGEST) };
    let delay = 1.0 / rate;
    let count = ((timeline.length() / delay).round() as usize).max(1);
    let times = (0..count).map(|index| timeline.source(index as f64 * delay)).collect();
    let (width, height) = (f64::from(pixels.0) / scale.max(1.0), f64::from(pixels.1) / scale.max(1.0));
    let fit = (longest / width.max(height)).min(1.0);
    GifPlan { times, delay, size: ((width * fit).round().max(1.0), (height * fit).round().max(1.0)) }
}

/// Something made on one of macOS's queues, carried back to the thread that
/// asked for it, which is the only one that uses it.
struct Carried<T>(T);
// SAFETY: each is handed over once and used on one thread after.
unsafe impl<T> Send for Carried<T> {}

fn described(error: *mut NSError) -> String {
    // SAFETY: macOS hands over a valid NSError or none.
    match unsafe { error.as_ref() } { Some(error) => error.localizedDescription().to_string(), None => "no reason was given".into() }
}

fn url(path: &Path) -> Result<Retained<NSURL>, String> {
    let path = path.to_str().ok_or("The recording's path isn't usable.")?;
    Ok(NSURL::fileURLWithPath(&NSString::from_str(path)))
}

fn asset(path: &Path) -> Result<Retained<AVURLAsset>, String> {
    let url = url(path)?;
    Ok(unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) })
}

fn seconds(seconds: f64) -> CMTime { unsafe { CMTime::with_seconds(seconds, 600) } }

fn tracks(asset: &AVURLAsset, audio: bool) -> Result<Vec<Retained<AVAssetTrack>>, String> {
    let kind = unsafe { if audio { AVMediaTypeAudio } else { AVMediaTypeVideo } }.ok_or("AVFoundation is missing a media type.")?;
    let (sent, received) = mpsc::channel();
    let loaded = RcBlock::new(move |tracks: *mut NSArray<AVAssetTrack>, error: *mut NSError| {
        // SAFETY: a valid array or nil, retained to outlive the block.
        let _ = sent.send(unsafe { Retained::retain(tracks) }.map(Carried).ok_or_else(|| described(error)));
    });
    unsafe { asset.loadTracksWithMediaType_completionHandler(kind, &loaded) };
    let tracks = received.recv_timeout(PATIENCE).map_err(|_| "The recording couldn't be read.".to_string())?
        .map_err(|reason| format!("The recording couldn't be read ({reason})."))?;
    Ok(tracks.0.to_vec())
}

/// How long the recording at `path` is, its size, and whether it has sound.
pub fn info(path: &Path) -> Result<Info, String> {
    let asset = asset(path)?;
    let duration = unsafe { asset.duration().seconds() };
    let video = tracks(&asset, false)?;
    let track = video.first().ok_or("The recording has no picture in it.")?;
    let size = unsafe { track.naturalSize() };
    let sound = !tracks(&asset, true)?.is_empty();
    if !duration.is_finite() || duration <= 0.0 { return Err("The recording is empty.".into()); }
    Ok(Info { duration, width: size.width.round() as u32, height: size.height.round() as u32, sound })
}

fn generator(path: &Path, largest: Option<(f64, f64)>, tolerance: f64) -> Result<Retained<AVAssetImageGenerator>, String> {
    let asset = asset(path)?;
    let generator = unsafe { AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset) };
    unsafe {
        generator.setAppliesPreferredTrackTransform(true);
        generator.setRequestedTimeToleranceBefore(seconds(tolerance));
        generator.setRequestedTimeToleranceAfter(seconds(tolerance));
        if let Some((width, height)) = largest { generator.setMaximumSize(CGSize::new(width, height)); }
    }
    Ok(generator)
}

/// The frame shown at `at` seconds.
fn still(generator: &AVAssetImageGenerator, at: f64) -> Result<CFRetained<CGImage>, String> {
    let (sent, received) = mpsc::channel();
    let made = RcBlock::new(move |image: *mut CGImage, _actual: CMTime, error: *mut NSError| {
        // SAFETY: a valid image or null, retained to outlive the block.
        let image = NonNull::new(image).map(|image| Carried(unsafe { CFRetained::retain(image) }));
        let _ = sent.send(image.ok_or_else(|| described(error)));
    });
    unsafe { generator.generateCGImageAsynchronouslyForTime_completionHandler(seconds(at), &made) };
    match received.recv_timeout(PATIENCE) {
        Ok(Ok(image)) => Ok(image.0),
        Ok(Err(reason)) => Err(format!("A frame of the recording couldn't be read ({reason}).")),
        Err(_) => Err("A frame of the recording took too long to read.".into()),
    }
}

fn properties(pairs: &[(&CFString, &CFType)]) -> CFRetained<CFDictionary<CFString, CFType>> {
    let (keys, values): (Vec<&CFString>, Vec<&CFType>) = pairs.iter().copied().unzip();
    CFDictionary::from_slices(&keys, &values)
}

/// One image as a file of the given type, in memory.
fn encode(image: &CGImage, kind: &str, quality: Option<f64>) -> Result<Vec<u8>, String> {
    let data = CFMutableData::new(None, 0).ok_or("There's no memory for the image.")?;
    let destination = unsafe { CGImageDestination::with_data(&data, &CFString::from_str(kind), 1, None) }
        .ok_or("The image couldn't be written.")?;
    let quality = quality.map(CFNumber::new_f64);
    let options = quality.as_ref().map(|quality| properties(&[(unsafe { kCGImageDestinationLossyCompressionQuality }, quality.as_ref())]));
    unsafe { destination.add_image(image, options.as_deref().map(|options| options.as_opaque())) };
    if !unsafe { destination.finalize() } { return Err("The image couldn't be written.".into()); }
    Ok(data.to_vec())
}

/// A PNG of the recording's first moment, at full size: what stands for it
/// where a picture is needed.
pub fn poster(path: &Path) -> Result<Vec<u8>, String> {
    let generator = generator(path, None, 0.0)?;
    encode(&*still(&generator, 0.0)?, "public.png", None)
}

/// `count` small JPEGs, `height` pixels tall, spread evenly through the
/// recording: what the trim strip shows.
pub fn frames(path: &Path, duration: f64, count: usize, height: f64) -> Result<Vec<Vec<u8>>, String> {
    let step = duration / count.max(1) as f64;
    let generator = generator(path, Some((height * 4.0, height)), step / 2.0)?;
    (0..count).map(|index| encode(&*still(&generator, step * (index as f64 + 0.5))?, "public.jpeg", Some(0.7))).collect()
}

/// Core Image's work on every frame: the parts due pixelated, then the marks
/// due laid over them, as the editor shows them over the playing movie.
/// `timeline`, for the parts of a recording joined into one asset: what turns
/// a moment of that back into a moment of the recording, which is what the
/// marks are timed in.
fn composition(asset: &AVAsset, drawn: &Drawn, timeline: Option<Timeline>) -> Result<Retained<AVVideoComposition>, String> {
    let mut overlays = drawn.overlays.iter()
        .map(|(at, png)| unsafe { CIImage::imageWithData(&NSData::with_bytes(png)) }.map(|image| (*at, image)))
        .collect::<Option<Vec<_>>>().ok_or("What was drawn on the recording couldn't be read.")?;
    overlays.sort_by(|a, b| a.0.total_cmp(&b.0));
    let moments: Vec<f64> = overlays.iter().map(|(at, _)| *at).collect();
    let hidden = drawn.redactions.clone();
    let pointer = drawn.pointer.clone();
    // What follows the pointer, made once: the halo, or the fingertip resting
    // and pressed. Ripples change size every frame, so are made for each.
    let sprites = match pointer.as_ref().and_then(|pointer| pointer.shape) {
        Some(Shape::Halo(radius)) => Some((halo_image(radius)?, None)),
        Some(Shape::Touch(radius)) => Some((touch_image(radius, false)?, Some(touch_image(radius, true)?))),
        None => None,
    };
    // The frame's two pictures, read once, and the size the copy comes out at.
    let read = |png: &[u8]| unsafe { CIImage::imageWithData(&NSData::with_bytes(png)) }.ok_or("The frame couldn't be read.".to_string());
    let plates = drawn.frame.as_ref()
        .map(|plates| Ok::<_, String>((read(&plates.under)?, read(&plates.mask)?, plates.over.as_deref().map(read).transpose()?, plates.at, plates.size)))
        .transpose()?;
    let out = plates.as_ref().map(|_| output_size(Some(drawn), (0, 0)));
    let camera = drawn.camera.clone();
    let pixellate = NSString::from_str("CIPixellate");
    let scale = NSString::from_str("inputScale");
    let blend = NSString::from_str("CIBlendWithAlphaMask");
    let (backing, masking) = (NSString::from_str("inputBackgroundImage"), NSString::from_str("inputMaskImage"));
    let applier = RcBlock::new(move |request: NonNull<AVAsynchronousCIImageFilteringRequest>| {
        // SAFETY: AVFoundation hands over a live request for each frame.
        let request = unsafe { request.as_ref() };
        let joined = unsafe { request.compositionTime().seconds() };
        let time = timeline.as_ref().map_or(joined, |timeline| timeline.source(joined));
        let mut frame = unsafe { request.sourceImage() };
        let height = unsafe { frame.extent() }.size.height;
        for part in hidden.iter().filter(|part| part.due(time)) {
            let area = flipped(part, height);
            let block = NSNumber::new_f64(part.block.max(2.0));
            let settings = NSDictionary::<NSString, AnyObject>::from_slices(&[&*scale], &[&*block as &AnyObject]);
            frame = unsafe {
                frame.imageByCroppingToRect(area).imageByClampingToExtent()
                    .imageByApplyingFilter_withInputParameters(&pixellate, &settings)
                    .imageByCroppingToRect(area).imageByCompositingOverImage(&frame)
            };
        }
        // The pointer under the marks, so an arrow at it stays sharp: the
        // ripples where the button went down, then what follows it.
        if let Some(pointer) = &pointer {
            let place = |image: &CIImage, (x, y): (f64, f64)| unsafe {
                image.imageByApplyingTransform(CGAffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx: x, ty: height - y })
            };
            if let Some(radius) = pointer.ripple {
                for (down, progress) in ripples_at(&pointer.presses, time) {
                    let (Some(at), Ok(ripple)) = (pointer_at(&pointer.track, down), ripple_image(radius, progress)) else { continue };
                    frame = unsafe { place(&ripple, at).imageByCompositingOverImage(&frame) };
                }
            }
            if let (Some((resting, pressed)), Some(at)) = (&sprites, pointer_at(&pointer.track, time)) {
                let image = match pressed { Some(pressed) if pressed_at(&pointer.presses, time) => pressed, _ => resting };
                frame = unsafe { place(image, at).imageByCompositingOverImage(&frame) };
            }
        }
        if let Some(index) = overlay_at(&moments, time) { frame = unsafe { overlays[index].1.imageByCompositingOverImage(&frame) }; }
        // Framed: the movie, marks and all, set on the canvas, showing through
        // the screen over what lies under it.
        let mut canvas = (unsafe { frame.extent() }.size.width, height);
        if let Some((under, mask, over, (x, y), size)) = &plates {
            canvas = (f64::from(size.0), f64::from(size.1));
            let placed = unsafe { frame.imageByApplyingTransform(CGAffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx: *x, ty: canvas.1 - y - height }) };
            let settings = NSDictionary::<NSString, AnyObject>::from_slices(&[&*backing, &*masking], &[&**under as &AnyObject, &**mask]);
            frame = unsafe { placed.imageByApplyingFilter_withInputParameters(&blend, &settings) };
            if let Some(over) = over { frame = unsafe { over.imageByCompositingOverImage(&frame) }; }
        }
        // Seen closer: the view cut from the canvas and brought up to fill it.
        if let Some((x, y, closer)) = camera.as_deref().and_then(|track| camera_at(track, time)) {
            let (width, height) = (canvas.0 / closer, canvas.1 / closer);
            let bottom = canvas.1 - (y - height / 2.0) - height;
            frame = unsafe {
                frame.imageByApplyingTransform(CGAffineTransform {
                    a: closer, b: 0.0, c: 0.0, d: closer, tx: -(x - width / 2.0) * closer, ty: -bottom * closer,
                })
            };
        }
        frame = unsafe { frame.imageByCroppingToRect(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(canvas.0, canvas.1))) };
        // Then fitted to what H.264 takes.
        if let Some(out) = out {
            let (kx, ky) = (f64::from(out.0) / canvas.0, f64::from(out.1) / canvas.1);
            if (kx - 1.0).abs() > 1e-9 || (ky - 1.0).abs() > 1e-9 {
                frame = unsafe { frame.imageByApplyingTransform(CGAffineTransform { a: kx, b: 0.0, c: 0.0, d: ky, tx: 0.0, ty: 0.0 }) };
            }
        }
        unsafe { request.finishWithImage_context(&frame, None) };
    });
    let (sent, received) = mpsc::channel();
    let made = RcBlock::new(move |composition: *mut AVMutableVideoComposition, error: *mut NSError| {
        // SAFETY: a valid composition or nil, retained to outlive the block.
        let _ = sent.send(unsafe { Retained::retain(composition) }.map(Carried).ok_or_else(|| described(error)));
    });
    unsafe { AVMutableVideoComposition::videoCompositionWithAsset_applyingCIFiltersWithHandler_completionHandler(asset, &applier, &made) };
    match received.recv_timeout(PATIENCE) {
        Ok(Ok(composition)) => {
            // A frame makes the picture larger than the movie it holds.
            if let Some((width, height)) = out {
                unsafe { composition.0.setRenderSize(CGSize::new(f64::from(width), f64::from(height))) };
            }
            Ok(Retained::into_super(composition.0))
        }
        Ok(Err(reason)) => Err(format!("What was drawn couldn't be put into the recording ({reason}).")),
        Err(_) => Err("Putting what was drawn into the recording took too long.".into()),
    }
}

/// The parts of the recording `timeline` keeps, one after another, as one
/// movie -- its picture and its sound -- at its speed.
fn joined(source: &AVAsset, timeline: &Timeline) -> Result<Retained<AVAsset>, String> {
    let mixed = unsafe { AVMutableComposition::composition() };
    for part in &timeline.parts {
        // Each goes on where the last ended, so the rounding of one can't
        // leave a gap before the next.
        let at = unsafe { mixed.duration() };
        // The asynchronous form is macOS 15's; this one blocks, which is what
        // a copy being made on a thread of its own wants.
        #[allow(deprecated)]
        unsafe { mixed.insertTimeRange_ofAsset_atTime_error(CMTimeRange::new(seconds(part.start), seconds(part.end - part.start)), source, at) }
            .map_err(|error| format!("The parts kept couldn't be joined ({}).", error.localizedDescription()))?;
    }
    if timeline.speed != 1.0 {
        unsafe {
            let all = CMTimeRange::new(seconds(0.0), mixed.duration());
            mixed.scaleTimeRange_toDuration(all, seconds(timeline.kept() / timeline.speed));
        }
    }
    Ok(Retained::into_super(Retained::into_super(mixed)))
}

/// A copy of the recording -- or what `timeline` keeps of it -- with `drawn`
/// drawn into its frames, written to `out`. Re-encoded, so it starts on the
/// exact frame in every player.
pub fn export(path: &Path, timeline: Option<&Timeline>, drawn: Option<&Drawn>, out: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(out);
    let (source, url) = (Retained::into_super(asset(path)?), url(out)?);
    // One part at its own speed is a range of the movie as it is; more, or
    // faster or slower, are joined into one movie.
    let (asset, trim, joins) = match timeline {
        Some(timeline) => match timeline.plain() {
            Some(trim) => (source, Some(trim), None),
            None => (joined(&source, timeline)?, None, Some(timeline.clone())),
        },
        None => (source, None, None),
    };
    let length = joins.as_ref().map(Timeline::length);
    let composition = drawn.map(|drawn| composition(&asset, drawn, joins)).transpose()?;
    let session = unsafe { AVAssetExportSession::exportSessionWithAsset_presetName(&asset, AVAssetExportPresetHighestQuality) }
        .ok_or("The recording can't be copied.")?;
    unsafe {
        session.setOutputURL(Some(&url));
        session.setOutputFileType(AVFileTypeMPEG4);
        session.setShouldOptimizeForNetworkUse(true);
        if let Some(trim) = trim { session.setTimeRange(CMTimeRange::new(seconds(trim.start), seconds(trim.end - trim.start))); }
        // Played faster, the sound runs a little past the picture; the copy
        // ends with the picture.
        if let Some(length) = length { session.setTimeRange(CMTimeRange::new(seconds(0.0), seconds(length))); }
        if let Some(composition) = &composition { session.setVideoComposition(Some(composition)); }
        // Played faster, a voice keeps its pitch.
        if let Some(spectral) = AVAudioTimePitchAlgorithmSpectral { session.setAudioTimePitchAlgorithm(spectral); }
    }
    let (sent, received) = mpsc::channel();
    let done = RcBlock::new(move || { let _ = sent.send(()); });
    unsafe { session.exportAsynchronouslyWithCompletionHandler(&done) };
    received.recv_timeout(Duration::from_secs(600)).map_err(|_| "Making the copy of the recording took too long.".to_string())?;
    if unsafe { session.status() } != AVAssetExportSessionStatus::Completed {
        let reason = unsafe { session.error() }.map(|error| error.localizedDescription().to_string()).unwrap_or_default();
        return Err(format!("The recording couldn't be copied ({reason})."));
    }
    Ok(())
}

/// The part of the recording `plan` was made for, as a GIF that loops, with
/// `drawn` drawn into it.
pub fn gif(path: &Path, plan: &GifPlan, drawn: Option<&Drawn>, out: &Path) -> Result<u64, String> {
    let generator = generator(path, Some(plan.size), plan.delay / 2.0)?;
    if let Some(drawn) = drawn {
        let asset = unsafe { generator.asset() };
        let composition = composition(&asset, drawn, None)?;
        unsafe { generator.setVideoComposition(Some(&composition)) };
    }
    let file = CFURL::from_file_path(out).ok_or("The GIF's path isn't usable.")?;
    let destination = unsafe { CGImageDestination::with_url(&file, &CFString::from_str("com.compuserve.gif"), plan.times.len(), None) }
        .ok_or("The GIF couldn't be written there.")?;
    let forever = CFNumber::new_i32(0);
    let looping = properties(&[(unsafe { kCGImagePropertyGIFLoopCount }, forever.as_ref())]);
    let whole = properties(&[(unsafe { kCGImagePropertyGIFDictionary }, looping.as_ref())]);
    unsafe { destination.set_properties(Some(whole.as_opaque())) };
    let delay = CFNumber::new_f64(plan.delay);
    let timing = properties(&[(unsafe { kCGImagePropertyGIFDelayTime }, delay.as_ref()),
                              (unsafe { kCGImagePropertyGIFUnclampedDelayTime }, delay.as_ref())]);
    let frame = properties(&[(unsafe { kCGImagePropertyGIFDictionary }, timing.as_ref())]);
    for at in &plan.times {
        unsafe { destination.add_image(&*still(&generator, *at)?, Some(frame.as_opaque())) };
    }
    if !unsafe { destination.finalize() } { return Err("The GIF couldn't be written.".into()); }
    std::fs::metadata(out).map(|made| made.len()).map_err(|e| format!("The GIF couldn't be written ({e})."))
}

/// Whether Mark may record the microphone, asking the first time. Waits for
/// the answer, so never on the main thread.
pub fn microphone() -> Result<(), String> {
    const DENIED: &str = "Mark can't use the microphone. Allow it in System Settings, under Privacy & Security, Microphone; or turn the microphone off and record again.";
    let audio = unsafe { AVMediaTypeAudio }.ok_or("AVFoundation is missing a media type.")?;
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) } {
        AVAuthorizationStatus::Authorized => Ok(()),
        AVAuthorizationStatus::NotDetermined => {
            let (sent, received) = mpsc::channel();
            let answered = RcBlock::new(move |granted: Bool| { let _ = sent.send(granted.as_bool()); });
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &answered) };
            if received.recv_timeout(Duration::from_secs(120)).unwrap_or(false) { Ok(()) } else { Err(DENIED.into()) }
        }
        _ => Err(DENIED.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trim_keeps_part_of_a_recording_or_says_why_not() {
        assert_eq!(Trim::new(1.0, 4.0, 10.0), Ok(Some(Trim { start: 1.0, end: 4.0 })));
        // Both ends where they began, or as near as a frame: all of it.
        assert_eq!(Trim::new(0.0, 10.0, 10.0), Ok(None));
        assert_eq!(Trim::new(0.02, 9.97, 10.0), Ok(None));
        // An end past the last frame is the last frame.
        assert_eq!(Trim::new(2.0, 12.0, 10.0), Ok(Some(Trim { start: 2.0, end: 10.0 })));
        assert!(Trim::new(3.0, 3.2, 10.0).unwrap_err().contains("half a second"));
        for (start, end) in [(4.0, 2.0), (-1.0, 2.0), (f64::NAN, 2.0), (0.0, f64::INFINITY)] {
            assert!(Trim::new(start, end, 10.0).is_err(), "{start}..{end}");
        }
    }

    #[test]
    fn a_gif_is_fifteen_frames_a_second_at_point_size_within_its_limit() {
        let plan = gif_plan(&Timeline { parts: vec![Trim { start: 1.0, end: 3.0 }], speed: 1.0 }, (1280, 800), 2.0, false);
        assert_eq!(plan.times.len(), 30);
        assert_eq!(plan.times[0], 1.0);
        assert!((plan.times[29] - (1.0 + 29.0 / 15.0)).abs() < 1e-9);
        assert_eq!(plan.size, (640.0, 400.0));
        // A whole Retina display: points, then down to the limit.
        assert_eq!(gif_plan(&Timeline { parts: vec![Trim { start: 0.0, end: 1.0 }], speed: 1.0 }, (3024, 1964), 2.0, false).size, (1280.0, 831.0));
        // However short, one frame.
        assert_eq!(gif_plan(&Timeline { parts: vec![Trim { start: 0.0, end: 0.01 }], speed: 1.0 }, (100, 100), 1.0, false).times, [0.0]);
    }

    /// A two-second clip, 320 × 200 with a tone, made by ffmpeg: AVFoundation
    /// itself reads it, as it will a recording.
    fn clip() -> std::path::PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/clip.mp4") }

    #[test]
    fn a_recording_says_how_long_and_big_it_is_and_whether_it_has_sound() {
        let read = info(&clip()).unwrap();
        assert!((read.duration - 2.0).abs() < 0.05, "{read:?}");
        assert_eq!((read.width, read.height, read.sound), (320, 200, true));
        assert!(info(Path::new("/nonexistent/clip.mp4")).is_err());
    }

    #[test]
    fn its_poster_is_a_full_size_png_and_its_strip_small_jpegs() {
        let png = poster(&clip()).unwrap();
        assert_eq!(crate::capture::validate_png(&png), Ok((320, 200)));
        let strip = frames(&clip(), 2.0, 6, 40.0).unwrap();
        assert_eq!(strip.len(), 6);
        assert!(strip.iter().all(|jpeg| jpeg.starts_with(&[0xFF, 0xD8])), "every frame is a JPEG");
    }

    #[test]
    fn a_trim_is_written_as_its_own_mp4_of_that_length() {
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("trimmed.mp4");
        export(&clip(), Some(&Timeline { parts: vec![Trim { start: 0.5, end: 1.5 }], speed: 1.0 }), None, &out).unwrap();
        let trimmed = info(&out).unwrap();
        assert!((trimmed.duration - 1.0).abs() < 0.1, "{trimmed:?}");
        assert_eq!((trimmed.width, trimmed.height), (320, 200));
        // Trimmed again over the last, as a new trim of the same recording is.
        export(&clip(), Some(&Timeline { parts: vec![Trim { start: 0.0, end: 0.6 }], speed: 1.0 }), None, &out).unwrap();
        assert!((info(&out).unwrap().duration - 0.6).abs() < 0.1);
    }

    #[test]
    fn a_gif_has_a_frame_for_each_fifteenth_of_a_second_and_loops() {
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("clip.gif");
        let plan = gif_plan(&Timeline { parts: vec![Trim { start: 0.0, end: 1.0 }], speed: 1.0 }, (320, 200), 1.0, false);
        gif(&clip(), &plan, None, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        // ImageIO labels its GIFs 87a whatever they hold; every reader plays them.
        assert!(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"));
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 320);
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 200);
        // NETSCAPE2.0 is the extension that makes a GIF loop.
        assert!(bytes.windows(11).any(|w| w == b"NETSCAPE2.0"));
        // One graphic control block per frame.
        assert_eq!(bytes.windows(3).filter(|w| w == &[0x21, 0xF9, 0x04]).count(), 15);
    }

    /// The colour of one pixel of the frame `at` seconds into a movie.
    fn pixel(path: &Path, at: f64, x: usize, y: usize) -> [i32; 3] {
        let png = encode(&*still(&generator(path, None, 0.0).unwrap(), at).unwrap(), "public.png", None).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let frame = reader.next_frame(&mut pixels).unwrap();
        let at = (y * frame.width as usize + x) * frame.color_type.samples();
        [pixels[at], pixels[at + 1], pixels[at + 2]].map(i32::from)
    }

    /// A 320 × 200 picture, clear but for a square of one colour.
    /// A picture `width` × `height`, each pixel as `paint` says.
    fn picture(width: usize, height: usize, paint: impl Fn(usize, usize) -> [u8; 4]) -> Vec<u8> {
        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in 0..height { for x in 0..width { rgba.extend(paint(x, y)); } }
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&rgba).unwrap();
        png
    }

    /// The clip framed on a 400 × 280 canvas, 40 in from the left and 40
    /// down: green under it, and a screen with square corners.
    fn plates(size: (usize, usize), at: (usize, usize)) -> Plates {
        let inside = |x: usize, y: usize| x >= at.0 && x < at.0 + 320 && y >= at.1 && y < at.1 + 200;
        Plates {
            size: (size.0 as u32, size.1 as u32), at: (at.0 as f64, at.1 as f64),
            under: picture(size.0, size.1, |_, _| [20, 200, 60, 255]),
            mask: picture(size.0, size.1, |x, y| if inside(x, y) { [255, 255, 255, 255] } else { [0, 0, 0, 0] }),
            over: None,
        }
    }

    #[test]
    fn a_framed_copy_is_the_canvas_with_the_recording_set_on_it() {
        let folder = tempfile::tempdir().unwrap();
        let (plain, framed) = (folder.path().join("plain.mp4"), folder.path().join("framed.mp4"));
        export(&clip(), None, Some(&Drawn::default()), &plain).unwrap();
        let drawn = Drawn { frame: Some(plates((400, 280), (40, 40))), ..Drawn::default() };
        assert_eq!(output_size(Some(&drawn), (320, 200)), (400, 280));
        export(&clip(), None, Some(&drawn), &framed).unwrap();
        let read = info(&framed).unwrap();
        assert_eq!((read.width, read.height), (400, 280));
        // What lies under it round the edge, the recording in the middle.
        let green = pixel(&framed, 1.0, 10, 10);
        assert!(green[1] > 150 && green[0] < 80 && green[2] < 110, "{green:?}");
        // (Inside the clip's colour bars, not on an edge, where H.264 blurs colour.)
        for (x, y) in [(60, 30), (250, 160)] {
            let (there, was) = (pixel(&framed, 1.0, x + 40, y + 40), pixel(&plain, 1.0, x, y));
            assert!(apart(there, was) < 14, "{there:?} where the recording has {was:?}");
        }
        assert!(apart(pixel(&framed, 1.0, 50, 50), pixel(&plain, 1.0, 10, 10)) < 14, "its corner where it was put");
    }

    #[test]
    fn the_camera_is_between_its_samples_and_the_whole_picture_outside_them() {
        let track = [(2.0, 500.0, 300.0, 1.0), (2.1, 600.0, 300.0, 1.5), (2.2, 700.0, 300.0, 2.0), (6.0, 500.0, 300.0, 1.0)];
        let (x, y, scale) = camera_at(&track, 2.15).unwrap();
        assert!((x - 650.0).abs() < 1e-9 && y == 300.0 && (scale - 1.75).abs() < 1e-9);
        assert_eq!(camera_at(&track, 2.2), Some((700.0, 300.0, 2.0)));
        // Between two zooms, and before and after them: the whole picture.
        assert_eq!(camera_at(&track, 4.0), None);
        assert_eq!(camera_at(&track, 1.0), None);
        assert_eq!(camera_at(&track, 6.0), None);
        assert_eq!(camera_at(&track, 2.0), None, "at its very start it is still the whole");
        assert_eq!(camera_at(&[], 1.0), None);
    }

    #[test]
    fn a_zoom_brings_the_view_up_to_fill_the_picture() {
        let folder = tempfile::tempdir().unwrap();
        let (plain, zoomed) = (folder.path().join("plain.mp4"), folder.path().join("zoomed.mp4"));
        export(&clip(), None, Some(&Drawn::default()), &plain).unwrap();
        // 2× from 0.5 s to 1.5 s, looking at 100, 60: the view is 0 to 160
        // across and 0 to 100 down, so 40, 30 in the copy is 20, 15 in the clip.
        let camera: Vec<_> = (0..=30).map(|i| (0.5 + f64::from(i) / 30.0, 100.0, 60.0, 2.0)).collect();
        export(&clip(), None, Some(&Drawn { camera: Some(camera), ..Drawn::default() }), &zoomed).unwrap();
        assert_eq!((info(&zoomed).unwrap().width, info(&zoomed).unwrap().height), (320, 200));
        // (Inside the clip's colour bars: a zoom softens their edges.)
        for (x, y) in [(60, 60), (260, 150), (300, 180)] {
            let (there, was) = (pixel(&zoomed, 1.0, x, y), pixel(&plain, 1.0, x / 2 + 20, y / 2 + 10));
            assert!(apart(there, was) < 16, "{there:?} at {x}, {y} where the clip has {was:?}");
        }
        // Outside the zoom, the whole picture as it was.
        assert!(apart(pixel(&zoomed, 1.8, 260, 150), pixel(&plain, 1.8, 260, 150)) < 14);
    }

    #[test]
    fn what_goes_over_a_framed_recording_is_over_it_and_nowhere_else() {
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("island.mp4");
        // A black pill over the top middle of the screen, as a phone's island is.
        let mut plates = plates((400, 280), (40, 40));
        plates.over = Some(picture(400, 280, |x, y| if (170..230).contains(&x) && (48..62).contains(&y) { [0, 0, 0, 255] } else { [0, 0, 0, 0] }));
        export(&clip(), None, Some(&Drawn { frame: Some(plates), ..Drawn::default() }), &out).unwrap();
        let island = pixel(&out, 1.0, 200, 55);
        assert!(island.iter().all(|value| *value < 30), "black where it goes: {island:?}");
        // Elsewhere, the movie as it was set.
        let plain = folder.path().join("plain.mp4");
        export(&clip(), None, Some(&Drawn::default()), &plain).unwrap();
        assert!(apart(pixel(&out, 1.0, 100, 70), pixel(&plain, 1.0, 60, 30)) < 14);
    }

    #[test]
    fn a_frame_larger_than_h264_takes_is_fitted_in_even_pixels() {
        let big = Drawn { frame: Some(Plates { size: (5001, 3000), at: (0.0, 0.0), under: vec![], mask: vec![], over: None }), ..Drawn::default() };
        let (width, height) = output_size(Some(&big), (320, 200));
        assert!(width <= 3840 && height <= 2160 && width % 2 == 0 && height % 2 == 0, "{width} × {height}");
        assert!(((width as f64 / height as f64) - 5001.0 / 3000.0).abs() < 0.01);
        assert_eq!(output_size(None, (320, 200)), (320, 200));
    }

    fn square(colour: [u8; 3], from: usize, to: usize) -> Vec<u8> {
        let mut rgba = vec![0u8; 320 * 200 * 4];
        for y in from..to { for x in from..to { rgba[(y * 320 + x) * 4..][..4].copy_from_slice(&[colour[0], colour[1], colour[2], 255]); } }
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, 320, 200);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&rgba).unwrap();
        png
    }

    #[test]
    fn a_mark_is_drawn_into_the_frames_from_its_moment_and_a_trim_keeps_the_moment() {
        assert_eq!(overlay_at(&[0.0, 1.0, 2.5], 0.5), Some(0));
        assert_eq!(overlay_at(&[1.0, 2.5], 0.5), None);
        assert_eq!(overlay_at(&[1.0, 2.5], 2.5 - DUE / 2.0), Some(1), "due a frame early, not late");
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("marked.mp4");
        let drawn = Drawn { overlays: vec![(1.0, square([255, 0, 255], 20, 60))], redactions: vec![], pointer: None, frame: None, camera: None };
        // Kept from 0.5 to 1.5: the mark is drawn at 1.0 into the recording,
        // which is 0.5 into the copy.
        export(&clip(), Some(&Timeline { parts: vec![Trim { start: 0.5, end: 1.5 }], speed: 1.0 }), Some(&drawn), &out).unwrap();
        assert!((info(&out).unwrap().duration - 1.0).abs() < 0.1);
        let magenta = |[r, g, b]: [i32; 3]| r > 200 && g < 90 && b > 200;
        assert!(!magenta(pixel(&out, 0.2, 40, 40)), "not yet: {:?}", pixel(&out, 0.2, 40, 40));
        assert!(magenta(pixel(&out, 0.8, 40, 40)), "drawn by then: {:?}", pixel(&out, 0.8, 40, 40));
        // Only where it was drawn.
        assert!(!magenta(pixel(&out, 0.8, 200, 150)));
    }

    #[test]
    fn a_redaction_is_pixelated_in_every_frame_from_its_moment() {
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("hidden.mp4");
        // Core Image's blocks are laid from 150, 150 up from the bottom left, so
        // 150 to 190 across and 50 to 90 down from the top is one whole block.
        let part = Hidden { x: 100.0, y: 40.0, width: 120.0, height: 120.0, at: 0.0, until: None, block: 40.0 };
        export(&clip(), None, Some(&Drawn { overlays: vec![], redactions: vec![part], pointer: None, frame: None, camera: None }), &out).unwrap();
        for at in [0.3, 1.6] {
            let (one, other) = (pixel(&out, at, 154, 54), pixel(&out, at, 186, 86));
            assert!(one.iter().zip(other).all(|(a, b)| (a - b).abs() < 14), "one block, one colour at {at}s: {one:?} {other:?}");
        }
    }

    #[test]
    fn a_timeline_keeps_the_parts_between_the_handles_and_outside_the_cuts() {
        let parts = |timeline: &Timeline| timeline.parts.iter().map(|part| (part.start, part.end)).collect::<Vec<_>>();
        let timeline = Timeline::new(0.0, 2.0, &[(0.5, 1.0)], 1.0, 2.0).unwrap().unwrap();
        assert_eq!(parts(&timeline), [(0.0, 0.5), (1.0, 2.0)]);
        assert!((timeline.length() - 1.5).abs() < 1e-9);
        assert_eq!([0.25, 0.75, 1.4, 9.0].map(|time| timeline.source(time)), [0.25, 1.25, 1.9, 2.0]);
        // A trim and a cut against its start, as one part.
        assert_eq!(parts(&Timeline::new(0.4, 2.0, &[(0.4, 0.9)], 1.0, 2.0).unwrap().unwrap()), [(0.9, 2.0)]);
        assert_eq!(Timeline::new(0.0, 2.0, &[], 1.0, 2.0), Ok(None), "all of it, as made");
        assert!(Timeline::new(0.0, 2.0, &[(1.0, 1.5), (1.2, 1.8)], 1.0, 2.0).is_err(), "cuts that overlap");
        assert!(Timeline::new(0.0, 2.0, &[(1.5, 2.5)], 1.0, 2.0).is_err(), "a cut past the end");
        assert!(Timeline::new(0.0, 2.0, &[(0.2, 1.8)], 1.0, 2.0).is_err(), "too little left");
    }

    #[test]
    fn a_copy_with_a_part_cut_out_is_that_much_shorter_and_its_marks_keep_their_moments() {
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("cut.mp4");
        let timeline = Timeline::new(0.0, 2.0, &[(0.5, 1.0)], 1.0, 2.0).unwrap().unwrap();
        // Drawn 1.2 s into the recording: 0.7 s into the copy.
        let drawn = Drawn { overlays: vec![(1.2, square([255, 0, 255], 20, 60))], redactions: vec![], pointer: None, frame: None, camera: None };
        export(&clip(), Some(&timeline), Some(&drawn), &out).unwrap();
        let made = info(&out).unwrap();
        assert!((made.duration - 1.5).abs() < 0.1, "{}", made.duration);
        assert!(made.sound, "the sound is joined too");
        let magenta = |[r, g, b]: [i32; 3]| r > 200 && g < 90 && b > 200;
        assert!(!magenta(pixel(&out, 0.6, 40, 40)), "not yet: {:?}", pixel(&out, 0.6, 40, 40));
        assert!(magenta(pixel(&out, 0.85, 40, 40)), "drawn by then: {:?}", pixel(&out, 0.85, 40, 40));
        // A GIF of it skips the part cut out.
        let plan = gif_plan(&timeline, (320, 200), 1.0, false);
        assert_eq!(plan.times.len(), 23);
        assert!(plan.times.iter().all(|time| *time < 0.5 || *time >= 1.0));
    }

    #[test]
    fn at_twice_the_speed_a_copy_is_half_as_long_and_its_marks_keep_their_moments() {
        let timeline = Timeline::new(0.0, 2.0, &[], 2.0, 2.0).unwrap().unwrap();
        assert!((timeline.length() - 1.0).abs() < 1e-9);
        assert_eq!([0.0, 0.25, 0.5].map(|time| timeline.source(time)), [0.0, 0.5, 1.0]);
        assert_eq!(Timeline::new(0.0, 2.0, &[], 1.0, 2.0), Ok(None), "all of it at its own speed is the movie as made");
        assert!(Timeline::new(0.0, 2.0, &[], 9.0, 2.0).is_err());
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("fast.mp4");
        // Drawn 1.2 s into the recording: 0.6 s into a copy twice as fast.
        let drawn = Drawn { overlays: vec![(1.2, square([255, 0, 255], 20, 60))], redactions: vec![], pointer: None, frame: None, camera: None };
        export(&clip(), Some(&timeline), Some(&drawn), &out).unwrap();
        let made = info(&out).unwrap();
        assert!((made.duration - 1.0).abs() < 0.1, "{}", made.duration);
        let magenta = |[r, g, b]: [i32; 3]| r > 200 && g < 90 && b > 200;
        assert!(!magenta(pixel(&out, 0.5, 40, 40)), "not yet: {:?}", pixel(&out, 0.5, 40, 40));
        assert!(magenta(pixel(&out, 0.75, 40, 40)), "drawn by then: {:?}", pixel(&out, 0.75, 40, 40));
        // Its GIF has half the frames, each still a fifteenth of a second.
        assert_eq!(gif_plan(&timeline, (320, 200), 1.0, false).times.len(), 15);
    }

    #[test]
    fn a_small_gif_is_fewer_frames_at_no_more_than_640_across() {
        let plan = gif_plan(&Timeline::whole(2.0), (3024, 1964), 2.0, true);
        assert_eq!(plan.size, (640.0, 416.0));
        assert_eq!(plan.times.len(), 20);
        assert!((plan.delay - 0.1).abs() < 1e-9);
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("small.gif");
        let bytes = gif(&clip(), &gif_plan(&Timeline::whole(1.0), (320, 200), 1.0, true), None, &out).unwrap();
        assert_eq!(bytes, std::fs::metadata(&out).unwrap().len());
        assert!(bytes > 0);
    }

    #[test]
    fn the_pointer_is_where_it_was_between_two_moments_and_nowhere_once_the_track_runs_out() {
        let track = [(0.0, 10.0, 10.0), (0.1, 20.0, 30.0), (1.0, 90.0, 90.0)];
        assert_eq!(pointer_at(&track, 0.05), Some((15.0, 20.0)));
        assert_eq!(pointer_at(&track, 0.0), Some((10.0, 10.0)));
        // Too long between two moments to say where it went: where it was, for a while.
        assert_eq!(pointer_at(&track, 0.2), Some((20.0, 30.0)));
        assert_eq!(pointer_at(&track, 0.5), None);
        assert_eq!(pointer_at(&track, 1.1), Some((90.0, 90.0)));
        assert_eq!(pointer_at(&track, 2.0), None);
        assert_eq!(pointer_at(&track, -1.0), None);
        assert_eq!(pointer_at(&[], 0.0), None);
    }

    #[test]
    fn a_halo_follows_the_pointer_into_the_frames_and_nowhere_else() {
        let folder = tempfile::tempdir().unwrap();
        let (plain, haloed) = (folder.path().join("plain.mp4"), folder.path().join("halo.mp4"));
        let track: Vec<_> = (0..60).map(|frame| (frame as f64 / 30.0, 100.0, 80.0)).collect();
        // Made the same way with nothing drawn, so only what is drawn differs.
        export(&clip(), None, Some(&Drawn::default()), &plain).unwrap();
        let pointer = Pointer { track, presses: vec![], shape: Some(Shape::Halo(28.0)), ripple: None };
        export(&clip(), None, Some(&Drawn { pointer: Some(pointer), ..Drawn::default() }), &haloed).unwrap();
        let (under, bare) = (pixel(&haloed, 1.0, 100, 80), pixel(&plain, 1.0, 100, 80));
        assert!(apart(under, bare) > 25, "tinted at the pointer: {under:?} over {bare:?}");
        assert!(under[0] >= bare[0] - 4 && under[2] <= bare[2] + 4, "towards yellow: {under:?} over {bare:?}");
        assert!(apart(pixel(&haloed, 1.0, 290, 20), pixel(&plain, 1.0, 290, 20)) < 14, "and not far from it");
    }

    #[test]
    fn a_press_shows_while_the_button_is_down_and_a_tap_for_long_enough_to_see() {
        let presses = [(1.0, 1.5), (2.0, 2.01)];
        assert!(!pressed_at(&presses, 0.9) && pressed_at(&presses, 1.0) && pressed_at(&presses, 1.4) && !pressed_at(&presses, 1.6));
        // A tap a hundredth of a second long is shown pressed for longer.
        assert!(pressed_at(&presses, 2.1) && !pressed_at(&presses, 2.0 + PRESS_SHORTEST + 0.01));
        // A ripple starts as the button goes down, and runs its own time
        // however long the press.
        assert_eq!(ripples_at(&presses, 0.99), vec![]);
        assert_eq!(ripples_at(&presses, 1.0), vec![(1.0, 0.0)]);
        let [(down, progress)] = ripples_at(&presses, 1.0 + RIPPLE_TIME / 2.0)[..] else { panic!("one ripple") };
        assert!(down == 1.0 && (progress - 0.5).abs() < 1e-9);
        assert_eq!(ripples_at(&presses, 1.0 + RIPPLE_TIME), vec![]);
        // Spreading from a third of its width, quickly at first, fading as it goes.
        assert_eq!(ripple_shape(0.0), (0.35, 1.0));
        assert_eq!(ripple_shape(1.0), (1.0, 0.0));
        assert!(ripple_shape(0.5).0 > 0.35 + 0.65 * 0.5, "past halfway at half time");
    }

    /// How far apart two colours are, in the one channel they differ most in.
    fn apart(a: [i32; 3], b: [i32; 3]) -> i32 { a.iter().zip(b).map(|(a, b)| (a - b).abs()).max().unwrap() }

    #[test]
    fn a_fingertip_follows_the_pointer_and_presses_in_while_the_button_is_down() {
        let folder = tempfile::tempdir().unwrap();
        let (plain, touched) = (folder.path().join("plain.mp4"), folder.path().join("touch.mp4"));
        let track: Vec<_> = (0..60).map(|frame| (frame as f64 / 30.0, 100.0, 80.0)).collect();
        // Made the same way with nothing drawn, so only what is drawn differs.
        export(&clip(), None, Some(&Drawn::default()), &plain).unwrap();
        let pointer = Pointer { track, presses: vec![(1.0, 1.5)], shape: Some(Shape::Touch(20.0)), ripple: None };
        export(&clip(), None, Some(&Drawn { pointer: Some(pointer), ..Drawn::default() }), &touched).unwrap();
        let (resting, pressed) = (pixel(&touched, 0.6, 100, 80), pixel(&touched, 1.2, 100, 80));
        let (bare_then, bare_now) = (pixel(&plain, 0.6, 100, 80), pixel(&plain, 1.2, 100, 80));
        assert!(apart(resting, bare_then) > 12, "grey at the pointer: {resting:?} over {bare_then:?}");
        assert!(apart(pressed, bare_now) > apart(resting, bare_then) + 6, "and more so pressed: {pressed:?} over {bare_now:?}");
        // Grey: the three channels drawn closer together than they were.
        let spread = |c: [i32; 3]| c.iter().max().unwrap() - c.iter().min().unwrap();
        assert!(spread(pressed) < spread(bare_now), "{pressed:?} over {bare_now:?}");
        assert!(apart(pixel(&touched, 1.2, 290, 20), pixel(&plain, 1.2, 290, 20)) < 14, "and nowhere else");
    }

    #[test]
    fn a_ripple_spreads_from_where_the_button_went_down_and_is_gone_after() {
        let folder = tempfile::tempdir().unwrap();
        let (plain, rippled) = (folder.path().join("plain.mp4"), folder.path().join("ripple.mp4"));
        // Pressed at 100, 80; the pointer moves off as the ripple spreads.
        let track: Vec<_> = (0..60).map(|frame| (frame as f64 / 30.0, if frame < 31 { 100.0 } else { 220.0 }, 80.0)).collect();
        // Made the same way with nothing drawn, so only what is drawn differs.
        export(&clip(), None, Some(&Drawn::default()), &plain).unwrap();
        let pointer = Pointer { track, presses: vec![(1.0, 1.05)], shape: None, ripple: Some(30.0) };
        export(&clip(), None, Some(&Drawn { pointer: Some(pointer), ..Drawn::default() }), &rippled).unwrap();
        // Halfway, the ring is some 20 to 25 pixels out from where it was
        // pressed, and the middle is left alone.
        let at = 1.0 + RIPPLE_TIME / 2.0;
        let change = |x: usize, t: f64| apart(pixel(&rippled, t, x, 80), pixel(&plain, t, x, 80));
        let ring = (104..140).max_by_key(|&x| change(x, at)).unwrap();
        assert!(change(ring, at) > 12 && (115..=130).contains(&ring), "a ring {} out, {} strong", ring - 100, change(ring, at));
        assert!(change(100, at) < 10, "not in the middle");
        assert!(change(ring, 1.7) < 10, "gone once it has run");
    }

    #[test]
    fn a_redaction_with_an_end_is_pixelated_until_it_and_not_after() {
        let part = Hidden { x: 100.0, y: 40.0, width: 120.0, height: 120.0, at: 0.5, until: Some(1.2), block: 40.0 };
        assert!(!part.due(0.3) && part.due(0.6) && part.due(1.1) && !part.due(1.5));
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("hidden.mp4");
        export(&clip(), None, Some(&Drawn { overlays: vec![], redactions: vec![part], pointer: None, frame: None, camera: None }), &out).unwrap();
        let blocky = |at: f64| {
            let (one, other) = (pixel(&out, at, 154, 54), pixel(&out, at, 186, 86));
            one.iter().zip(other).all(|(a, b)| (a - b).abs() < 14)
        };
        assert!(blocky(0.8), "pixelated in its time");
        assert!(!blocky(1.6), "and not after it: {:?} {:?}", pixel(&out, 1.6, 154, 54), pixel(&out, 1.6, 186, 86));
    }
}
