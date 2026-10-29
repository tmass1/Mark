//! A finished recording, read back with AVFoundation: how long and how big it
//! is, a still of it for the editor and Recent, a strip of small frames to trim
//! against, and a copy of it -- trimmed, with what was drawn on it drawn into
//! its frames by Core Image -- as an MP4, or as a GIF written with ImageIO. And
//! whether Mark may use the microphone, which AVFoundation also answers.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{AVAsset, AVAssetExportPresetHighestQuality, AVAssetExportSession, AVAssetExportSessionStatus,
                          AVAssetImageGenerator, AVAssetTrack, AVAsynchronousCIImageFilteringRequest, AVAuthorizationStatus,
                          AVCaptureDevice, AVFileTypeMPEG4, AVMediaTypeAudio, AVMediaTypeVideo, AVURLAsset, AVVideoComposition};
use objc2_core_foundation::{CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CFType, CFURL, CGPoint, CGRect, CGSize};
use objc2_core_image::CIImage;
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
/// to send for what they show.
const GIF_RATE: f64 = 15.0;
const GIF_LONGEST: f64 = 1280.0;
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
pub struct Drawn { pub overlays: Vec<(f64, Vec<u8>)>, pub redactions: Vec<Hidden> }

/// A part to pixelate, in the recording's pixels from its top left, from `at`
/// seconds in, in blocks `block` pixels across.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Hidden { pub x: f64, pub y: f64, pub width: f64, pub height: f64, pub at: f64, pub block: f64 }

/// A copy of a recording as asked for: part of it or all of it, and with what
/// was drawn on it -- told apart by a fingerprint -- or not.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edit { pub trim: Option<Trim>, pub marks: Option<u64> }

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

/// The frames a GIF of `trim` is made of, how long each shows, and the largest
/// each may be, in pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct GifPlan { pub times: Vec<f64>, pub delay: f64, pub size: (f64, f64) }

