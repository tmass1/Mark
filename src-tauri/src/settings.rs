//! What the user has chosen, kept in one small file under Application Support.
//!
//! Three things so far: which appearance the windows take, which keys start a
//! capture, and -- read from macOS rather than stored -- whether Mark opens at
//! login. The file is written only when a setting changes, so a Mark that has
//! never been configured has written nothing.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const DEFAULT_SHORTCUT: &str = "Super+Digit4";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "dark", "light" or "system". Dark is Mark's own look; the others defer.
    pub appearance: String,
    /// In the global-shortcut plugin's notation: modifiers and a key code,
    /// joined by +, e.g. "Super+Alt+Digit4".
    pub shortcut: String,
}

impl Default for Settings {
    fn default() -> Self { Settings { appearance: "dark".into(), shortcut: DEFAULT_SHORTCUT.into() } }
}

impl Settings {
    pub fn appearance_is_valid(name: &str) -> bool { matches!(name, "dark" | "light" | "system") }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join("settings.json")).map_err(|e| e.to_string())
}

/// Anything unreadable -- no file yet, a hand-edited one that no longer parses
/// -- is the defaults. A settings file must never be able to stop Mark starting.
pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = path(app) else { return Settings::default() };
    std::fs::read(&path).ok().and_then(|bytes| parse(&bytes)).unwrap_or_default()
}

pub fn parse(bytes: &[u8]) -> Option<Settings> {
    let mut settings: Settings = serde_json::from_slice(bytes).ok()?;
    if !Settings::appearance_is_valid(&settings.appearance) { settings.appearance = Settings::default().appearance; }
    if settings.shortcut.trim().is_empty() { settings.shortcut = DEFAULT_SHORTCUT.into(); }
    Some(settings)
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = path(app)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    // Written whole and renamed into place, so a crash mid-write leaves the
    // previous file rather than half of a new one.
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, json).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_dark_and_command_4() {
        let settings = Settings::default();
        assert_eq!(settings.appearance, "dark");
        assert_eq!(settings.shortcut, "Super+Digit4");
    }

    #[test]
    fn a_saved_file_round_trips() {
        let settings = Settings { appearance: "light".into(), shortcut: "Control+Alt+Super+Digit4".into() };
        let json = serde_json::to_vec(&settings).unwrap();
        assert_eq!(parse(&json).unwrap(), settings);
    }

    #[test]
    fn a_partial_or_odd_file_falls_back_field_by_field() {
        // An older file with only one key keeps the defaults for the rest.
        assert_eq!(parse(br#"{"shortcut":"Super+KeyM"}"#).unwrap(),
                   Settings { appearance: "dark".into(), shortcut: "Super+KeyM".into() });
        // A hand-edited appearance that is not one of the three is ignored.
        assert_eq!(parse(br#"{"appearance":"sepia"}"#).unwrap().appearance, "dark");
        // An empty shortcut would register nothing; it becomes the default.
        assert_eq!(parse(br#"{"shortcut":"  "}"#).unwrap().shortcut, DEFAULT_SHORTCUT);
        // Not JSON at all is no settings, which the caller turns into defaults.
        assert!(parse(b"not json").is_none());
    }
}
