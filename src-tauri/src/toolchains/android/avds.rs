//! Emulator management for the Device Manager: list what an AVD can be created from, create,
//! start (normally, cold or wiped), stop and delete AVDs.

use super::devices::{self, adb_output, emulator_failure, spawn_emulator};
use super::sdk;
use crate::env;
use serde::Serialize;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Serialize)]
pub struct Choice {
    pub id: String,
    pub name: String,
}

/// Hardware profiles (Pixel 9, Medium Phone…) and installed system images.
#[derive(Serialize, Default)]
pub struct AvdOptions {
    pub devices: Vec<Choice>,
    pub images: Vec<Choice>,
}

/// `avdmanager` with the JDK it needs.
async fn avdmanager() -> Result<tokio::process::Command, String> {
    let shell = sdk::shell_env().await;
    let root = sdk::sdk_root(&shell);
    let tool = sdk::cmdline_tool(&root, "avdmanager").ok_or("The Android command-line tools aren't installed (Setup → Android)")?;
    let mut cmd = env::command(&tool.to_string_lossy());
    cmd.env("ANDROID_HOME", &root).env("ANDROID_SDK_ROOT", &root).env("ANDROID_AVD_HOME", sdk::avd_home(&shell)).kill_on_drop(true);
    if let Some(home) = sdk::find_jdk(&shell).await.and_then(|j| j.home) {
        cmd.env("JAVA_HOME", home);
    }
    Ok(cmd)
}

/// Parses `avdmanager list device`: `id: 37 or "pixel_8"` followed by `Name: Pixel 8`.
fn parse_devices(out: &str) -> Vec<Choice> {
    let mut list = Vec::new();
    let mut id: Option<String> = None;
    for line in out.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("id:") {
            id = rest.split('"').nth(1).map(str::to_owned);
        } else if let (Some(name), Some(i)) = (line.strip_prefix("Name:"), id.take()) {
            list.push(Choice { id: i, name: name.trim().to_owned() });
        }
    }
    // Phones and tablets people actually pick first; the rest after.
    let rank = |c: &Choice| if c.name.contains("Pixel") { 0 } else if c.name.contains("Medium") || c.name.contains("Small") { 1 } else { 2 };
    list.sort_by_key(|c| rank(c));
    list.retain(|c| !c.name.contains("Wear") && !c.name.contains("TV") && !c.name.contains("Automotive"));
    list
}

#[tauri::command]
pub async fn android_avd_options() -> Result<AvdOptions, String> {
    let mut cmd = avdmanager().await?;
    cmd.args(["list", "device"]);
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output()).await.map_err(|_| "avdmanager timed out")?.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    let root = sdk::sdk_root(&sdk::shell_env().await);
    let images = sdk::system_images(&root)
        .into_iter()
        .rev()
        .map(|id| {
            // system-images;android-36;google_apis_playstore;arm64-v8a → "Android API 36 · google_apis_playstore · arm64-v8a"
            let parts: Vec<&str> = id.split(';').collect();
            let api = parts.get(1).map(|a| a.replace("android-", "API ")).unwrap_or_default();
            let name = format!("{api} · {} · {}", parts.get(2).unwrap_or(&""), parts.get(3).unwrap_or(&""));
            Choice { id, name }
        })
        .collect();
    Ok(AvdOptions { devices: parse_devices(&String::from_utf8_lossy(&out.stdout)), images })
}

/// AVD names may only use letters, digits, `.`, `_` and `-`.
fn avd_name(name: &str) -> Result<String, String> {
    let n: String = name.trim().replace(' ', "_");
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("Use letters, digits, spaces, '.', '_' or '-' in the name".into());
    }
    Ok(n)
}

#[tauri::command]
pub async fn android_avd_create(name: String, device: String, image: String) -> Result<String, String> {
    let name = avd_name(&name)?;
    if sdk::avds(&sdk::shell_env().await).contains(&name) {
        return Err(format!("An emulator named {name} already exists"));
    }
    let mut cmd = avdmanager().await?;
    cmd.args(["create", "avd", "-n", &name, "-k", &image, "-d", &device])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // "Do you wish to create a custom hardware profile? [no]"
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"no\n").await;
    }
    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output()).await.map_err(|_| "avdmanager timed out")?.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let text = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
        let line = text.lines().find(|l| l.contains("Error")).unwrap_or(text.trim()).trim().to_owned();
        return Err(line);
    }
    Ok(name)
}

/// The adb serial of AVD `name` if it's running.
async fn running_serial(name: &str) -> Option<String> {
    let adb = devices::adb_path().await?;
    devices::connected(&adb).await.into_iter().find(|(_, avd)| avd.as_deref() == Some(name)).map(|(e, _)| e.serial)
}

/// `start`, `coldboot` (ignore the snapshot), `wipe` (erase data, then start), `stop` or `delete`.
#[tauri::command]
pub async fn android_avd_action(name: String, action: String) -> Result<(), String> {
    let running = running_serial(&name).await;
    let start = |flags: &'static [&'static str]| {
        let name = name.clone();
        async move {
            let (mut child, log) = spawn_emulator(&name, flags).await?;
            // Catch an immediate failure (locked AVD, missing image), then let it run.
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("The emulator quit while starting ({status}). {}", emulator_failure(&log)));
            }
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
    };
    match action.as_str() {
        "start" if running.is_some() => Ok(()),
        "start" => start(&[]).await,
        "coldboot" | "wipe" | "delete" if running.is_some() => Err(format!("Shut down {} first", name.replace('_', " "))),
        "coldboot" => start(&["-no-snapshot-load"]).await,
        "wipe" => start(&["-wipe-data"]).await,
        "stop" => match running {
            Some(serial) => {
                let adb = devices::adb_path().await.ok_or("adb isn't installed")?;
                adb_output(&adb, Some(&serial), &["emu", "kill"]).await.map(|_| ()).ok_or_else(|| format!("Couldn't stop {serial}"))
            }
            None => Ok(()),
        },
        "delete" => {
            let mut cmd = avdmanager().await?;
            cmd.args(["delete", "avd", "-n", &name]);
            let out = cmd.output().await.map_err(|e| e.to_string())?;
            if out.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
            }
        }
        other => Err(format!("Unknown action: {other}")),
    }
}
