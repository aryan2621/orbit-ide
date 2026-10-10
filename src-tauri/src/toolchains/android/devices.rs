//! Connected phones and running emulators (adb), plus emulators that exist but aren't started (AVDs).

use super::sdk;
use crate::env;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Emulator,
    Device,
}

/// Same shape as the iOS `Device`, so the toolbar's device picker can show both.
#[derive(Serialize, Clone, Debug)]
pub struct Device {
    /// adb serial (`emulator-5554`, `R5CR…`, `192.168.1.5:5555`), or `avd:<name>` for an emulator that isn't running.
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
    /// e.g. "Android 16", or "API 36" for an emulator that isn't running.
    pub os: String,
    /// Running and ready for adb (an authorized phone, or a started emulator).
    pub booted: bool,
}

pub const AVD_PREFIX: &str = "avd:";

/// The adb binary from the SDK, or from PATH.
pub async fn adb_path() -> Option<PathBuf> {
    let shell = sdk::shell_env().await;
    sdk::adb(&sdk::sdk_root(&shell)).or_else(|| env::which("adb").map(PathBuf::from))
}

pub fn adb(adb: &PathBuf, serial: Option<&str>) -> tokio::process::Command {
    let mut cmd = env::command(&adb.to_string_lossy());
    if let Some(s) = serial {
        cmd.args(["-s", s]);
    }
    cmd
}

/// Runs an adb command and returns its trimmed stdout, or None if it failed.
pub async fn adb_output(adb_bin: &PathBuf, serial: Option<&str>, args: &[&str]) -> Option<String> {
    let out = adb(adb_bin, serial).args(args).output().await.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[derive(Debug, PartialEq)]
pub struct AdbEntry {
    pub serial: String,
    /// `device`, `offline`, `unauthorized`, …
    pub state: String,
    pub model: Option<String>,
}

/// Parses `adb devices -l`.
pub fn parse_adb_devices(out: &str) -> Vec<AdbEntry> {
    out.lines()
        .filter(|l| !l.starts_with("List of devices") && !l.starts_with('*') && !l.trim().is_empty())
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?.to_owned();
            let state = parts.next()?.to_owned();
            let model = parts.find_map(|p| p.strip_prefix("model:")).map(|m| m.replace('_', " "));
            Some(AdbEntry { serial, state, model })
        })
        .collect()
}

/// Running adb devices with their AVD names (for emulators).
pub async fn connected(adb_bin: &PathBuf) -> Vec<(AdbEntry, Option<String>)> {
    let Some(out) = adb_output(adb_bin, None, &["devices", "-l"]).await else { return Vec::new() };
    let mut result = Vec::new();
    for entry in parse_adb_devices(&out) {
        let avd = if entry.serial.starts_with("emulator-") && entry.state == "device" {
            // Prints the AVD name, then "OK".
            adb_output(adb_bin, Some(&entry.serial), &["emu", "avd", "name"]).await.and_then(|o| o.lines().next().map(|l| l.trim().to_owned()))
        } else {
            None
        };
        result.push((entry, avd));
    }
    result
}

/// API level of an AVD that isn't running, from its config.ini (`image.sysdir.1=system-images/android-36.1/…`).
fn avd_api(name: &str) -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let ini = std::fs::read_to_string(home.join(".android/avd").join(format!("{name}.ini"))).ok()?;
    let dir = ini.lines().find_map(|l| l.strip_prefix("path="))?;
    let config = std::fs::read_to_string(PathBuf::from(dir.trim()).join("config.ini")).ok()?;
    let sysdir = config.lines().find_map(|l| l.strip_prefix("image.sysdir.1="))?;
    sysdir.split('/').find_map(|p| p.strip_prefix("android-")).map(|api| format!("API {api}"))
}

