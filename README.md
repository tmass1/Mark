# Mark

Mark is a fast, small macOS screenshot utility built with Tauri v2. Press a
global shortcut, drag across a region, mark it up with arrows, then copy and
close.

Annotation is arrows only. There are no accounts, settings window, cloud
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
4. Drag to select a region. Press Escape to cancel.
5. Drag on the capture to draw an arrow. Drag its body to move it, drag either
   end to reshape it, and set color and size from the toolbar. Selecting an
   arrow adopts its style, so the toolbar always describes the next edit.
   ⌘Z undoes, ⌫ deletes the selected arrow, and Escape clears the selection
   before it closes the editor.
6. Press **⌘C** or click **Copy and Close**. A PNG and a TIFF compatibility
   representation are written to the macOS clipboard. A capture you did not
   draw on is copied as the original bytes macOS produced; only a drawing is
   flattened and re-encoded.

Escape, ⌘W, or the red traffic-light button closes without copying. Starting a
new capture hides the old editor; cancel restores it and success replaces it.

## Architecture

- `src/` is framework-free TypeScript, HTML, and CSS for the editor.
- `src/annotations.ts` owns arrow geometry, the SVG overlay, and hit-testing.
  Coordinates are image pixels, never screen pixels, so a drawing survives a
  resize and composites at full resolution.
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

The frontend cannot run shell commands or read arbitrary files. Native capture
calls `/usr/sbin/screencapture` directly with fixed arguments. Temporary output
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
and the arrow lifecycle: drawing, restyling, moving, deleting, undo, and that
a copied image carries the arrow at full resolution. Unit tests cover arrow
geometry and default weight. Rust tests cover PNG preservation and validation,
cancellation/error classification, capture re-entry, child-process
cancellation, and temporary cleanup.

For a manual release check, verify the shortcut from another app, screen-access
grant and denial, selection on every attached display, Copy and Close into
Preview, cancellation with an existing editor, focus restoration, and quit
during selection.
