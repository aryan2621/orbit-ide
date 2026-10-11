//! Auto-update from GitHub Releases (`latest.json`, signed with the updater key).
//! The frontend checks on launch (at most daily) and from "Orbit: Check for Updates".

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    received: u64,
    total: Option<u64>,
}

/// The newer release, or None when up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    }))
}

/// Downloads, verifies the signature, installs and restarts. Emits `update://progress`.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Orbit is already up to date.")?;
    crate::logging::write(format!("Installing update {}", update.version));
    let mut received = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let _ = progress.emit("update://progress", Progress { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // Stop child processes (llama-server, language servers) before relaunching.
    crate::children::kill_all();
    app.restart();
}
