# Mark

Mark is a fast, small macOS screenshot utility built with Tauri v2. Press a
global shortcut, drag across a region, mark it up, then copy and close.

Annotation is arrows, text, boxes, ellipses, a highlighter, redaction, and a
crop. There are no accounts, settings window, cloud
features, or screen recording. The UI uses the system WKWebView; the native
shell is Rust. There is no Xcode project and no Swift source.

## Requirements

- macOS 13 or newer
- Node.js and pnpm
- Rust 1.85 or newer
- Apple command-line developer tools for linking

Xcode.app can provide the linker, but the Xcode IDE is never opened.

## Develop with hot reload

```sh
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` starts Vite at `http://127.0.0.1:1420` and opens the real
Tauri window. Changes under `src/` update through Vite HMR. Rust changes under
`src-tauri/` rebuild the native process.

For the fastest visual iteration, run the frontend alone:

```sh
pnpm dev
```

Open `http://127.0.0.1:1420`. The browser preview supplies a local sample image
and a file picker. It never calls native commands. Persistence uses localStorage
and storage events in a browser, and `tauri-plugin-store` with `onKeyChange` in
the app. Screenshots are never persisted.

## Build the app

```sh
pnpm tauri build --bundles app
```

The output is:

```text
src-tauri/target/release/bundle/macos/Mark.app
```

The build is signed with the Apple Development identity named in
`tauri.conf.json`. That matters beyond tidiness: macOS pins a Screen Recording
grant to a binary's designated requirement, and an ad hoc signature puts the
binary's own hash in that requirement, so every rebuild silently invalidated
the permission and Capture Region failed with a request to grant access that
was already granted. Signing with a certificate makes the requirement depend on
the bundle identifier and the certificate instead, so the grant survives
rebuilds. Change `signingIdentity` to a local identity from
`security find-identity -v -p codesigning` when building on another machine.

Distributing Mark to anyone else still needs a Developer ID identity and
notarization; an Apple Development certificate is only good for this Mac.

## Use

1. Launch Mark. The editor opens on its empty state so the launch is visible.
   Mark itself lives in the menu bar and never appears in the Dock. Turn on
   **Open at Login** in that menu to have Mark running after a restart; macOS
   may ask you to approve it under Login Items in System Settings. A login
   start is deliberately silent, while every other launch still opens the
   editor, because a start with no window at all reads as a failed launch.
2. Press **⌃⌥⌘4**, choose **Capture Region** from Mark's menu, or use the
   **Capture** button in the editor's title bar. That button stays put while a
   capture is open, so a second shot does not mean closing the first, and its
   menu offers **Region**, **Whole Screen** — the display the pointer is on,
   grabbed straight away with no overlay — and **Timed Region**, which opens
   the overlay with a five second delay already armed.
3. Grant Screen Recording access when macOS asks. This permission is also used
   for still screenshots; Mark does not capture audio or video.
4. Drag to select a region. The selection stays put afterwards: drag inside it
   to move it, drag a corner to resize, or type exact numbers into Width and
   Height. The link button locks the ratio and ⌘A takes the whole display.
   Press **Capture** to shoot, or the clock first to arm a 3, 5, or 10 second
   delay. A delayed shot clears the screen immediately so you can open the menu
   or hover state you are capturing, and counts down in the menu bar rather
   than over the shot. Escape cancels.
5. Pick a tool in the toolbar.
   - **Arrow**: drag. Drag its body to move it, or either end to reshape it.
   - **Text**: click, then type. Enter starts a new line and Escape finishes.
     Click a note to move it; click it again to edit it.
   - **Box** and **Ellipse**: drag out an outline. Grab the outline to move it,
     or a corner to resize.
   - **Highlighter**: drag a band of translucent ink over what matters.
   - **Crop**: drag out what to keep. Everything else dims, corners adjust the
     region, and Enter or the Crop button trims to it. The drawing comes along,
     shifted to match, so cropping never quietly discards work; ⌘Z puts the
     capture back.
   - **Redact**: drag over anything that must not leave the machine. The region
     is replaced with coarse blocks averaged from the capture, and the size
     control sets how coarse. This is pixelation rather than blur on purpose:
     a blur can be partly undone and still leaks the shape of what is under it.

   Color and size come from the toolbar and drive every tool. Selecting an
   annotation adopts its style, so the toolbar always describes the next edit.
   ⌘Z undoes, ⌫ deletes the selection, and Escape backs out one level: first
   the text caret, then the selection, then the editor. ⌘W hides Mark and ⌘Q
   quits it, since an accessory app has no menu bar to quit from.

   ⌘Z takes the most recent thing back, whichever kind it was: a crop counts as
   most recent only while nothing has been drawn since it.

   With something selected, ⌘C takes that annotation and ⌘V drops a copy
   nearby; pasting again cascades instead of stacking. ⌘D does both at once.
   A copy carries its colour and size, and a pasted or moved redaction
   re-samples wherever it lands rather than carrying its old patch with it.
6. **Copy** (⌘⇧C) writes the image to the clipboard and leaves the capture
   open to keep working on. **Copy and Close** (⌘C) writes it and dismisses the
   editor. Both put a PNG and a TIFF compatibility representation on the macOS
   clipboard, and both act on the image whatever is selected.

   ⌘C only reaches the image when nothing is selected, because with a selection
   it copies that instead. That change of meaning is always announced in the
   status line, and Escape clears the selection to get the image back.

   A capture you did not draw on is copied as the original bytes macOS
   produced; only a drawing is flattened and re-encoded.
