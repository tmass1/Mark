fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&[
      "current_capture", "capture_region", "copy_and_close", "copy_annotated_and_close",
      "dismiss_editor", "open_screen_settings"
    ])
  )).expect("failed to build Mark's capability manifest");
}
