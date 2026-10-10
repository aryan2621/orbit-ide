//! Locates the Android SDK, its tools and packages, and the JDK, the same way Gradle and the SDK
//! tools do. Package checks read the SDK folder directly: it's instant, whereas every sdkmanager
//! call starts a JVM.

use crate::env;
use std::path::{Path, PathBuf};

/// The Android Gradle Plugin needs JDK 17 or newer.
pub const MIN_JDK: u32 = 17;

/// Environment the SDK tools read, taken from the user's shell.
pub struct ShellEnv {
    /// ANDROID_HOME, or the deprecated ANDROID_SDK_ROOT.
    pub android_home: Option<String>,
    pub java_home: Option<String>,
    pub avd_home: Option<String>,
}

pub async fn shell_env() -> ShellEnv {
    let mut vars = env::shell_vars(&["ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME", "ANDROID_AVD_HOME"]).await;
    ShellEnv {
        android_home: vars.remove("ANDROID_HOME").or_else(|| vars.remove("ANDROID_SDK_ROOT")),
        java_home: vars.remove("JAVA_HOME"),
        avd_home: vars.remove("ANDROID_AVD_HOME"),
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// Where Android Studio puts the SDK, used when ANDROID_HOME isn't set.
pub fn default_sdk_root() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/Android/sdk")
    } else {
        home().join("Android/Sdk")
    }
}

pub fn sdk_root(env: &ShellEnv) -> PathBuf {
    env.android_home.as_ref().map(PathBuf::from).unwrap_or_else(default_sdk_root)
}

/// ABI of system images that run natively on this machine.
pub fn host_abi() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64-v8a"
    } else {
        "x86_64"
    }
}

/// `cmdline-tools/latest/bin/<tool>`, or the newest versioned cmdline-tools folder that has it.
pub fn cmdline_tool(root: &Path, tool: &str) -> Option<PathBuf> {
    let dir = root.join("cmdline-tools");
    let latest = dir.join("latest/bin").join(tool);
    if latest.is_file() {
        return Some(latest);
    }
    packages(&dir).into_iter().rev().map(|v| dir.join(v).join("bin").join(tool)).find(|p| p.is_file())
}

pub fn emulator(root: &Path) -> Option<PathBuf> {
    Some(root.join("emulator/emulator")).filter(|p| p.is_file())
}

pub fn adb(root: &Path) -> Option<PathBuf> {
    Some(root.join("platform-tools/adb")).filter(|p| p.is_file())
}

/// Revision of an installed package, from its `source.properties`.
pub fn revision(package_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(package_dir.join("source.properties")).ok()?;
    text.lines().find_map(|l| l.strip_prefix("Pkg.Revision=")).map(|v| v.trim().to_owned())
}

/// Fully installed packages in a folder like `platforms/` or `build-tools/` (sdkmanager writes
/// `package.xml` last), sorted oldest to newest.
pub fn packages(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("package.xml").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by_key(|n| version_key(n));
    names
}

/// Numeric parts of a version-like name, so `android-9` sorts before `android-34`.
fn version_key(name: &str) -> Vec<u32> {
    name.split(|c: char| !c.is_ascii_digit()).filter_map(|p| p.parse().ok()).collect()
}

/// Installed system images as sdkmanager package ids, e.g. `system-images;android-36;google_apis;arm64-v8a`.
pub fn system_images(root: &Path) -> Vec<String> {
    let base = root.join("system-images");
    let mut out = Vec::new();
    for api in subdirs(&base) {
        for tag in subdirs(&base.join(&api)) {
            for abi in packages(&base.join(&api).join(&tag)) {
                out.push(format!("system-images;{api};{tag};{abi}"));
            }
        }
    }
    out.sort_by_key(|id| version_key(id.split(';').nth(1).unwrap_or_default()));
    out
}

fn subdirs(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// Virtual device names, read from the AVD folder the emulator uses. Like `emulator -list-avds`,
/// a device's name is its `.ini` file name; the `.avd` folder it points to may be named differently.
pub fn avds(env: &ShellEnv) -> Vec<String> {
    let dir = env.avd_home.as_ref().map(PathBuf::from).unwrap_or_else(|| home().join(".android/avd"));
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".ini").map(str::to_owned))
        .collect();
    names.sort();
    names
}