pub fn gif_plan(trim: Trim, pixels: (u32, u32), scale: f64) -> GifPlan {
    let delay = 1.0 / GIF_RATE;
    let count = (((trim.end - trim.start) / delay).round() as usize).max(1);
    let times = (0..count).map(|index| trim.start + index as f64 * delay).collect();
    let (width, height) = (f64::from(pixels.0) / scale.max(1.0), f64::from(pixels.1) / scale.max(1.0));
    let fit = (GIF_LONGEST / width.max(height)).min(1.0);
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
fn composition(asset: &AVAsset, drawn: &Drawn) -> Result<Retained<AVVideoComposition>, String> {
    let mut overlays = drawn.overlays.iter()
        .map(|(at, png)| unsafe { CIImage::imageWithData(&NSData::with_bytes(png)) }.map(|image| (*at, image)))
        .collect::<Option<Vec<_>>>().ok_or("What was drawn on the recording couldn't be read.")?;
    overlays.sort_by(|a, b| a.0.total_cmp(&b.0));
    let moments: Vec<f64> = overlays.iter().map(|(at, _)| *at).collect();
    let hidden = drawn.redactions.clone();
    let pixellate = NSString::from_str("CIPixellate");
    let scale = NSString::from_str("inputScale");
    let applier = RcBlock::new(move |request: NonNull<AVAsynchronousCIImageFilteringRequest>| {
        // SAFETY: AVFoundation hands over a live request for each frame.
        let request = unsafe { request.as_ref() };
        let time = unsafe { request.compositionTime().seconds() };
        let mut frame = unsafe { request.sourceImage() };
        let height = unsafe { frame.extent() }.size.height;
        for part in hidden.iter().filter(|part| part.at <= time + DUE) {
            let area = flipped(part, height);
            let block = NSNumber::new_f64(part.block.max(2.0));
            let settings = NSDictionary::<NSString, AnyObject>::from_slices(&[&*scale], &[&*block as &AnyObject]);
            frame = unsafe {
                frame.imageByCroppingToRect(area).imageByClampingToExtent()
                    .imageByApplyingFilter_withInputParameters(&pixellate, &settings)
                    .imageByCroppingToRect(area).imageByCompositingOverImage(&frame)
            };
        }
        if let Some(index) = overlay_at(&moments, time) { frame = unsafe { overlays[index].1.imageByCompositingOverImage(&frame) }; }
        unsafe { request.finishWithImage_context(&frame, None) };
    });
    let (sent, received) = mpsc::channel();
    let made = RcBlock::new(move |composition: *mut AVVideoComposition, error: *mut NSError| {
        // SAFETY: a valid composition or nil, retained to outlive the block.
        let _ = sent.send(unsafe { Retained::retain(composition) }.map(Carried).ok_or_else(|| described(error)));
    });
    unsafe { AVVideoComposition::videoCompositionWithAsset_applyingCIFiltersWithHandler_completionHandler(asset, &applier, &made) };
    match received.recv_timeout(PATIENCE) {
        Ok(Ok(composition)) => Ok(composition.0),
        Ok(Err(reason)) => Err(format!("What was drawn couldn't be put into the recording ({reason}).")),
        Err(_) => Err("Putting what was drawn into the recording took too long.".into()),
    }
}

/// A copy of the recording -- or the part `trim` keeps -- with `drawn` drawn
/// into its frames, written to `out`. Re-encoded, so it starts on the exact
/// frame in every player.
pub fn export(path: &Path, trim: Option<Trim>, drawn: Option<&Drawn>, out: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(out);
    let (asset, url) = (asset(path)?, url(out)?);
    let composition = drawn.map(|drawn| composition(&asset, drawn)).transpose()?;
    let session = unsafe { AVAssetExportSession::exportSessionWithAsset_presetName(&asset, AVAssetExportPresetHighestQuality) }
        .ok_or("The recording can't be copied.")?;
    unsafe {
        session.setOutputURL(Some(&url));
        session.setOutputFileType(AVFileTypeMPEG4);
        session.setShouldOptimizeForNetworkUse(true);
        if let Some(trim) = trim { session.setTimeRange(CMTimeRange::new(seconds(trim.start), seconds(trim.end - trim.start))); }
        if let Some(composition) = &composition { session.setVideoComposition(Some(composition)); }
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
pub fn gif(path: &Path, plan: &GifPlan, drawn: Option<&Drawn>, out: &Path) -> Result<(), String> {
    let generator = generator(path, Some(plan.size), plan.delay / 2.0)?;
    if let Some(drawn) = drawn {
        let asset = unsafe { generator.asset() };
        let composition = composition(&asset, drawn)?;
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
    Ok(())
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
        let plan = gif_plan(Trim { start: 1.0, end: 3.0 }, (1280, 800), 2.0);
        assert_eq!(plan.times.len(), 30);
        assert_eq!(plan.times[0], 1.0);
        assert!((plan.times[29] - (1.0 + 29.0 / 15.0)).abs() < 1e-9);
        assert_eq!(plan.size, (640.0, 400.0));
        // A whole Retina display: points, then down to the limit.
        assert_eq!(gif_plan(Trim { start: 0.0, end: 1.0 }, (3024, 1964), 2.0).size, (1280.0, 831.0));
        // However short, one frame.
        assert_eq!(gif_plan(Trim { start: 0.0, end: 0.01 }, (100, 100), 1.0).times, [0.0]);
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
        export(&clip(), Some(Trim { start: 0.5, end: 1.5 }), None, &out).unwrap();
        let trimmed = info(&out).unwrap();
        assert!((trimmed.duration - 1.0).abs() < 0.1, "{trimmed:?}");
        assert_eq!((trimmed.width, trimmed.height), (320, 200));
        // Trimmed again over the last, as a new trim of the same recording is.
        export(&clip(), Some(Trim { start: 0.0, end: 0.6 }), None, &out).unwrap();
        assert!((info(&out).unwrap().duration - 0.6).abs() < 0.1);
    }

    #[test]
    fn a_gif_has_a_frame_for_each_fifteenth_of_a_second_and_loops() {
        let folder = tempfile::tempdir().unwrap();
        let out = folder.path().join("clip.gif");
        let plan = gif_plan(Trim { start: 0.0, end: 1.0 }, (320, 200), 1.0);
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
        let drawn = Drawn { overlays: vec![(1.0, square([255, 0, 255], 20, 60))], redactions: vec![] };
        // Kept from 0.5 to 1.5: the mark is drawn at 1.0 into the recording,
        // which is 0.5 into the copy.
        export(&clip(), Some(Trim { start: 0.5, end: 1.5 }), Some(&drawn), &out).unwrap();
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
        let part = Hidden { x: 100.0, y: 40.0, width: 120.0, height: 120.0, at: 0.0, block: 40.0 };
        export(&clip(), None, Some(&Drawn { overlays: vec![], redactions: vec![part] }), &out).unwrap();
        for at in [0.3, 1.6] {
            let (one, other) = (pixel(&out, at, 154, 54), pixel(&out, at, 186, 86));
            assert!(one.iter().zip(other).all(|(a, b)| (a - b).abs() < 14), "one block, one colour at {at}s: {one:?} {other:?}");
        }
    }
}
