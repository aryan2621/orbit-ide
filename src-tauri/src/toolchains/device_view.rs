//! The Device pane: a live mirror of a Simulator/emulator/phone screen (repeated screenshots),
//! touch and key input for Android, and device tools (screenshot, recording, rotation, appearance,
//! location, deep links, text size). iOS input isn't possible without private APIs, so on iOS the
//! pane mirrors the screen and the Simulator window handles interaction.

use super::android::devices as adb_devices;
use crate::{children, env};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Response;
use tokio::io::AsyncWriteExt;

fn ios(platform: &str) -> bool {
    platform == "ios"
}

async fn adb_cmd(serial: &str) -> Result<tokio::process::Command, String> {
    let adb = adb_devices::adb_path().await.ok_or("adb isn't installed (Setup → Android)")?;
    Ok(adb_devices::adb(&adb, Some(serial)))
}

fn simctl(args: &[&str]) -> tokio::process::Command {
    let mut cmd = env::command("xcrun");
    cmd.arg("simctl").args(args);
    cmd
}

/// Runs a command with a timeout; returns stdout bytes or the stderr text.
async fn run(mut cmd: tokio::process::Command, secs: u64) -> Result<Vec<u8>, String> {
    cmd.kill_on_drop(true).stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(secs), cmd.output())
        .await
        .map_err(|_| "The device didn't respond in time".to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

async fn screenshot_png(platform: &str, id: &str) -> Result<Vec<u8>, String> {
    let png = if ios(platform) {
        run(simctl(&["io", id, "screenshot", "--type=png", "-"]), 10).await?
    } else {
        let mut cmd = adb_cmd(id).await?;
        cmd.args(["exec-out", "screencap", "-p"]);
        run(cmd, 10).await?
    };
    if !png.starts_with(b"\x89PNG") {
        return Err("The device didn't return a screenshot (is it fully booted and unlocked?)".into());
    }
    Ok(png)
}

/// The current screen as PNG bytes (an ArrayBuffer in the UI).
#[tauri::command]
pub async fn device_screenshot(platform: String, id: String) -> Result<Response, String> {
    screenshot_png(&platform, &id).await.map(Response::new)
}

fn desktop_file(prefix: &str, ext: &str) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = if home.join("Desktop").is_dir() { home.join("Desktop") } else { home };
    let stamp = std::process::Command::new("date").arg("+%Y-%m-%d at %H.%M.%S").output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    dir.join(format!("{prefix} {stamp}.{ext}"))
}

/// Saves a screenshot to the Desktop and returns its path.
#[tauri::command]
pub async fn device_save_screenshot(platform: String, id: String) -> Result<String, String> {
    let png = screenshot_png(&platform, &id).await?;
    let path = desktop_file("Orbit Screenshot", "png");
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ Android input

/// One long-lived `adb shell` per device, so each tap doesn't pay for starting adb on the Mac.
fn shells() -> &'static tokio::sync::Mutex<HashMap<String, tokio::process::Child>> {
    static SHELLS: OnceLock<tokio::sync::Mutex<HashMap<String, tokio::process::Child>>> = OnceLock::new();
    SHELLS.get_or_init(Default::default)
}

