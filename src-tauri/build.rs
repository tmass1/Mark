fn main() {
  // SMAppService lives here; it is reached through the runtime, so the
  // framework has to be linked explicitly.
  println!("cargo:rustc-link-lib=framework=ServiceManagement");
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&[
      "current_capture", "capture_region", "capture_display", "capture_rect", "capture_window", "cancel_selection",
      "copy_capture", "copy_edited", "copy_text", "recognize_text", "scan_image", "save_image", "share_image", "quit_app",
      "dismiss_editor", "open_screen_settings",
      "glass_available", "set_glass",
      "get_settings", "set_appearance", "set_shortcut", "set_frame", "login_enabled", "set_login", "open_settings",
      "check_for_update", "pending_update", "install_update", "skip_update", "set_auto_update", "open_updates"
    ])
  )).expect("failed to build Mark's capability manifest");
}
