fn main() {
  // SMAppService lives here; it is reached through the runtime, so the
  // framework has to be linked explicitly.
  println!("cargo:rustc-link-lib=framework=ServiceManagement");
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
    tauri_build::AppManifest::new().commands(&[
      "current_capture", "capture_region", "capture_display", "capture_rect", "cancel_selection",
      "copy_capture", "copy_edited", "save_image", "share_image", "quit_app",
      "dismiss_editor", "open_screen_settings",
      "set_material", "glass_available", "set_glass",
      "get_settings", "set_appearance", "set_shortcut", "login_enabled", "set_login", "open_settings"
    ])
  )).expect("failed to build Mark's capability manifest");
}