#[tauri::command]
pub async fn android_devices() -> Vec<Device> {
    let shell = sdk::shell_env().await;
    let Some(adb_bin) = adb_path().await else { return Vec::new() };
    let mut devices = Vec::new();
    let mut running_avds = Vec::new();
    for (entry, avd) in connected(&adb_bin).await {
        let emulator = entry.serial.starts_with("emulator-");
        let ready = entry.state == "device";
        let os = if ready {
            adb_output(&adb_bin, Some(&entry.serial), &["shell", "getprop", "ro.build.version.release"]).await.map(|v| format!("Android {v}")).unwrap_or_default()
        } else {
            String::new()
        };
        let base = avd.clone().map(|a| a.replace('_', " ")).or(entry.model.clone()).unwrap_or_else(|| entry.serial.clone());
        let name = match entry.state.as_str() {
            "device" => base,
            "unauthorized" => format!("{base} (allow USB debugging on the phone)"),
            state => format!("{base} ({state})"),
        };
        if let Some(a) = avd {
            running_avds.push(a);
        }
        devices.push(Device { id: entry.serial, name, kind: if emulator { DeviceKind::Emulator } else { DeviceKind::Device }, os, booted: ready });
    }
    for avd in sdk::avds(&shell) {
        if !running_avds.contains(&avd) {
            devices.push(Device {
                id: format!("{AVD_PREFIX}{avd}"),
                name: avd.replace('_', " "),
                kind: DeviceKind::Emulator,
                os: avd_api(&avd).unwrap_or_default(),
                booted: false,
            });
        }
    }
    devices
}

/// Starts an AVD (if it isn't already running) and waits until Android has finished booting.
/// Returns its adb serial. `log` reports progress; `cancelled` is polled while waiting.
pub async fn boot_avd(adb_bin: &PathBuf, name: &str, log: impl Fn(String), cancelled: impl Fn() -> bool) -> Result<String, String> {
    let find = || async {
        connected(adb_bin).await.into_iter().find(|(e, avd)| avd.as_deref() == Some(name) && e.state == "device").map(|(e, _)| e.serial)
    };
    let serial = match find().await {
        Some(s) => s,
        None => {
            let shell = sdk::shell_env().await;
            let emulator = sdk::emulator(&sdk::sdk_root(&shell)).ok_or("The Android emulator isn't installed (Setup → Android)")?;
            log(format!("Starting emulator {}…", name.replace('_', " ")));
            // Detached on purpose: the emulator keeps running after this job (and Orbit) ends.
            std::process::Command::new(emulator)
                .args(["-avd", name, "-no-snapshot-save"])
                .env("PATH", env::path())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("Couldn't start the emulator: {e}"))?;
            let started = Instant::now();
            loop {
                if cancelled() {
                    return Err("Cancelled".into());
                }
                if let Some(s) = find().await {
                    break s;
                }
                if started.elapsed() > Duration::from_secs(120) {
                    return Err("The emulator didn't start within 2 minutes".into());
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    };
    let started = Instant::now();
    let mut announced = false;
    loop {
        if adb_output(adb_bin, Some(&serial), &["shell", "getprop", "sys.boot_completed"]).await.as_deref() == Some("1") {
            return Ok(serial);
        }
        if !announced {
            log("Waiting for Android to finish booting…".into());
            announced = true;
        }
        if cancelled() {
            return Err("Cancelled".into());
        }
        if started.elapsed() > Duration::from_secs(300) {
            return Err("The emulator didn't finish booting within 5 minutes".into());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Wireless debugging (Android 11+): pair with the code shown under Developer options → Wireless debugging.
#[tauri::command]
pub async fn android_pair(host: String, code: String) -> Result<String, String> {
    let adb_bin = adb_path().await.ok_or("adb isn't installed (Setup → Android)")?;
    let out = adb(&adb_bin, None).args(["pair", &host, &code]).output().await.map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_owned();
    if out.status.success() && text.contains("Successfully paired") {
        Ok(text)
    } else {
        Err(text)
    }
}

/// Connects to a paired phone over Wi-Fi (`host:port` from the Wireless debugging screen).
#[tauri::command]
pub async fn android_connect(host: String) -> Result<String, String> {
    let adb_bin = adb_path().await.ok_or("adb isn't installed (Setup → Android)")?;
    let out = adb(&adb_bin, None).args(["connect", &host]).output().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if text.starts_with("connected to") || text.starts_with("already connected") {
        Ok(text)
    } else {
        Err(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_adb_devices() {
        let out = "* daemon started successfully\nList of devices attached\n\
            emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\
            R5CR1234ABC            unauthorized usb:1-1 transport_id:2\n\
            192.168.1.5:41234      device product:husky model:Pixel_8_Pro device:husky transport_id:3\n\n";
        let d = parse_adb_devices(out);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0], AdbEntry { serial: "emulator-5554".into(), state: "device".into(), model: Some("sdk gphone64 arm64".into()) });
        assert_eq!((d[1].state.as_str(), d[1].model.as_deref()), ("unauthorized", None));
        assert_eq!(d[2].model.as_deref(), Some("Pixel 8 Pro"));
    }
}

