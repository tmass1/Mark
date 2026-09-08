use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{io::Cursor, path::Path, process::{Command, Stdio}};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
pub struct Capture { pub png: Vec<u8>, pub width: u32, pub height: u32 }

/// A region in global screen points, as Mark's own selection overlay reports it.
#[derive(Clone, Copy, Debug)]
pub struct Rect { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

impl Rect {
    /// screencapture takes the rectangle as one argument, in points. The file it
    /// writes is at the display's real pixel density.
    fn argument(&self) -> String {
        format!("-R{},{},{},{}", self.x.round(), self.y.round(), self.width.round(), self.height.round())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview { pub data_url: String, pub width: u32, pub height: u32 }

impl Capture {
    pub fn preview(&self) -> Preview {
        Preview { data_url: format!("data:image/png;base64,{}", STANDARD.encode(&self.png)), width: self.width, height: self.height }
    }
}

pub fn parse_result(bytes: Option<Vec<u8>>, code: Option<i32>, stderr: &[u8]) -> Result<Option<Capture>, String> {
    let diagnostic = String::from_utf8_lossy(stderr);
    if bytes.is_none() && matches!(code, Some(0 | 1)) && diagnostic.trim().is_empty() {
        return Ok(None);
    }
    if code != Some(0) {
        eprintln!("[Mark] screenshot process: {diagnostic}");
        return Err("The screenshot couldn't be captured. Try again, or check Mark's screen access in System Settings.".into());
    }
    let bytes = bytes.ok_or("No screenshot was returned.")?;
    let (width, height) = validate_png(&bytes)?;
    Ok(Some(Capture { png: bytes, width, height }))
}

/// Decode fully, so only a complete PNG can reach the clipboard. Used for the
/// native capture and again for an edited image arriving from the editor.
pub fn validate_png(bytes: &[u8]) -> Result<(u32, u32), String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits { bytes: 256 * 1024 * 1024 });
    let mut reader = decoder.read_info().map_err(|_| "The screenshot isn't a valid PNG.")?;
    let size = reader.output_buffer_size().filter(|size| *size <= 256 * 1024 * 1024)
        .ok_or("The screenshot is too large to open.")?;
    let mut pixels = vec![0; size];
    let frame = reader.next_frame(&mut pixels).map_err(|_| "The screenshot is incomplete.")?;
    reader.finish().map_err(|_| "The screenshot is incomplete.")?;
    Ok((frame.width, frame.height))
}

/// RAII removes output on success, Escape, errors, and unwinding.
#[cfg(test)]
pub fn run_capture(executable: &Path, temporary_root: &Path) -> Result<Option<Capture>, String> {
    run_capture_cancellable(executable, temporary_root, &AtomicBool::new(false), None)
}

pub fn run_capture_cancellable(executable: &Path, temporary_root: &Path, cancelled: &AtomicBool, rect: Option<Rect>)
    -> Result<Option<Capture>, String> {
    if cancelled.load(Ordering::SeqCst) { return Ok(None); }
    let directory = tempfile::Builder::new().prefix("Mark-").tempdir_in(temporary_root).map_err(|e| e.to_string())?;
    let output_path = directory.path().join("Capture.png");
    let diagnostic_path = directory.path().join("stderr");
    let diagnostic_file = std::fs::File::create(&diagnostic_path).map_err(|e| e.to_string())?;
    // No -i: the region already came from Mark's own overlay, so screencapture
    // runs headless and returns immediately.
    let mut arguments: Vec<String> = vec!["-x".into(), "-t".into(), "png".into()];
    match rect {
        Some(rect) => arguments.push(rect.argument()),
        None => { arguments.insert(0, "-s".into()); arguments.insert(0, "-i".into()); }
    }
    let mut child = Command::new(executable).args(&arguments)
        .arg(&output_path).stdout(Stdio::null()).stderr(diagnostic_file).spawn().map_err(|e| e.to_string())?;
    let status = loop {
        if cancelled.load(Ordering::SeqCst) {
            let _ = child.kill(); let _ = child.wait(); return Ok(None);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(16)),
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
        }
    };
    let bytes = match std::fs::read(&output_path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let diagnostic = std::fs::read(diagnostic_path).map_err(|e| e.to_string())?;
    parse_result(bytes, status.code(), &diagnostic)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 12, 8);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&[255; 12 * 8 * 4]).unwrap();
        }
        bytes
    }
    #[test]
    fn original_png_and_pixel_dimensions_survive() {
        let bytes = png();
        let capture = parse_result(Some(bytes.clone()), Some(0), b"").unwrap().unwrap();
        assert_eq!(capture.png, bytes);
        assert_eq!((capture.width, capture.height), (12, 8));
    }
    #[test]
    fn cancellation_is_distinct_from_failure() {
        assert!(parse_result(None, Some(1), b"").unwrap().is_none());
        assert!(parse_result(None, Some(0), b"").unwrap().is_none());
        assert!(parse_result(None, Some(1), b"cannot write image").is_err());
        assert!(parse_result(None, Some(2), b"").is_err());
    }
    #[test]
    fn invalid_or_truncated_png_is_rejected() {
        assert!(parse_result(Some(b"not png".to_vec()), Some(0), b"").is_err());
        let mut bytes = png(); bytes.truncate(bytes.len() / 2);
        assert!(parse_result(Some(bytes), Some(0), b"").is_err());
    }
    #[test]
    fn native_process_output_is_cleaned_up_on_every_path() {
        let root = tempfile::tempdir().unwrap();
        let captures = root.path().join("captures"); std::fs::create_dir(&captures).unwrap();
        let fixture = root.path().join("capture-fixture");
        std::fs::write(root.path().join("image.png"), png()).unwrap();
        let bodies = ["for output do :; done\n/bin/cp \"$(/usr/bin/dirname \"$0\")/image.png\" \"$output\"", "exit 1", "echo 'failed' >&2\nexit 2"];
        for (i, body) in bodies.iter().enumerate() {
            std::fs::write(&fixture, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result = run_capture(&fixture, &captures);
            match i { 0 => assert_eq!(result.unwrap().unwrap().png, png()), 1 => assert!(result.unwrap().is_none()), _ => assert!(result.is_err()) }
            assert_eq!(std::fs::read_dir(&captures).unwrap().count(), 0);
        }
    }

    #[test]
    fn a_rectangle_becomes_one_screencapture_argument() {
        let rect = Rect { x: 12.4, y: -80.6, width: 640.5, height: 400.2 };
        assert_eq!(rect.argument(), "-R12,-81,641,400");
    }

    #[test]
    fn quitting_cancels_the_child_and_cleans_up() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output"); std::fs::create_dir(&output).unwrap();
        let fixture = root.path().join("capture-fixture");
        std::fs::write(&fixture, "#!/bin/sh\nexec /bin/sleep 20\n").unwrap();
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(50)); signal.store(true, Ordering::SeqCst); });
        let started = std::time::Instant::now();
        assert!(run_capture_cancellable(&fixture, &output, &cancel, None).unwrap().is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(std::fs::read_dir(output).unwrap().count(), 0);
    }
}