pub struct Jdk {
    /// JDK home, when known (JAVA_HOME or java_home); otherwise `java` from PATH is used.
    pub home: Option<String>,
    pub version: String,
    pub major: u32,
}

/// The JDK Gradle will pick: JAVA_HOME if set, else the newest JDK 17+ (macOS), else `java` on PATH.
pub async fn find_jdk(env: &ShellEnv) -> Option<Jdk> {
    let home = match &env.java_home {
        Some(h) => Some(h.clone()),
        None if cfg!(target_os = "macos") => {
            let out = env::command("/usr/libexec/java_home").args(["-v", &format!("{MIN_JDK}+")]).output().await.ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|h| !h.is_empty())
        }
        None => None,
    };
    let java = match &home {
        Some(h) => format!("{h}/bin/java"),
        None => env::which("java")?,
    };
    let out = env::command(&java).arg("-version").output().await.ok()?;
    // `java -version` prints to stderr.
    let (version, major) = parse_java_version(&String::from_utf8_lossy(&out.stderr))?;
    Some(Jdk { home, version, major })
}

/// `openjdk version "17.0.9" 2023-10-17` → ("17.0.9", 17); `java version "1.8.0_392"` → ("1.8.0_392", 8).
fn parse_java_version(text: &str) -> Option<(String, u32)> {
    let version = text.split("version \"").nth(1)?.split('"').next()?.to_owned();
    let mut parts = version.split(|c: char| !c.is_ascii_digit());
    let first: u32 = parts.next()?.parse().ok()?;
    let major = if first == 1 { parts.next()?.parse().ok()? } else { first };
    Some((version, major))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_versions() {
        let zulu = "openjdk version \"17.0.9\" 2023-10-17 LTS\nOpenJDK Runtime Environment Zulu17.46+19-CA (build 17.0.9+8-LTS)";
        assert_eq!(parse_java_version(zulu), Some(("17.0.9".into(), 17)));
        assert_eq!(parse_java_version("java version \"1.8.0_392\""), Some(("1.8.0_392".into(), 8)));
        assert_eq!(parse_java_version("java version \"25.0.2\" 2026-01-20 LTS"), Some(("25.0.2".into(), 25)));
        assert_eq!(parse_java_version("openjdk version \"21\" 2023-09-19"), Some(("21".into(), 21)));
        assert_eq!(parse_java_version("The operation couldn’t be completed. Unable to locate a Java Runtime."), None);
    }

    #[test]
    fn versions_sort_numerically() {
        let mut v = vec!["android-36", "android-9", "android-37.0", "android-36.1", "android-34"];
        v.sort_by_key(|n| version_key(n));
        assert_eq!(v, ["android-9", "android-34", "android-36", "android-36.1", "android-37.0"]);
    }

    #[test]
    fn reads_sdk_folder() {
        let root = std::env::temp_dir().join(format!("orbit-sdk-test-{}", std::process::id()));
        let pkg = |p: &str| {
            std::fs::create_dir_all(root.join(p)).unwrap();
            std::fs::write(root.join(p).join("package.xml"), "").unwrap();
        };
        pkg("platforms/android-36");
        pkg("platforms/android-9");
        std::fs::create_dir_all(root.join("platforms/android-37")).unwrap(); // half-downloaded
        pkg("system-images/android-36/google_apis/arm64-v8a");
        pkg("cmdline-tools/19.0");
        std::fs::create_dir_all(root.join("cmdline-tools/19.0/bin")).unwrap();
        std::fs::write(root.join("cmdline-tools/19.0/bin/sdkmanager"), "").unwrap();

        assert_eq!(packages(&root.join("platforms")), ["android-9", "android-36"]);
        assert_eq!(system_images(&root), ["system-images;android-36;google_apis;arm64-v8a"]);
        assert_eq!(cmdline_tool(&root, "sdkmanager"), Some(root.join("cmdline-tools/19.0/bin/sdkmanager")));
        assert_eq!(cmdline_tool(&root, "avdmanager"), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