7. **Fit** in the footer scales the capture to the window. Pick a percentage
   instead and the canvas scrolls; ⌘+ and ⌘- step through the stops, ⌘0 goes
   back to Fit and ⌘1 shows actual pixels. Drawing works the same at any zoom,
   because annotations are stored in image pixels rather than screen ones. A
   new capture starts at Fit.
8. A closed capture is not gone. **Recent** on the empty state holds the last
   six, drawing and all, so closing one by accident costs a click rather than
   the shot. It lives in memory only and does not survive quitting Mark:
   it is an undo for closing, not a library.

Escape, ⌘W, or the red traffic-light button closes without copying. Starting a
new capture hides the old editor; cancel restores it and success replaces it.

## Architecture

- `src/` is framework-free TypeScript, HTML, and CSS for the editor.
- `src/selector.ts` and `src/region.ts` are the selection overlay: one
  transparent, borderless window per display, lifted above the menu bar and the
  Dock, reporting its rectangle in the global point space that
  `screencapture -R` reads. macOS's own picker is not used; it returns an image
  and nothing else, so it cannot hold a selection open for resizing, exact
  sizing, or a delayed shutter.
- `src/main.ts` keeps the recent captures, with each entry holding the image,
  a thumbnail drawn with its annotations, and the annotations themselves, so a
  restored capture comes back as it was left. Rust no longer holds a restored
  capture, so copying one goes through the flatten path; `copy_edited`
  deliberately does not require a live session capture, and validates the bytes
  it is given instead.
- `src/annotations.ts` owns arrow geometry, text notes, rectangle shapes, the
  SVG overlay, and hit-testing. Redaction samples the capture itself, averaging
  each block down and drawing it back with smoothing off, so the detail is gone
  from the pixels rather than hidden behind them; the patch is rebuilt when a
  region settles rather than on every frame of a drag, and the region stays
  covered by a solid block in the meantime. Coordinates are image pixels, never screen pixels, so a drawing
  survives a resize and composites at full resolution. One routine paints each
  shape to SVG for display and to a canvas for export, so the copied image
  matches the screen.
- `src/platform.ts` is the only frontend boundary for native commands.
- `src/preferences.ts` selects the shared Tauri store or browser localStorage.
- `src-tauri/src/capture.rs` owns region capture, PNG validation, cancellation,
  and temporary-file cleanup.
- `src-tauri/src/macos.rs` contains the small AppKit/Core Graphics bridge for
  permissions, clipboard output, focus restoration, overlay window level, and
  login-item registration. SMAppService is reached through the Objective-C
  runtime rather than a binding crate, and reports `notFound` rather than
  `notRegistered` until the app has been registered once, so status is compared
  against `enabled` rather than tested for absence.
- `src-tauri/src/session.rs` owns the single in-memory capture session.
- `src-tauri/src/lib.rs` wires the tray, shortcut, window, commands, and app
  lifecycle.
- `src-tauri/capabilities/editor.json` is the complete per-window API allowlist.

The transparent overlay needs Tauri's `macos-private-api`, which rules out Mac
App Store distribution. Mark does not target it.

The frontend cannot run shell commands or read arbitrary files. Native capture calls
`/usr/sbin/screencapture` directly with fixed arguments and a rectangle that is
validated as finite and non-empty before it is used. Temporary output
uses a private unique directory and is deleted on success, cancellation, error,
and quit.

## Verify

```sh
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm exec playwright test
pnpm build
pnpm tauri build --bundles app
```

Browser screenshots are written to `test-results/editor-light.png` and
`test-results/editor-dark.png`. Browser tests cover responsive rendering,
clipboard failures, keyboard dismissal, local image loading, preference sync,
and the annotation lifecycle: drawing, typing, restyling, moving, reopening a
note, deleting, undo, mixing both tools, and that a copied image carries the
annotation at full resolution. Unit tests cover arrow geometry, text layout,
default sizing, shape export geometry, highlighter blending, redaction
coarseness, selection clamping, and locked-ratio resizing. One browser test
copies a redacted capture back out and counts distinct colours in the region,
so redaction is checked for actually destroying the pixels rather than only
looking like it; another moves a redaction onto different content and reads the
patch back, since a stale patch would both mislead and leak the region it was
cut from. Cropping is covered for the trim itself, for carrying the drawing
along, for undo ordering against drawing, and for re-sampling a redaction into
the cropped image's coordinates. Recent captures are covered for round-tripping a
drawing through a close, for ordering, and for copying something restored after
Rust has forgotten it. Zoom is covered for scaling, for the keyboard, for
resetting on a new capture, and for drawing landing on the same image pixels
whatever the zoom. Rust tests cover PNG preservation and validation,
cancellation/error classification, capture re-entry, child-process
cancellation, and temporary cleanup.

For a manual release check, verify the shortcut from another app, screen-access
grant and denial, selection on every attached display, a delayed capture that
catches an open menu, Copy and Close into
Preview, cancellation with an existing editor, focus restoration, and quit
during selection.
