# Mark

Mark is a fast, small macOS screenshot utility built with Tauri v2. Press a
global shortcut, drag across a region, mark it up, then copy and close.

Annotation is arrows, text, boxes, ellipses, a highlighter, and redaction.
There are no accounts, settings window, cloud
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
   Mark itself lives in the menu bar and never appears in the Dock.
2. Press **⌃⌥⌘4**, or choose **Capture Region** from Mark's menu.
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
   - **Redact**: drag over anything that must not leave the machine. The region
     is replaced with coarse blocks averaged from the capture, and the size
     control sets how coarse. This is pixelation rather than blur on purpose:
     a blur can be partly undone and still leaks the shape of what is under it.

   Color and size come from the toolbar and drive every tool. Selecting an
   annotation adopts its style, so the toolbar always describes the next edit.
   ⌘Z undoes, ⌫ deletes the selection, and Escape backs out one level: first
   the text caret, then the selection, then the editor. ⌘W hides Mark and ⌘Q
   quits it, since an accessory app has no menu bar to quit from.
6. Press **⌘C** or click **Copy and Close**. A PNG and a TIFF compatibility
   representation are written to the macOS clipboard. A capture you did not
   draw on is copied as the original bytes macOS produced; only a drawing is
   flattened and re-encoded.

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
  permissions, clipboard output, and focus restoration.
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
looking like it. Rust tests cover PNG preservation and validation,
cancellation/error classification, capture re-entry, child-process
cancellation, and temporary cleanup.

For a manual release check, verify the shortcut from another app, screen-access
grant and denial, selection on every attached display, a delayed capture that
catches an open menu, Copy and Close into
Preview, cancellation with an existing editor, focus restoration, and quit
during selection.
