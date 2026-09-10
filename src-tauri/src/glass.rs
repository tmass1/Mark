//! Liquid Glass under the editor's controls.
//!
//! macOS 26 draws its own toolbars on NSGlassEffectView: a material that
//! refracts what is behind it rather than tinting it, which no stylesheet can
//! do. The editor lays one under each of its panes -- the toolbar, the tool
//! rail, the crop button and the footer -- beneath the web view, at the same
//! geometry the stylesheet uses. The web view then draws those panes with no
//! background of their own, so the controls sit on glass.
//!
//! The panes follow the window through AppKit autoresizing, so a resize never
//! waits on a round trip to the web view. Older systems have no such class;
//! then nothing is installed and the stylesheet's frosted panes stand in.

use objc2::{rc::Retained, runtime::AnyClass, MainThreadMarker};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle, NSView, NSWindow,
                    NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};

/// Where a pane sits, in points, as the stylesheet lays it out: `x` from the
/// left, `offset` from the top -- or from the bottom, for a pane pinned there.
/// `stretch` widens it with the window.
pub struct Pane { pub x: f64, pub offset: f64, pub width: f64, pub height: f64, pub radius: f64, pub stretch: bool, pub bottom: bool }

pub struct Glass { panes: Vec<Retained<NSGlassEffectView>> }

/// Only macOS 26 has the class. Checked by name rather than by version, since
/// it is the class that matters.
pub fn available() -> bool { AnyClass::get(c"NSGlassEffectView").is_some() }

impl Glass {
    /// Lay glass under each pane. Main thread only, like everything about a window.
    pub fn install(handle: *mut std::ffi::c_void, panes: &[Pane]) -> Option<Glass> {
        let mtm = MainThreadMarker::new()?;
        if handle.is_null() || !available() { return None; }
        let window: &NSWindow = unsafe { &*(handle as *const NSWindow) };
        let content = window.contentView()?;
        let bounds = content.bounds();
        // Above the window's material, below the web view: the first subview
        // that is not the material is the web view.
        let web = content.subviews().iter()
            .find(|view| view.class().name().to_str().map_or(true, |name| !name.contains("VisualEffect")))
            .map(|view| view.clone());
        let mut views = Vec::with_capacity(panes.len());
        for pane in panes {
            // AppKit measures from the bottom-left.
            let y = if pane.bottom { pane.offset } else { bounds.size.height - pane.offset - pane.height };
            let frame = NSRect::new(
                NSPoint::new(pane.x, y),
                NSSize::new(if pane.stretch { bounds.size.width - 2.0 * pane.x } else { pane.width }, pane.height),
            );
            let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), frame);
            glass.setCornerRadius(pane.radius);
            glass.setStyle(NSGlassEffectViewStyle::Regular);
            let mut mask = if pane.bottom { NSAutoresizingMaskOptions::ViewMaxYMargin } else { NSAutoresizingMaskOptions::ViewMinYMargin };
            mask |= if pane.stretch { NSAutoresizingMaskOptions::ViewWidthSizable } else { NSAutoresizingMaskOptions::ViewMaxXMargin };
            glass.setAutoresizingMask(mask);
            glass.setHidden(true);
            let as_view: &NSView = &glass;
            content.addSubview_positioned_relativeTo(as_view, NSWindowOrderingMode::Below, web.as_deref());
            views.push(glass);
        }
        Some(Glass { panes: views })
    }

    /// The panes exist only while a capture is open; the empty state has none.
    pub fn set_visible(&self, visible: bool) {
        for pane in &self.panes { pane.setHidden(!visible); }
    }
}
