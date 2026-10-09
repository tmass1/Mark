use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, rc::Retained, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2::rc::Retained as Rc;
use objc2_app_kit::{NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
                    NSEvent, NSEventModifierFlags, NSEventType, NSImage, NSPasteboard, NSRunningApplication,
                    NSApplicationActivationOptions, NSSharingServicePicker, NSTrackingArea, NSTrackingAreaOptions, NSWindow,
                    NSWindowCollectionBehavior, NSWorkspace};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSNumber, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
use std::cell::RefCell;

use crate::capture::{Listed, Rect};

/// Above the menu bar and the Dock. A selection overlay that sits below either
/// one cannot capture what is under it.
const SCREEN_SAVER_LEVEL: isize = 1000;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut NSArray<NSDictionary<NSString, AnyObject>>;
    fn CGRectMakeWithDictionaryRepresentation(dictionary: *const AnyObject, rect: *mut NSRect) -> bool;
    fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(event: *mut std::ffi::c_void) -> NSPoint;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: *const std::ffi::c_void);
}

/// Where the pointer is, in the global points the window list uses: top left
/// of the main display at the origin, as screencapture -R also counts.
pub fn pointer() -> Option<(f64, f64)> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() { return None; }
        let at = CGEventGetLocation(event);
        CFRelease(event);
        Some((at.x, at.y))
    }
}

/// kCGWindowListOptionOnScreenOnly and kCGWindowListExcludeDesktopElements:
/// the windows in this Space, without the desktop and its icons.
const ON_SCREEN_WITHOUT_DESKTOP: u32 = (1 << 0) | (1 << 4);

/// Every window on screen, front to back, as the window server lists it. Its
/// title comes only with screen access, which a capture has by the time it asks.
pub fn windows_on_screen() -> Vec<Listed> {
    // A Copy function's result is the caller's to release, which Retained does.
    let Some(list) = (unsafe { Retained::from_raw(CGWindowListCopyWindowInfo(ON_SCREEN_WITHOUT_DESKTOP, 0)) }) else {
        return Vec::new();
    };
    list.iter().filter_map(|info| listed(&info)).collect()
}

fn listed(info: &NSDictionary<NSString, AnyObject>) -> Option<Listed> {
    let value = |key: &str| info.objectForKey(&NSString::from_str(key));
    let number = |key: &str| value(key).and_then(|v| v.downcast_ref::<NSNumber>().map(NSNumber::as_f64));
    let text = |key: &str| value(key).and_then(|v| v.downcast_ref::<NSString>().map(NSString::to_string)).unwrap_or_default();
    let mut bounds = NSRect::ZERO;
    let ok = unsafe { CGRectMakeWithDictionaryRepresentation(Retained::as_ptr(&value("kCGWindowBounds")?), &mut bounds) };
    if !ok { return None; }
    Some(Listed {
        id: number("kCGWindowNumber")? as u32,
        pid: number("kCGWindowOwnerPID")? as i32,
        layer: number("kCGWindowLayer")? as i64,
        alpha: number("kCGWindowAlpha").unwrap_or(1.0),
        app: text("kCGWindowOwnerName"),
        title: text("kCGWindowName"),
        bounds: Rect { x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height },
    })
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

/// The steps as text. Its own write rather than a second flavour beside the
/// PNG: a single pasteboard write cannot be pasted as the image and then as the
/// words, since the second paste would only repeat the first.
pub fn copy_text(text: &str) -> Result<(), String> {
    if MainThreadMarker::new().is_none() { return Err("Clipboard must be accessed on the main thread.".into()); }
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if !pasteboard.setString_forType(&NSString::from_str(text), &NSString::from_str("public.utf8-plain-text")) {
        return Err("The list couldn't be copied. Please try again.".into());
    }
    Ok(())
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

/// In front of every other app's windows, whether or not Mark is the active
/// app. An AI tool's ask arrives with no click or key of the user's behind it,
/// and macOS may decline to make Mark active for that; the window must be seen
/// all the same. A click on it then activates Mark as usual.
pub fn bring_forward(handle: *mut std::ffi::c_void) {
    if handle.is_null() || MainThreadMarker::new().is_none() { return; }
    let window: &NSWindow = unsafe { &*(handle as *const NSWindow) };
    window.orderFrontRegardless();
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
    let url = NSURL::fileURLWithPath(&NSString::from_str(text));
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


// ---- the floating thumbnail -------------------------------------------------

/// Told when the pointer comes onto a window and goes off it. A web view
/// follows the pointer only in the key window, and the thumbnail is never
/// key -- so that it never takes the keyboard from the app being worked in --
/// so its page would not otherwise know it was being looked at.
struct HoverIvars { changed: Box<dyn Fn(bool)> }

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MarkHoverWatcher"]
    #[ivars = HoverIvars]
    struct HoverWatcher;

    unsafe impl NSObjectProtocol for HoverWatcher {}

    impl HoverWatcher {
        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, _event: &NSEvent) { (self.ivars().changed)(true); }

        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) { (self.ivars().changed)(false); }
    }
);

