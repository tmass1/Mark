use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage, NSPasteboard, NSRunningApplication, NSApplicationActivationOptions,
                    NSWindow, NSWindowCollectionBehavior, NSWorkspace};
use objc2_foundation::{NSData, NSString};

/// Above the menu bar and the Dock. A selection overlay that sits below either
/// one cannot capture what is under it.
const SCREEN_SAVER_LEVEL: isize = 1000;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

pub fn screen_access() -> bool {
    // These APIs only request permission; no recording session is started.
    unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() }
}

/// Reports the current state without prompting, for a check at startup that
/// must not throw a dialog at someone who only just opened the app.
pub fn screen_access_granted() -> bool { unsafe { CGPreflightScreenCaptureAccess() } }

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

/// Lift an overlay above every other window, on every Space, and keep it there
/// when the user switches Spaces mid-selection.
pub fn raise_overlay(handle: *mut std::ffi::c_void) {
    if handle.is_null() || MainThreadMarker::new().is_none() { return; }
    let window: &NSWindow = unsafe { &*(handle as *const NSWindow) };
    window.setLevel(SCREEN_SAVER_LEVEL);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
}

/// An accessory app gets no keyboard focus by default, so the overlay would not
/// see Escape. Come forward for the length of the selection.
pub fn activate_self() {
    let Some(marker) = MainThreadMarker::new() else { return };
    #[allow(deprecated)]
    NSApplication::sharedApplication(marker).activateIgnoringOtherApps(true);
}
