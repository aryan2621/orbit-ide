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
    /// The AVD name, for emulators (running or not).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avd: Option<String>,
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
            let mut state = parts.next()?.to_owned();
            // Linux: "no permissions (missing udev rules?…)" — keep it readable.
            if state == "no" && l.contains("no permissions") {
                state = "no permissions".into();
            }
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
fn avd_api(avd_home: &std::path::Path, name: &str) -> Option<String> {
    let ini = std::fs::read_to_string(avd_home.join(format!("{name}.ini"))).ok()?;
    // `path=` is absolute; `path.rel=` is relative to the AVD home's parent (~/.android).
    let dir = match ini.lines().find_map(|l| l.strip_prefix("path=")) {
        Some(abs) if std::path::Path::new(abs.trim()).is_dir() => PathBuf::from(abs.trim()),
        _ => {
            let rel = ini.lines().find_map(|l| l.strip_prefix("path.rel="))?;
            avd_home.parent()?.join(rel.trim())
        }
    };
    let config = std::fs::read_to_string(dir.join("config.ini")).ok()?;
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
        if let Some(a) = &avd {
            running_avds.push(a.clone());
        }
        devices.push(Device { id: entry.serial, name, kind: if emulator { DeviceKind::Emulator } else { DeviceKind::Device }, os, booted: ready, avd });
    }
    for avd in sdk::avds(&shell) {
        if !running_avds.contains(&avd) {
            devices.push(Device {
                id: format!("{AVD_PREFIX}{avd}"),
                name: avd.replace('_', " "),
                kind: DeviceKind::Emulator,
                os: avd_api(&sdk::avd_home(&shell), &avd).unwrap_or_default(),
                booted: false,
                avd: Some(avd.clone()),
            });
        }
    }
    devices
}

/// Launches the emulator for AVD `name` with `extra` flags. Its output goes to a log file (returned)
/// so a failed start can explain itself. Detached in its own process group on purpose: the emulator
/// keeps running after the job (and Orbit) ends, so the next run doesn't boot it again.
pub async fn spawn_emulator(name: &str, extra: &[&str]) -> Result<(std::process::Child, PathBuf), String> {
    let shell = sdk::shell_env().await;
    let root = sdk::sdk_root(&shell);
    let emulator = sdk::emulator(&root).ok_or("The Android emulator isn't installed (Setup → Android)")?;
    let log_path = std::env::temp_dir().join(format!("orbit-emulator-{name}.log"));
    let log_file = std::fs::File::create(&log_path).map_err(|e| format!("Couldn't create the emulator log: {e}"))?;
    let log_err = log_file.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(emulator);
    // Snapshots make the next start a quick resume instead of a full cold boot.
    cmd.args(["-avd", name])
        .args(extra)
        .env("PATH", env::path())
        .env("ANDROID_HOME", &root)
        .env("ANDROID_SDK_ROOT", &root)
        .env("ANDROID_AVD_HOME", sdk::avd_home(&shell))
        .stdin(std::process::Stdio::null())
        .stdout(log_file)
        .stderr(log_err);
    crate::children::own_group_std(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Couldn't start the emulator: {e}"))?;
    Ok((child, log_path))
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
            log(format!("Starting emulator {}…", name.replace('_', " ")));
            let (mut child, log_path) = spawn_emulator(name, &[]).await?;
            let started = Instant::now();
            let serial = loop {
                if cancelled() {
                    return Err("Cancelled".into());
                }
                if let Some(s) = find().await {
                    break s;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("The emulator quit while starting ({status}). {}", emulator_failure(&log_path)));
                }
                if started.elapsed() > Duration::from_secs(180) {
                    return Err(format!("The emulator didn't start within 3 minutes. {}", emulator_failure(&log_path)));
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            };
            // Reap it whenever it exits so it doesn't linger as a zombie while Orbit runs.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            serial
        }
    };
    let started = Instant::now();
    let mut announced = false;
    loop {
        // boot_completed can be set a moment before the package manager takes installs.
        if adb_output(adb_bin, Some(&serial), &["shell", "getprop", "sys.boot_completed"]).await.as_deref() == Some("1")
            && adb_output(adb_bin, Some(&serial), &["shell", "pm", "path", "android"]).await.is_some_and(|o| o.contains("package:"))
        {
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

/// The most useful lines of the emulator's log after a failed start.
pub fn emulator_failure(log_path: &std::path::Path) -> String {
    let text = std::fs::read_to_string(log_path).unwrap_or_default();
    let important: Vec<&str> = text
        .lines()
        .filter(|l| l.contains("ERROR") || l.contains("FATAL") || l.contains("PANIC") || l.contains("error"))
        .collect();
    let lines: Vec<&str> = if important.is_empty() { text.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect() } else { important.into_iter().rev().take(5).rev().collect() };
    let hint = if text.contains("Running multiple emulators with the same AVD") || text.contains(".lock") {
        " This AVD seems to be running already (or left a stale lock): close other emulators, or delete the *.lock files in its .avd folder."
    } else if text.contains("Not enough space") || text.contains("No space left") {
        " The disk is almost full; free some space."
    } else {
        ""
    };
    if lines.is_empty() {
        format!("Full log: {}", log_path.display())
    } else {
        format!("{}{hint} (full log: {})", lines.join(" | "), log_path.display())
    }
}

/// Shuts down a running emulator (`adb emu kill`).
#[tauri::command]
pub async fn android_emulator_stop(serial: String) -> Result<(), String> {
    if !serial.starts_with("emulator-") {
        return Err("Only emulators can be shut down from Orbit".into());
    }
    let adb_bin = adb_path().await.ok_or("adb isn't installed (Setup → Android)")?;
    adb_output(&adb_bin, Some(&serial), &["emu", "kill"]).await.map(|_| ()).ok_or_else(|| format!("Couldn't stop {serial}"))
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