thread_local! {
    /// A tracking area does not keep its owner, so this does, for as long as
    /// the window it watches. The thumbnail's is made once and kept.
    static WATCHERS: RefCell<Vec<Retained<HoverWatcher>>> = const { RefCell::new(Vec::new()) };
    /// The drag under way, or the last one: a session is not documented to keep
    /// its source, so this does, until the next drag replaces it.
    static DRAG: RefCell<Option<Retained<DragSource>>> = const { RefCell::new(None) };
}

/// Say when the pointer comes onto the window and goes off it, whether or not
/// Mark is the active app. Main thread only.
pub fn watch_hover(handle: *mut std::ffi::c_void, changed: impl Fn(bool) + 'static) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Hover can only be watched from the main thread.")?;
    if handle.is_null() { return Err("The window isn't there to watch.".into()); }
    let window: &NSWindow = unsafe { &*(handle as *const NSWindow) };
    let view = window.contentView().ok_or("The window has no content view.")?;
    let watcher = HoverWatcher::alloc(mtm).set_ivars(HoverIvars { changed: Box::new(changed) });
    let watcher: Retained<HoverWatcher> = unsafe { msg_send![super(watcher), init] };
    let options = NSTrackingAreaOptions::MouseEnteredAndExited | NSTrackingAreaOptions::ActiveAlways
        | NSTrackingAreaOptions::InVisibleRect;
    // SAFETY: the owner is kept alive in WATCHERS for as long as the area can
    // message it; the rect is ignored, InVisibleRect making it the view's own.
    let area = unsafe {
        NSTrackingArea::initWithRect_options_owner_userInfo(NSTrackingArea::alloc(), view.bounds(), options, Some(&watcher), None)
    };
    view.addTrackingArea(&area);
    WATCHERS.with(|kept| kept.borrow_mut().push(watcher));
    Ok(())
}

/// Hears how a drag of the thumbnail ended. Copy is all it offers: a move
/// would let Finder take the file away, and the next drag would find nothing.
struct DragIvars { ended: Box<dyn Fn(bool)>, home: NSRect }

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MarkDragSource"]
    #[ivars = DragIvars]
    struct DragSource;

    unsafe impl NSObjectProtocol for DragSource {}

    unsafe impl NSDraggingSource for DragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operations(&self, _session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
            NSDragOperation::Copy
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(&self, _session: &NSDraggingSession, point: NSPoint, operation: NSDragOperation) {
            let ivars = self.ivars();
            (ivars.ended)(landed(operation, point, ivars.home));
        }
    }
);

/// Whether a drag put the file somewhere: an app took it, and not the
/// thumbnail itself -- whose web view accepts any drop, and would otherwise
/// count a drag let go back where it began as delivered.
pub fn landed(operation: NSDragOperation, point: NSPoint, home: NSRect) -> bool {
    let inside = point.x >= home.origin.x && point.x <= home.origin.x + home.size.width
        && point.y >= home.origin.y && point.y <= home.origin.y + home.size.height;
    operation != NSDragOperation::None && !inside
}

