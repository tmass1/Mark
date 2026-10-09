//! What Vision sees in a capture, on the Mac -- the same recognition Live Text
//! uses -- so a screenshot never leaves the Mac to be read: the lines of text
//! and where each word is, for Copy Text, and the faces too, for Hide
//! Sensitive. The editor decides what to make of them.

use objc2::rc::{autoreleasepool, Retained};
use objc2::{msg_send, AnyThread};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSRange};
use objc2_vision::{VNDetectFaceRectanglesRequest, VNImageRequestHandler, VNRecognizeTextRequest, VNRectangleObservation, VNRequest,
                   VNRequestTextRecognitionLevel};
use serde::Serialize;

/// A box in the image's pixels, from its top left, as the editor draws in.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Area { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Word { pub text: String, #[serde(flatten)] pub at: Area }

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Line { pub text: String, #[serde(flatten)] pub at: Area, pub words: Vec<Word> }

/// Everything Hide Sensitive looks through: the words, and the faces.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Scan { pub lines: Vec<Line>, pub faces: Vec<Area> }

/// Vision measures as a share of the image, from its bottom left.
fn to_pixels(rect: objc2_core_foundation::CGRect, width: f64, height: f64) -> Area {
    Area { x: rect.origin.x * width, y: (1.0 - rect.origin.y - rect.size.height) * height,
          width: rect.size.width * width, height: rect.size.height * height }
}

/// Each run of non-space characters, with where it starts and how long it is
/// in UTF-16, which is how NSString counts.
fn words_in(text: &str) -> Vec<(String, usize, usize)> {
    let mut words = Vec::new();
    let (mut start, mut current) = (0, String::new());
    let mut offset = 0;
    for c in text.chars() {
        if c.is_whitespace() {
            if !current.is_empty() { let length = current.encode_utf16().count(); words.push((std::mem::take(&mut current), start, length)); }
        } else {
            if current.is_empty() { start = offset; }
            current.push(c);
        }
        offset += c.len_utf16();
    }
    if !current.is_empty() { let length = current.encode_utf16().count(); words.push((current, start, length)); }
    words
}

/// Where a word sits when Vision will not say: its share of the line, by
/// characters. Rough in a proportional font, but enough to tell which side of
/// a box's edge a word is on.
fn estimated(line: Area, start: usize, length: usize, total: usize) -> Area {
    let total = total.max(1) as f64;
    Area { x: line.x + line.width * start as f64 / total, y: line.y, width: line.width * length as f64 / total, height: line.height }
}

/// Every line of text in a PNG of the given size, top candidate only.
pub fn recognize(png: &[u8], width: u32, height: u32) -> Result<Vec<Line>, String> {
    scan(png, width, height, false).map(|scan| scan.lines)
}

/// The text, and -- asked for -- the faces, in one pass over the image.
pub fn scan(png: &[u8], width: u32, height: u32, faces: bool) -> Result<Scan, String> {
    let (width, height) = (f64::from(width), f64::from(height));
    autoreleasepool(|_| {
        let data = NSData::with_bytes(png);
        let handler = VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &NSDictionary::new());
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        request.setAutomaticallyDetectsLanguage(true);
        let face_request = faces.then(|| unsafe { VNDetectFaceRectanglesRequest::new() });
        let mut requests: Vec<Retained<VNRequest>> = vec![Retained::into_super(Retained::into_super(request.clone()))];
        if let Some(face_request) = &face_request { requests.push(Retained::into_super(Retained::into_super(face_request.clone()))); }
        handler.performRequests_error(&NSArray::from_retained_slice(&requests))
            .map_err(|error| format!("The image couldn't be read ({}).", error.localizedDescription()))?;
        let found_faces = face_request.iter()
            .flat_map(|face_request| unsafe { face_request.results() }.into_iter().flat_map(|results| results.to_vec()))
            .map(|face| to_pixels(unsafe { face.boundingBox() }, width, height))
            .collect();
        let mut lines = Vec::new();
        for observation in request.results().iter().flat_map(|results| results.iter()) {
            let Some(best) = observation.topCandidates(1).firstObject() else { continue };
            let text = best.string().to_string();
            if text.trim().is_empty() { continue; }
            let at = to_pixels(unsafe { observation.boundingBox() }, width, height);
            let total = text.encode_utf16().count();
            let words = words_in(&text).into_iter().map(|(word, start, length)| {
                let found: Result<Retained<VNRectangleObservation>, Retained<NSError>> =
                    unsafe { msg_send![&*best, boundingBoxForRange: NSRange::new(start, length), error: _] };
                let at = found.map(|rect| to_pixels(unsafe { rect.boundingBox() }, width, height))
                    .unwrap_or_else(|_| estimated(at, start, length, total));
                Word { text: word, at }
            }).collect();
            lines.push(Line { text, at, words });
        }
        Ok(Scan { lines, faces: found_faces })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_found_by_where_they_start_in_utf16() {
        assert_eq!(words_in("  Copy text\tnow "), [("Copy".into(), 2, 4), ("text".into(), 7, 4), ("now".into(), 12, 3)]);
        // An emoji is two UTF-16 units, so what follows it starts two along.
        assert_eq!(words_in("👋 hi"), [("👋".into(), 0, 2), ("hi".into(), 3, 2)]);
        assert!(words_in("   ").is_empty());
    }

    #[test]
    fn a_box_from_vision_is_turned_the_right_way_up() {
        let rect = objc2_core_foundation::CGRect::new(objc2_core_foundation::CGPoint::new(0.25, 0.75),
                                                      objc2_core_foundation::CGSize::new(0.5, 0.125));
        assert_eq!(to_pixels(rect, 800.0, 400.0), Area { x: 200.0, y: 50.0, width: 400.0, height: 50.0 });
    }

    /// Vision itself, on two lines macOS drew: the words, in order, each with a
    /// box that sits inside its line's.
    #[test]
    fn reads_the_lines_in_an_image() {
        let png = include_bytes!("../tests/text.png");
        let lines = recognize(png, 640, 200).unwrap();
        let texts: Vec<&str> = lines.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, ["Mark reads this line", "Second line 42"]);
        let first = &lines[0];
        assert!(first.at.y < lines[1].at.y, "the first line is above the second");
        assert_eq!(first.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), ["Mark", "reads", "this", "line"]);
        for pair in first.words.windows(2) { assert!(pair[0].at.x < pair[1].at.x, "words run left to right"); }
        for word in &first.words {
            assert!(word.at.x >= first.at.x - 2.0 && word.at.x + word.at.width <= first.at.x + first.at.width + 2.0);
        }
        // Vision's own boxes, not the estimate kept for when it will not say:
        // a proportional font puts "Mark" wider than a quarter of its letters.
        let total = first.text.encode_utf16().count();
        assert!(first.words.iter().zip(words_in(&first.text))
                    .any(|(word, (_, start, length))| word.at != estimated(first.at, start, length, total)),
                "every word box was estimated: Vision's boundingBoxForRange was not used");
    }

    /// What the editor reads: a line or word is its text with x, y, width and
    /// height beside it -- the shape src/text.ts and src/sensitive.ts expect --
    /// and a scan is its lines and its faces.
    #[test]
    fn what_is_found_reaches_the_editor_in_the_shape_it_reads() {
        let at = Area { x: 1.0, y: 2.0, width: 3.0, height: 4.0 };
        let scan = Scan { lines: vec![Line { text: "hi there".into(), at, words: vec![Word { text: "hi".into(), at }] }], faces: vec![at] };
        assert_eq!(serde_json::to_value(&scan).unwrap(), serde_json::json!({
            "lines": [{ "text": "hi there", "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0,
                        "words": [{ "text": "hi", "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 }] }],
            "faces": [{ "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 }],
        }));
    }

    /// Looking for faces as well reads the same words, in the same pass, and
    /// finds no face where there is none.
    #[test]
    fn a_scan_reads_the_words_and_looks_for_faces_too() {
        let png = include_bytes!("../tests/text.png");
        let scan = scan(png, 640, 200, true).unwrap();
        assert_eq!(scan.lines, recognize(png, 640, 200).unwrap());
        assert!(scan.faces.is_empty());
    }
}
