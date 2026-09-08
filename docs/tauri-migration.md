# Mark: Tauri v2 migration

The original app has SwiftUI views, not an existing web frontend. Replace it with
a small Vite + TypeScript frontend and a Tauri v2 Rust backend. No frontend framework
is necessary for one image, a status message, and a copy button.

## Design

Use macOS system typography, a neutral canvas (#f3f3f5 / #202124), subtle dividers
(#dcdce0 / #38383b), primary ink (#202124 / #f5f5f7), and system blue (#007aff).
An overlay native title bar reserves 78px for traffic lights; its header is draggable.
The image stays central and scales proportionally; dimensions and Copy and Close
share a quiet footer. Browser preview supplies a local sample and a file chooser.

Rust owns the menu bar, Control–Option–Command–4 shortcut, capture guard, temporary
files, original PNG bytes, native clipboard, and focus restoration. The native
screencapture region selector remains. No recording or annotation code is added.
Frontend reloads read a snapshot of Rust state, so a capture survives HMR.

Capabilities apply only to `editor`, including explicit drag permission and generated
permissions for custom commands. The frontend cannot execute arbitrary shell commands
or read arbitrary files. Native window size preferences use tauri-plugin-store;
browser preferences use localStorage with storage events. Consumers subscribe through
onKeyChange in Tauri, and listeners are removed on HMR. Screenshots are never stored
in preferences or localStorage.

## Execution and validation

1. Scaffold Tauri v2, Vite and TypeScript; test clipboard-failure and preference validation.
2. Port capture and native integration to Rust; test PNG validation, cancellation,
   process errors, cleanup and reentry. Build with cargo and pnpm only.
3. Build the editor and shared persistence adapter; exercise browser preview,
   image loading, copy failure, keyboard dismissal, light/dark layout, and HMR.
4. Build `pnpm tauri build --bundles app`, inspect its size, signature and bundle,
   and smoke-test `pnpm tauri dev` without opening Xcode.
5. Back up the old implementation outside the workspace, remove Xcode/Swift sources
   and old build products, and replace documentation with terminal instructions.