/// Drag a file out of a window, as Finder would: the file itself, so whatever
/// it lands in -- a Finder window, a message, a mail, an upload field -- gets
/// a real PNG. The drag picks up `image` from where it sits in the window --
/// `rect`, in the page's points from the top left -- under the pointer.
/// Nothing happens unless the button is still down: a drag begun after the
/// mouse came up would follow a pointer no one is holding. Main thread only.
pub fn drag_file(handle: *mut std::ffi::c_void, file: &std::path::Path, image: &[u8], rect: Rect,
                 ended: impl Fn(bool) + 'static) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("A drag can only start on the main thread.")?;
    if handle.is_null() { return Err("The thumbnail isn't there to drag from.".into()); }
    if NSEvent::pressedMouseButtons() & 1 == 0 { return Err("The mouse button came up before the drag began.".into()); }
    let window: &NSWindow = unsafe { &*(handle as *const NSWindow) };
    let view = window.contentView().ok_or("The thumbnail has no content view.")?;
    let path = file.to_str().ok_or("The file's path can't be dragged.")?;
    // AppKit counts up from the bottom unless the view says otherwise.
    let bottom = if view.isFlipped() { rect.y } else { view.bounds().size.height - rect.y - rect.height };
    let frame = NSRect::new(NSPoint::new(rect.x, bottom), NSSize::new(rect.width, rect.height));
    let picture = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(image)).ok_or("The capture couldn't be drawn to drag.")?;
    picture.setSize(frame.size);
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), ProtocolObject::from_ref(&*url));
    // SAFETY: an NSImage is what a dragging item's contents may be.
    unsafe { item.setDraggingFrame_contents(frame, Some(&picture)) };
    let items = NSArray::from_retained_slice(&[item]);
    // The event that began this is gone by the time a page's call arrives, so
    // the session starts from one made where the pointer is now, as Chromium
    // starts its own drags.
    let timestamp = NSApplication::sharedApplication(mtm).currentEvent().map_or(0.0, |event| event.timestamp());
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDragged, window.mouseLocationOutsideOfEventStream(), NSEventModifierFlags::empty(),
        timestamp, window.windowNumber(), None, 0, 1, 1.0).ok_or("The drag couldn't begin.")?;
    let source = DragSource::alloc(mtm).set_ivars(DragIvars { ended: Box::new(ended), home: window.frame() });
    let source: Retained<DragSource> = unsafe { msg_send![super(source), init] };
    let _session = view.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
    DRAG.with(|slot| *slot.borrow_mut() = Some(source));
    Ok(())
}

#[cfg(test)]
mod tests {
    /// A drag counts as delivered only where something took it, away from the
    /// thumbnail it started on.
    #[test]
    fn a_drag_has_landed_only_where_an_app_took_it() {
        use objc2_app_kit::NSDragOperation;
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        let home = NSRect::new(NSPoint::new(1000.0, 40.0), NSSize::new(252.0, 182.0));
        assert!(super::landed(NSDragOperation::Copy, NSPoint::new(400.0, 600.0), home));
        assert!(!super::landed(NSDragOperation::None, NSPoint::new(400.0, 600.0), home), "let go over nothing");
        assert!(!super::landed(NSDragOperation::Copy, NSPoint::new(1100.0, 100.0), home), "back on the thumbnail");
    }

    /// The window server's own list, read through the same calls a capture
    /// makes. Ignored by default, since what is on screen is up to the Mac it
    /// runs on: `cargo test -- --ignored` with a few windows open.
    #[test]
    #[ignore]
    fn the_window_server_lists_what_is_on_screen() {
        let all = super::windows_on_screen();
        assert!(!all.is_empty(), "no windows listed at all");
        assert!(all.iter().any(|w| w.layer == 0 && w.bounds.width > 100.0 && !w.app.is_empty()));
        for w in all.iter().filter(|w| w.layer == 0).take(8) {
            println!("{:>6}  {:<22} {:>6.0},{:<6.0} {:>5.0} x {:<5.0} alpha {}", w.id, w.app, w.bounds.x, w.bounds.y, w.bounds.width, w.bounds.height, w.alpha);
        }
    }
}