async fn shell_line(serial: &str, line: &str) -> Result<(), String> {
    let mut map = shells().lock().await;
    let alive = map.get_mut(serial).is_some_and(|c| matches!(c.try_wait(), Ok(None)));
    if !alive {
        let mut cmd = adb_cmd(serial).await?;
        cmd.arg("shell").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        children::own_group(&mut cmd);
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        children::track(child.id());
        map.insert(serial.to_owned(), child);
    }
    let child = map.get_mut(serial).ok_or("adb shell isn't running")?;
    let stdin = child.stdin.as_mut().ok_or("adb shell has no input")?;
    stdin.write_all(format!("{line}\n").as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

/// Quotes text for the device's `sh`, and escapes what `input text` treats specially.
fn input_text_arg(text: &str) -> String {
    // `input text` reads %s as a space.
    let t = text.replace('%', "\\%").replace(' ', "%s");
    format!("'{}'", t.replace('\'', "'\\''"))
}

/// Android input: `tap` (x, y), `swipe` (x, y, x2, y2, ms), `text` (text), `key` (Android keycode
/// name or number, e.g. KEYCODE_BACK). Coordinates are device pixels.
#[tauri::command]
pub async fn device_input(
    id: String,
    kind: String,
    x: Option<i32>,
    y: Option<i32>,
    x2: Option<i32>,
    y2: Option<i32>,
    ms: Option<u32>,
    text: Option<String>,
) -> Result<(), String> {
    let line = match kind.as_str() {
        "tap" => format!("input tap {} {}", x.ok_or("x")?, y.ok_or("y")?),
        "swipe" => format!("input swipe {} {} {} {} {}", x.ok_or("x")?, y.ok_or("y")?, x2.ok_or("x2")?, y2.ok_or("y2")?, ms.unwrap_or(250)),
        "text" => format!("input text {}", input_text_arg(&text.unwrap_or_default())),
        "key" => {
            let key = text.unwrap_or_default();
            if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err("Invalid key".into());
            }
            format!("input keyevent {key}")
        }
        other => return Err(format!("Unknown input: {other}")),
    };
    shell_line(&id, &line).await
}

// ------------------------------------------------------------------ device tools

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Device conditions and controls. `action` and `value`:
/// - `appearance`: "dark" | "light"
/// - `rotate` (Android emulators): turns the screen 90°
/// - `location`: "lat,lon"
/// - `openurl`: a URL or deep link
/// - `textsize`: "small" | "default" | "large" | "largest"
#[tauri::command]
pub async fn device_control(platform: String, id: String, action: String, value: Option<String>) -> Result<(), String> {
    let value = value.unwrap_or_default();
    if ios(&platform) {
        let cmd = match action.as_str() {
            "appearance" => simctl(&["ui", &id, "appearance", if value == "dark" { "dark" } else { "light" }]),
            "location" => simctl(&["location", &id, "set", &value]),
            "openurl" => simctl(&["openurl", &id, &value]),
            "textsize" => {
                let size = match value.as_str() {
                    "small" => "small",
                    "large" => "extra-large",
                    "largest" => "accessibility-extra-extra-extra-large",
                    _ => "large", // iOS's default content size
                };
                simctl(&["ui", &id, "content_size", size])
            }
            "rotate" => return Err("Rotate the Simulator from its window (⌘→)".into()),
            other => return Err(format!("Unknown action: {other}")),
        };
        return run(cmd, 20).await.map(|_| ());
    }
    let mut cmd = adb_cmd(&id).await?;
    match action.as_str() {
        "appearance" => cmd.args(["shell", "cmd", "uimode", "night", if value == "dark" { "yes" } else { "no" }]),
        "rotate" => {
            if !id.starts_with("emulator-") {
                return Err("Rotation from Orbit works on emulators; turn the phone itself".into());
            }
            cmd.args(["emu", "rotate"])
        }
        "location" => {
            if !id.starts_with("emulator-") {
                return Err("Setting the location works on emulators only".into());
            }
            let (lat, lon) = value.split_once(',').ok_or("Use the form latitude,longitude")?;
            let (lat, lon) = (lat.trim().parse::<f64>().map_err(|_| "Invalid latitude")?, lon.trim().parse::<f64>().map_err(|_| "Invalid longitude")?);
            // `geo fix` takes longitude first.
            cmd.args(["emu", "geo", "fix", &lon.to_string(), &lat.to_string()])
        }
        "openurl" => cmd.args(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", &shell_quote(&value)]),
        "textsize" => {
            let scale = match value.as_str() {
                "small" => "0.85",
                "large" => "1.3",
                "largest" => "2.0",
                _ => "1.0",
            };
            cmd.args(["shell", "settings", "put", "system", "font_scale", scale])
        }
        other => return Err(format!("Unknown action: {other}")),
    };
    let out = run(cmd, 20).await?;
    let text = String::from_utf8_lossy(&out);
    if text.contains("Error") || text.contains("KO") {
        return Err(text.trim().to_owned());
    }
    Ok(())
}

// ------------------------------------------------------------------ screen recording

struct Recording {
    child: tokio::process::Child,
    /// Where the video ends up on the Mac.
    path: PathBuf,
    /// Android: the file on the device, pulled when recording stops.
    remote: Option<String>,
}

fn recordings() -> &'static Mutex<HashMap<String, Recording>> {
    static REC: OnceLock<Mutex<HashMap<String, Recording>>> = OnceLock::new();
    REC.get_or_init(Default::default)
}

#[tauri::command]
pub async fn device_record_start(platform: String, id: String) -> Result<(), String> {
    if crate::process::lock(recordings()).contains_key(&id) {
        return Err("Already recording this device".into());
    }
    let path = desktop_file("Orbit Recording", "mp4");
    let (mut cmd, remote) = if ios(&platform) {
        let mut c = simctl(&["io", &id, "recordVideo", "--codec=h264", "--force"]);
        c.arg(&path);
        (c, None)
    } else {
        let remote = "/sdcard/orbit-recording.mp4".to_owned();
        let mut c = adb_cmd(&id).await?;
        // Android caps a recording at 3 minutes.
        c.args(["shell", "screenrecord", "--time-limit", "180", &remote]);
        (c, Some(remote))
    };
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    children::own_group(&mut cmd);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    children::track(child.id());
    crate::process::lock(recordings()).insert(id, Recording { child, path, remote });
    Ok(())
}

/// Stops recording and returns the video's path on the Mac.
#[tauri::command]
pub async fn device_record_stop(id: String) -> Result<String, String> {
    let rec = crate::process::lock(recordings()).remove(&id).ok_or("Not recording")?;
    let Recording { mut child, path, remote } = rec;
    let pid = child.id();
    // SIGINT lets both recorders finish the file properly.
    if let Some(pid) = pid {
        children::signal_group(pid, libc::SIGINT);
    }
    if tokio::time::timeout(Duration::from_secs(10), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    children::untrack(pid);
    if let Some(remote) = remote {
        // Stopping the adb client doesn't always stop screenrecord on the device; make sure it
        // has finished writing before pulling the file.
        let mut stop = adb_cmd(&id).await?;
        stop.args(["shell", "pkill", "-INT", "screenrecord"]);
        let _ = run(stop, 10).await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let mut pull = adb_cmd(&id).await?;
        pull.arg("pull").arg(&remote).arg(&path);
        run(pull, 60).await?;
        let mut rm = adb_cmd(&id).await?;
        rm.args(["shell", "rm", "-f", &remote]);
        let _ = run(rm, 10).await;
    }
    if !path.is_file() {
        return Err("The recording couldn't be saved".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ app tools

/// The bundle id (iOS) or applicationId (Android) of the open project's app.
#[tauri::command]
pub async fn device_app_id(root: String, scheme: String, configuration: String) -> Result<String, String> {
    if let Some(project) = super::android::project::detect(&root) {
        let script = super::android::project::app_build_script(&project).ok_or("No application module found")?;
        let text = std::fs::read_to_string(&script).map_err(|e| e.to_string())?;
        return text
            .lines()
            .find_map(|l| {
                let rest = l.trim().strip_prefix("applicationId")?;
                let start = rest.find(['"', '\''])? + 1;
                let end = rest[start..].find(['"', '\''])? + start;
                Some(rest[start..end].to_owned())
            })
            .ok_or_else(|| "Couldn't read applicationId from the build script".into());
    }
    let project = super::ios::project::detect(&root).ok_or("No Xcode project found")?;
    if scheme.is_empty() {
        return Err("Choose a scheme in the toolbar first".into());
    }
    let mut cmd = super::ios::build::xcodebuild_command(&project, &scheme, &configuration, "generic/platform=iOS Simulator");
    cmd.args(["-showBuildSettings", "-json"]);
    let out = run(cmd, 60).await?;
    let stdout = String::from_utf8_lossy(&out);
    let json: serde_json::Value = stdout.find('[').and_then(|i| serde_json::from_str(&stdout[i..]).ok()).unwrap_or_default();
    super::ios::run::find_app_product(&json).map(|(_, id)| id).ok_or_else(|| "This scheme doesn't build an iOS app".into())
}

/// Simulator privacy services and the Android permissions they map to.
fn android_permissions(service: &str) -> &'static [&'static str] {
    match service {
        "camera" => &["android.permission.CAMERA"],
        "microphone" => &["android.permission.RECORD_AUDIO"],
        "location" => &["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
        "location-always" => &["android.permission.ACCESS_BACKGROUND_LOCATION"],
        "contacts" => &["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
        "calendar" => &["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
        "photos" => &["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO"],
        "notifications" => &["android.permission.POST_NOTIFICATIONS"],
        _ => &[],
    }
}

/// Tools that act on the app installed on a device:
/// - `push` (Simulator): `value` is the APNs payload JSON
/// - `grant` / `revoke` / `reset`: `value` is a privacy service (camera, photos, location, …; `all` for reset)
/// - `statusbar`: `value` "clean" (9:41, full battery and signal) or "clear"
/// - `appdata` (Simulator): opens the app's data container in Finder; returns its path
#[tauri::command]
pub async fn device_app_tool(platform: String, id: String, app_id: String, action: String, value: Option<String>) -> Result<String, String> {
    let value = value.unwrap_or_default();
    if app_id.is_empty() && action != "statusbar" {
        return Err("The app's identifier isn't known".into());
    }
    if ios(&platform) {
        if id.len() != 36 {
            // Physical devices have 25-character UDIDs; simctl only drives Simulators.
            return Err("These tools work on Simulators; use Settings on the device".into());
        }
        match action.as_str() {
            "push" => {
                let payload: serde_json::Value = serde_json::from_str(&value).map_err(|e| format!("The payload isn't valid JSON: {e}"))?;
                if payload.get("aps").is_none() {
                    return Err("The payload needs an \"aps\" dictionary".into());
                }
                let file = std::env::temp_dir().join(format!("orbit-push-{}.apns", std::process::id()));
                std::fs::write(&file, value.as_bytes()).map_err(|e| e.to_string())?;
                let result = run(simctl(&["push", &id, &app_id, &file.to_string_lossy()]), 20).await;
                let _ = std::fs::remove_file(&file);
                result?;
            }
            "grant" | "revoke" | "reset" => {
                run(simctl(&["privacy", &id, &action, &value, &app_id]), 20).await?;
            }
            "statusbar" if value == "clean" => {
                run(
                    simctl(&[
                        "status_bar", &id, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
                        "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100",
                    ]),
                    20,
                )
                .await?;
            }
            "statusbar" => {
                run(simctl(&["status_bar", &id, "clear"]), 20).await?;
            }
            "appdata" => {
                let out = run(simctl(&["get_app_container", &id, &app_id, "data"]), 20)
                    .await
                    .map_err(|e| if e.contains("No such file") || e.contains("not installed") { "Run the app on this Simulator first".into() } else { e })?;
                let path = String::from_utf8_lossy(&out).trim().to_owned();
                env::command("open").arg(&path).status().await.map_err(|e| e.to_string())?;
                return Ok(path);
            }
            other => return Err(format!("Unknown action: {other}")),
        }
        return Ok(String::new());
    }

    let shell = |args: &str| {
        let args = args.to_owned();
        let id = id.clone();
        async move {
            let mut cmd = adb_cmd(&id).await?;
            cmd.args(["shell", &args]);
            let out = run(cmd, 20).await?;
            let text = String::from_utf8_lossy(&out).trim().to_owned();
            if text.contains("Exception") || text.starts_with("Error") {
                return Err(text);
            }
            Ok::<_, String>(text)
        }
    };
    match action.as_str() {
        "push" => return Err("Android notifications come from Firebase Cloud Messaging; send a test message from the Firebase console".into()),
        "appdata" => return Err("Android app data lives on the device; use `adb shell run-as` or Android Studio's Device Explorer".into()),
        "grant" | "revoke" => {
            let perms = android_permissions(&value);
            if perms.is_empty() {
                return Err(format!("No Android permission for {value}"));
            }
            let pkg = shell_quote(&app_id);
            let mut granted = 0;
            let mut last_error = None;
            for p in perms {
                // Permissions the app doesn't request fail; that's fine as long as one applies.
                match shell(&format!("pm {action} {pkg} {p}")).await {
                    Ok(_) => granted += 1,
                    Err(e) => last_error = Some(e),
                }
            }
            if granted == 0 {
                return Err(last_error.unwrap_or_default().lines().next().unwrap_or("The app doesn't request this permission").to_owned());
            }
        }
        "reset" => {
            // Revokes runtime permissions and clears their user-set flags, so the app asks again.
            let pkg = shell_quote(&app_id);
            let perms: Vec<&str> = if value == "all" {
                ["camera", "microphone", "location", "location-always", "contacts", "calendar", "photos", "notifications"].iter().flat_map(|s| android_permissions(s).iter().copied()).collect()
            } else {
                android_permissions(&value).to_vec()
            };
            for p in perms {
                let _ = shell(&format!("pm revoke {pkg} {p}; pm clear-permission-flags {pkg} {p} user-set user-fixed")).await;
            }
        }
        "statusbar" if value == "clean" => {
            let demo = "am broadcast -a com.android.systemui.demo -e command";
            shell(&format!(
                "settings put global sysui_demo_allowed 1; {demo} enter; {demo} clock -e hhmm 0941; \
                 {demo} battery -e level 100 -e plugged false; {demo} network -e wifi show -e level 4; \
                 {demo} network -e mobile show -e datatype none -e level 4; {demo} notifications -e visible false"
            ))
            .await?;
        }
        "statusbar" => {
            shell("am broadcast -a com.android.systemui.demo -e command exit").await?;
        }
        other => return Err(format!("Unknown action: {other}")),
    }
    Ok(String::new())
}
