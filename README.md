# Mark

Mark is a fast, small macOS screenshot utility built with Tauri v2. Press a
global shortcut, drag across a region, mark it up with arrows and text, then
copy and close.

Annotation is arrows and text. There are no accounts, settings window, cloud
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

The local build is ad hoc signed. Distribution still requires a Developer ID
identity and notarization.

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
5. Choose **Arrow** or **Text** in the toolbar.
   - Arrow: drag on the capture. Drag its body to move it, or either end to
     reshape it.
   - Text: click, then type. Enter starts a new line and Escape finishes.
     Click a note to move it; click it again to edit it.

   Color and size come from the toolbar and drive both tools. Selecting an
   annotation adopts its style, so the toolbar always describes the next edit.
   ⌘Z undoes, ⌫ deletes the selection, and Escape backs out one level: first
   the text caret, then the selection, then the editor.
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
- `src/annotations.ts` owns arrow geometry, text notes, the SVG overlay, and
  hit-testing. Coordinates are image pixels, never screen pixels, so a drawing
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
default sizing, selection clamping, and locked-ratio resizing. Rust tests cover PNG preservation and validation,
cancellation/error classification, capture re-entry, child-process
cancellation, and temporary cleanup.

For a manual release check, verify the shortcut from another app, screen-access
grant and denial, selection on every attached display, a delayed capture that
catches an open menu, Copy and Close into
Preview, cancellation with an existing editor, focus restoration, and quit
during selection.
