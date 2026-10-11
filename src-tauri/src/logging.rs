//! Append-only log at `~/Library/Logs/Orbit/orbit.log`, rotated to `orbit.log.1` at 5 MB. Holds
//! Rust-side diagnostics and errors forwarded from the UI; nothing is uploaded anywhere.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::process::lock;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

static WRITE: Mutex<()> = Mutex::new(());

pub fn log_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Library/Logs/Orbit")
}

pub fn log_file() -> PathBuf {
    log_dir().join("orbit.log")
}

/// Appends one line (prefixed with a UTC timestamp). Never fails loudly: logging must not break Orbit.
pub fn write(message: impl AsRef<str>) {
    let _guard = lock(&WRITE);
    let path = log_file();
    if fs::create_dir_all(log_dir()).is_err() {
        return;
    }
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", timestamp(), message.as_ref().trim_end());
    }
}

/// `YYYY-MM-DD HH:MM:SS` in UTC, without pulling in a date crate.
fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Records Rust panics in the log before the (release: abort) unwinding takes the app down.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write(format!("panic: {info}"));
        previous(info);
    }));
}

/// Errors and warnings forwarded from the UI.
#[tauri::command]
pub fn log_write(level: String, message: String) {
    write(format!("[ui {level}] {message}"));
}

/// Path of the log file, for "Help: Open Logs" (revealed by the opener plugin).
#[tauri::command]
pub fn log_path() -> String {
    write("log opened");
    log_file().to_string_lossy().into_owned()
}

#[derive(serde::Serialize)]
pub struct AppInfo {
    version: &'static str,
    macos: String,
    arch: &'static str,
}

/// Version info for problem reports and the About line.
#[tauri::command]
pub async fn app_info() -> AppInfo {
    let macos = crate::env::command("sw_vers")
        .arg("-productVersion")
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    AppInfo { version: env!("CARGO_PKG_VERSION"), macos, arch: std::env::consts::ARCH }
}
