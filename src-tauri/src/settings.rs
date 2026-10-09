//! What the user has chosen, kept in one small file under Application Support.
//!
//! Which appearance the windows take, which keys start a capture, what follows
//! a capture, whether Mark looks for updates by itself and which version it was
//! told to skip, how a capture is framed, whether AI tools may ask for a
//! screenshot, and -- read from macOS rather than stored -- whether Mark opens
//! at login. The file
//! is written only when a setting changes, so a Mark that has never been
//! configured has written nothing.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const DEFAULT_SHORTCUT: &str = "Super+Digit4";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "dark", "light" or "system". Dark is Mark's own look; the others defer.
    pub appearance: String,
    /// Capture Region's, in the global-shortcut plugin's notation: modifiers
    /// and a key code, joined by +, e.g. "Super+Alt+Digit4".
    pub shortcut: String,
    /// The other ways in, each with a shortcut only once one is chosen.
    pub shortcuts: Shortcuts,
    /// Whether Mark looks for a new version by itself: at launch, then daily.
    pub check_updates: bool,
    /// A version the user chose to skip. Looking by itself, Mark passes over
    /// it; a check asked for by hand still offers it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_version: Option<String>,
    /// How the editor frames a capture, kept so the next one looks the same.
    pub frame: Frame,
    /// "editor", which opens on every capture, or "thumbnail": the capture is
    /// copied and floats in the corner of the screen, to be opened, dragged
    /// somewhere, or let go.
    pub after_capture: String,
    /// Whether AI tools may ask for a screenshot. Each ask still waits for the
    /// user to send one.
    pub mcp: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { appearance: "dark".into(), shortcut: DEFAULT_SHORTCUT.into(), shortcuts: Shortcuts::default(),
                   check_updates: true, skipped_version: None, frame: Frame::default(),
                   after_capture: "editor".into(), mcp: true }
    }
}

impl Settings {
    pub fn appearance_is_valid(name: &str) -> bool { matches!(name, "dark" | "light" | "system") }
    pub fn after_capture_is_valid(name: &str) -> bool { matches!(name, "editor" | "thumbnail") }
    pub fn thumbnail(&self) -> bool { self.after_capture == "thumbnail" }
}

/// Shortcuts for a window, the whole screen and a timed region. None comes
/// set: a key taken globally is taken from every other app, so it is for the
/// person who wants it to choose.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcuts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed: Option<String>,
}

/// A background, room around the capture, rounded corners, a shadow and a
/// title bar, as the editor's Frame panel sets them. The editor owns what the
/// numbers mean -- each is 0 to 1 here -- and which backgrounds exist; this
/// only keeps what it is given within those bounds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Frame {
    pub on: bool,
    pub background: String,
    pub padding: f64,
    pub radius: f64,
    pub shadow: f64,
    pub chrome: bool,
}

impl Default for Frame {
    fn default() -> Self {
        Frame { on: false, background: "sky".into(), padding: 0.5, radius: 0.4, shadow: 0.5, chrome: false }
    }
}

