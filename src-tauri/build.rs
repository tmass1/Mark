fn main() {
  // SMAppService lives here; it is reached through the runtime, so the
  // framework has to be linked explicitly.
  println!("cargo:rustc-link-lib=framework=ServiceManagement");
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&[
      "current_capture", "capture_region", "capture_rect", "cancel_selection",
      "copy_capture", "copy_edited", "quit_app",
      "dismiss_editor", "open_screen_settings"
    ])
  )).expect("failed to build Mark's capability manifest");
}
