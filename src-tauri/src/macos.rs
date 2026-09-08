use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSImage, NSPasteboard, NSRunningApplication, NSApplicationActivationOptions, NSWorkspace};
use objc2_foundation::{NSData, NSString};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

pub fn screen_access() -> bool {
    // These APIs only request permission; no recording session is started.
    unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() }
}

pub fn frontmost_pid() -> Option<i32> {
    NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app.processIdentifier())
}

pub fn restore_focus(pid: Option<i32>) {
    if let Some(app) = pid.and_then(NSRunningApplication::runningApplicationWithProcessIdentifier) {
        #[allow(deprecated)]
        app.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

pub fn copy_png(bytes: &[u8]) -> Result<(), String> {
    if MainThreadMarker::new().is_none() { return Err("Clipboard must be accessed on the main thread.".into()); }
    write_png(&NSPasteboard::generalPasteboard(), bytes)
}

fn write_png(pasteboard: &NSPasteboard, bytes: &[u8]) -> Result<(), String> {
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data).ok_or("The screenshot couldn't be opened.")?;
    let tiff = image.TIFFRepresentation();
    pasteboard.clearContents();
    if !pasteboard.setData_forType(Some(&data), &NSString::from_str("public.png")) {
        return Err("The screenshot couldn't be copied. Your image is still here; please try again.".into());
    }
    if let Some(tiff) = tiff { pasteboard.setData_forType(Some(&tiff), &NSString::from_str("public.tiff")); }
    Ok(())
}