impl Frame {
    /// Numbers held to 0 to 1, and a background name that could be one: the
    /// editor falls back on its own default for a name it does not know.
    pub fn sanitized(self) -> Frame {
        let defaults = Frame::default();
        let share = |value: f64, fallback: f64| if value.is_finite() { value.clamp(0.0, 1.0) } else { fallback };
        let named = !self.background.is_empty() && self.background.len() <= 32
            && self.background.chars().all(|c| c.is_ascii_lowercase() || c == '-');
        Frame {
            background: if named { self.background } else { defaults.background },
            padding: share(self.padding, defaults.padding),
            radius: share(self.radius, defaults.radius),
            shadow: share(self.shadow, defaults.shadow),
            ..self
        }
    }
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
    if !Settings::after_capture_is_valid(&settings.after_capture) { settings.after_capture = Settings::default().after_capture; }
    if settings.shortcut.trim().is_empty() { settings.shortcut = DEFAULT_SHORTCUT.into(); }
    // A shortcut cleared by hand is no shortcut, not an empty one to register.
    for slot in [&mut settings.shortcuts.window, &mut settings.shortcuts.display, &mut settings.shortcuts.timed] {
        if slot.as_deref().is_some_and(|s| s.trim().is_empty()) { *slot = None; }
    }
    settings.frame = settings.frame.sanitized();
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
        let settings = Settings {
            appearance: "light".into(), shortcut: "Control+Alt+Super+Digit4".into(),
            shortcuts: Shortcuts { window: Some("Alt+Super+Digit5".into()), display: None, timed: Some("Shift+Super+KeyT".into()) },
            check_updates: false, skipped_version: Some("0.5.0".into()),
            frame: Frame { on: true, background: "midnight".into(), padding: 0.25, radius: 0.75, shadow: 0.0, chrome: true },
            after_capture: "thumbnail".into(), mcp: false,
        };
        let json = serde_json::to_vec(&settings).unwrap();
        assert_eq!(parse(&json).unwrap(), settings);
    }

    #[test]
    fn a_partial_or_odd_file_falls_back_field_by_field() {
        // An older file with only one key keeps the defaults for the rest.
        assert_eq!(parse(br#"{"shortcut":"Super+KeyM"}"#).unwrap(),
                   Settings { shortcut: "Super+KeyM".into(), ..Settings::default() });
        // A hand-edited appearance that is not one of the three is ignored.
        assert_eq!(parse(br#"{"appearance":"sepia"}"#).unwrap().appearance, "dark");
        // An empty shortcut would register nothing; it becomes the default.
        assert_eq!(parse(br#"{"shortcut":"  "}"#).unwrap().shortcut, DEFAULT_SHORTCUT);
        // Not JSON at all is no settings, which the caller turns into defaults.
        assert!(parse(b"not json").is_none());
    }

    #[test]
    fn a_file_from_before_updates_looks_for_them() {
        // Every settings file written before updates existed lacks both keys:
        // such a Mark should start looking, with nothing skipped.
        let settings = parse(br#"{"appearance":"light","shortcut":"Super+Digit4"}"#).unwrap();
        assert!(settings.check_updates);
        assert_eq!(settings.skipped_version, None);
        // And nothing is written for a skip that never happened.
        assert!(!String::from_utf8(serde_json::to_vec(&Settings::default()).unwrap()).unwrap().contains("skipped"));
    }

    #[test]
    fn a_file_from_before_frames_is_unframed() {
        let settings = parse(br#"{"appearance":"light","shortcut":"Super+Digit4","checkUpdates":true}"#).unwrap();
        assert_eq!(settings.frame, Frame::default());
        assert!(!settings.frame.on);
    }

    #[test]
    fn a_hand_edited_frame_is_kept_within_bounds() {
        let settings = parse(br#"{"frame":{"on":true,"background":"<script>","padding":7,"radius":-2,"shadow":0.3}}"#).unwrap();
        assert_eq!(settings.frame, Frame { on: true, padding: 1.0, radius: 0.0, shadow: 0.3, ..Frame::default() });
        // Half a frame keeps what it says and takes the defaults for the rest.
        assert_eq!(parse(br#"{"frame":{"chrome":true}}"#).unwrap().frame, Frame { chrome: true, ..Frame::default() });
    }

    #[test]
    fn a_file_from_before_more_shortcuts_has_only_the_region_one() {
        let settings = parse(br#"{"shortcut":"Super+Digit4"}"#).unwrap();
        assert_eq!(settings.shortcuts, Shortcuts::default());
        // And none is written until one is chosen.
        assert!(!String::from_utf8(serde_json::to_vec(&Settings::default()).unwrap()).unwrap().contains("window"));
        // A blank one left in the file is no shortcut at all.
        assert_eq!(parse(br#"{"shortcuts":{"window":"  ","timed":"Super+KeyT"}}"#).unwrap().shortcuts,
                   Shortcuts { window: None, display: None, timed: Some("Super+KeyT".into()) });
    }

    #[test]
    fn a_file_from_before_thumbnails_and_ai_tools_opens_the_editor_and_lets_tools_ask() {
        let settings = parse(br#"{"appearance":"light","shortcut":"Super+Digit4"}"#).unwrap();
        assert_eq!(settings.after_capture, "editor");
        assert!(!settings.thumbnail());
        assert!(settings.mcp);
        // Written under the names the web side reads.
        let json = String::from_utf8(serde_json::to_vec(&Settings::default()).unwrap()).unwrap();
        assert!(json.contains("\"afterCapture\":\"editor\"") && json.contains("\"mcp\":true"));
        // A hand-edited choice that is neither is the editor.
        assert_eq!(parse(br#"{"afterCapture":"popup"}"#).unwrap().after_capture, "editor");
        assert!(parse(br#"{"afterCapture":"thumbnail","mcp":false}"#).map(|s| s.thumbnail() && !s.mcp).unwrap());
    }
}
