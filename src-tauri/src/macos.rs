use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, rc::Retained, AnyThread, MainThreadMarker};
use objc2::rc::Retained as Rc;
use objc2_app_kit::{NSApplication, NSImage, NSPasteboard, NSRunningApplication,
                    NSApplicationActivationOptions, NSSharingServicePicker, NSWindow,
                    NSWindowCollectionBehavior, NSWorkspace};
use objc2_foundation::{NSArray, NSData, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};

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

/// Seconds since the machine booted, used to tell a login launch from someone
/// opening Mark themselves.
pub fn seconds_since_boot() -> f64 {
    unsafe {
        let class = match AnyClass::get(c"NSProcessInfo") { Some(class) => class, None => return f64::MAX };
        let info: Retained<AnyObject> = msg_send![class, processInfo];
        msg_send![&*info, systemUptime]
    }
}

/// SMAppService, reached through the runtime rather than a dedicated crate.
/// Status values are SMAppServiceStatus: 0 not registered, 1 enabled,
/// 2 awaiting approval in System Settings, 3 not found.
pub const LOGIN_ENABLED: i64 = 1;
pub const LOGIN_NEEDS_APPROVAL: i64 = 2;
/// Distinct from SMAppServiceStatus's own values, so "the API is not there" is
/// never mistaken for anything it reports.
pub const LOGIN_UNAVAILABLE: i64 = -1;

fn app_service() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"SMAppService")?;
    unsafe { msg_send![class, mainAppService] }
}

pub fn login_item_status() -> i64 {
    let Some(service) = app_service() else { return LOGIN_UNAVAILABLE };
    unsafe { msg_send![&*service, status] }
}

pub fn set_login_item(enabled: bool) -> Result<(), String> {
    let Some(service) = app_service() else {
        return Err("Opening at login needs macOS 13 or newer.".into());
    };
    let mut failure: *mut AnyObject = std::ptr::null_mut();
    let ok: bool = unsafe {
        if enabled { msg_send![&*service, registerAndReturnError: &mut failure] }
        else { msg_send![&*service, unregisterAndReturnError: &mut failure] }
    };
    if ok { return Ok(()); }
    Err(if enabled { "Mark couldn't be added to your login items.".into() }
        else { "Mark couldn't be removed from your login items.".into() })
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

/// Hand a file to macOS's own share sheet, anchored under the editor's Share
/// button. The file has to outlive this call: the sheet is asynchronous and
/// whichever app the user picks reads the URL long after we return.
pub fn share_file(handle: *mut std::ffi::c_void, path: &std::path::Path) -> Result<(), String> {
    let Some(marker) = MainThreadMarker::new() else {
        return Err("Sharing has to run on the main thread.".into());
    };
    if handle.is_null() { return Err("Mark's window isn't available to share from.".into()); }
    let text = path.to_str().ok_or("That file path can't be shared.")?;
    let url = unsafe { NSURL::fileURLWithPath(&NSString::from_str(text)) };
    // The picker takes a heterogeneous list, so the URL goes in as a plain object.
    let item: Rc<AnyObject> = unsafe { Rc::cast_unchecked(url) };
    let items = NSArray::from_retained_slice(&[item]);
    let picker = unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items) };

    let window: &NSWindow = unsafe { &*(handle as *const NSWindow) };
    let _ = marker;
    let view = window.contentView().ok_or("Mark's window has no content view.")?;
    let bounds = view.bounds();
    // Near the top-right, which is where the Share button sits. An approximate
    // anchor is fine; the sheet only needs somewhere sensible to point at.
    let anchor = NSRect::new(
        NSPoint::new((bounds.size.width - 150.0).max(0.0), (bounds.size.height - 54.0).max(0.0)),
        NSSize::new(2.0, 2.0),
    );
    picker.showRelativeToRect_ofView_preferredEdge(anchor, &view, NSRectEdge::MinY);
    Ok(())
}
