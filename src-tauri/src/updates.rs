//! Software Update: looking for a newer Mark, offering it, and installing it.
//!
//! The work itself is Tauri's updater. It reads a small manifest from Mark's
//! site and installs only an archive signed by the key whose public half is in
//! tauri.conf.json, so a download that has been tampered with is refused rather
//! than run. This module decides when to look, holds what was found until the
//! Software Update window acts on it, and keeps that window told how the
//! download is going.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{settings, Prefs};

pub const WINDOW: &str = "update";
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// What a check found, held between the check and the click that installs it.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// An update as the window shows it: the version on offer, the one running,
/// and what changed, as the release notes put it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer { pub version: String, pub current: String, pub notes: String }

impl From<&Update> for Offer {
    fn from(update: &Update) -> Self {
        Offer { version: update.version.clone(), current: update.current_version.clone(),
                notes: update.body.clone().unwrap_or_default() }
    }
}

/// A check asked for by hand. Whatever it finds is offered, even a version
/// that was skipped: asking is asking.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<Offer>, String> {
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let offer = found.as_ref().map(Offer::from);
    *app.state::<Pending>().0.lock().unwrap() = found;
    Ok(offer)
}

/// What the last check found, for a window that a check made by itself opened.
#[tauri::command]
pub fn pending_update(app: AppHandle) -> Option<Offer> {
    app.state::<Pending>().0.lock().unwrap().as_ref().map(Offer::from)
}

#[derive(Clone, Serialize)]
struct Progress { done: u64, total: Option<u64> }

/// Download the update, check its signature, put it in place of this Mark,
/// and reopen as the new one.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app.state::<Pending>().0.lock().unwrap().clone()
        .ok_or("There's no update waiting to install. Check again.")?;
    install(&app, update).await
}

async fn install(app: &AppHandle, update: Update) -> Result<(), String> {
    let mut done = 0u64;
    update.download_and_install(
        |chunk, total| {
            done += chunk as u64;
            let _ = app.emit_to(WINDOW, "update-progress", Progress { done, total });
        },
        || { let _ = app.emit_to(WINDOW, "update-installing", ()); },
    ).await.map_err(|e| e.to_string())?;
    app.restart()
}

/// "Skip This Version": checks Mark makes by itself pass over this one from now on.
#[tauri::command]
pub fn skip_update(app: AppHandle, version: String) -> Result<(), String> {
    let state = app.state::<Prefs>();
    let updated = { let mut prefs = state.0.lock().unwrap(); prefs.skipped_version = Some(version); prefs.clone() };
    settings::save(&app, &updated)
}

#[tauri::command]
pub fn set_auto_update(app: AppHandle, enabled: bool) -> Result<settings::Settings, String> {
    let state = app.state::<Prefs>();
    let updated = { let mut prefs = state.0.lock().unwrap(); prefs.check_updates = enabled; prefs.clone() };
    settings::save(&app, &updated)?;
    let _ = app.emit("settings-changed", &updated);
    Ok(updated)
}

/// "Check for Updates…", from the menu or from Settings.
#[tauri::command]
pub fn open_updates(app: AppHandle) -> Result<(), String> { show(&app, true) }

/// The Software Update window, brought forward if it is already open. Opened
/// to check, it looks for itself; opened because a check found something, it
/// shows what was found.
pub fn show(app: &AppHandle, check: bool) -> Result<(), String> {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => crate::panel(app, WINDOW, if check { "update.html?check" } else { "update.html" },
                             "Software Update", 520.0, 160.0)?,
    };
    crate::macos::activate_self();
    window.show().and_then(|_| window.set_focus()).map_err(|e| e.to_string())
}

/// Looks shortly after launch, then once a day by the clock on the wall, so a
/// Mac that slept through the night still looks in the morning. A check that
/// fails here -- offline, the site down -- says nothing: it is not worth a
/// window, and the next one will try again.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        let mut last: Option<SystemTime> = None;
        loop {
            let due = last.map_or(true, |at| at.elapsed().map_or(true, |since| since >= DAY));
            if due && app.state::<Prefs>().0.lock().unwrap().check_updates {
                last = Some(SystemTime::now());
                tauri::async_runtime::block_on(look(&app));
            }
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

async fn look(app: &AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return };
    if passed_over(&app.state::<Prefs>().0.lock().unwrap(), &update.version) { return; }
    *app.state::<Pending>().0.lock().unwrap() = Some(update.clone());
    // Only a build made to test updating end to end installs without asking.
    if cfg!(feature = "update-selftest") {
        if let Err(error) = install(app, update).await { eprintln!("[Mark] {error}"); }
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = show(&handle, false) { eprintln!("[Mark] {error}"); }
    });
}

/// A version the user said to skip is passed over by the checks Mark makes itself.
fn passed_over(prefs: &settings::Settings, version: &str) -> bool {
    prefs.skipped_version.as_deref() == Some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_skipped_version_is_passed_over() {
        let mut prefs = settings::Settings::default();
        assert!(!passed_over(&prefs, "0.5.0"));
        prefs.skipped_version = Some("0.5.0".into());
        assert!(passed_over(&prefs, "0.5.0"));
        // A newer one than the skipped is offered again.
        assert!(!passed_over(&prefs, "0.5.1"));
    }
}
