//! Reads and edits the app's version and build number.
//!
//! Android: `versionName` / `versionCode` in the app module's build script.
//! iOS: `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in XcodeGen's project.yml (when it sets
//! them) and in the .xcodeproj's build settings, so the change applies with or without regenerating.

use super::{android, ios};
use crate::workspace::atomic_write;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    pub platform: &'static str,
    pub version: Option<String>,
    pub build: Option<String>,
    /// Files the values are read from and written to.
    pub files: Vec<String>,
    pub error: Option<String>,
}

fn android_name() -> Regex {
    Regex::new(r#"(?m)^(\s*versionName\s*(?:=\s*)?)["']([^"'\n]*)["']"#).unwrap()
}
fn android_code() -> Regex {
    Regex::new(r"(?m)^(\s*versionCode\s*(?:=\s*)?)(\d+)\s*$").unwrap()
}
fn yml_key(key: &str) -> Regex {
    Regex::new(&format!(r#"(?m)^(\s*{key}:[ \t]*)(.*?)[ \t]*$"#)).unwrap()
}
fn pbx_key(key: &str) -> Regex {
    Regex::new(&format!(r#"({key} = )([^;\n]+);"#)).unwrap()
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches(|c| c == '"' || c == '\'').to_owned()
}

/// The value used by most targets (test targets sometimes differ).
fn most_common(re: &Regex, text: &str) -> Option<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for c in re.captures_iter(text) {
        let v = unquote(&c[2]);
        match counts.iter_mut().find(|(k, _)| *k == v) {
            Some((_, n)) => *n += 1,
            None => counts.push((v, 1)),
        }
    }
    counts.into_iter().max_by_key(|(_, n)| *n).map(|(v, _)| v)
}

/// The .xcodeproj next to (or inside the folder of) the detected iOS project.
pub fn pbxproj(project: &ios::project::Project) -> Option<PathBuf> {
    let p = Path::new(&project.path);
    if p.extension().is_some_and(|x| x == "xcodeproj") {
        return Some(p.join("project.pbxproj")).filter(|f| f.is_file());
    }
    let dir = project.dir();
    std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).find_map(|p| {
        (p.extension().is_some_and(|x| x == "xcodeproj") && !p.to_string_lossy().contains("/Pods/"))
            .then(|| p.join("project.pbxproj"))
            .filter(|f| f.is_file())
    })
}

/// (project.yml if it sets the keys, project.pbxproj) for an iOS project.
fn ios_files(root: &str) -> Result<(Option<PathBuf>, Option<PathBuf>), String> {
    let project = ios::project::detect(root).ok_or("No Xcode project found")?;
    if matches!(project.kind, ios::project::ProjectKind::Package) {
        return Err("Swift packages don't have an app version".into());
    }
    let yml = Path::new(&project.dir()).join("project.yml");
    let yml = std::fs::read_to_string(&yml)
        .ok()
        .filter(|t| yml_key("MARKETING_VERSION").is_match(t) || yml_key("CURRENT_PROJECT_VERSION").is_match(t))
        .map(|_| yml);
    let pbx = pbxproj(&project);
    if yml.is_none() && pbx.is_none() {
        return Err("Couldn't find the project's build settings".into());
    }
    Ok((yml, pbx))
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_android(root: &str) -> Result<AppVersion, String> {
    let project = android::project::detect(root).ok_or("No Gradle project found")?;
    let script = android::project::app_build_script(&project).ok_or("No application module found")?;
    let text = read(&script)?;
    let version = android_name().captures(&text).map(|c| c[2].to_owned());
    let build = android_code().captures(&text).map(|c| c[2].to_owned());
    let error = (version.is_none() || build.is_none())
        .then(|| "versionName/versionCode aren't plain values in the build script, so they can't be edited here".to_owned());
    Ok(AppVersion { platform: "android", version, build, files: vec![script.to_string_lossy().into_owned()], error })
}

fn read_ios(root: &str) -> Result<AppVersion, String> {
    let (yml, pbx) = ios_files(root)?;
    let (mut version, mut build) = (None, None);
    // project.yml wins: the .xcodeproj is regenerated from it.
    if let Some(y) = &yml {
        let text = read(y)?;
        version = most_common(&yml_key("MARKETING_VERSION"), &text);
        build = most_common(&yml_key("CURRENT_PROJECT_VERSION"), &text);
    }
    if let Some(p) = &pbx {
        let text = read(p)?;
        version = version.or_else(|| most_common(&pbx_key("MARKETING_VERSION"), &text));
        build = build.or_else(|| most_common(&pbx_key("CURRENT_PROJECT_VERSION"), &text));
    }
    let files = yml.iter().chain(pbx.iter()).map(|p| p.to_string_lossy().into_owned()).collect();
    Ok(AppVersion { platform: "ios", version, build, files, error: None })
}

#[tauri::command]
pub async fn app_version(root: String) -> AppVersion {
    let result = if android::project::detect(&root).is_some() { read_android(&root) } else { read_ios(&root) };
    result.unwrap_or_else(|error| AppVersion { error: Some(error), ..Default::default() })
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    atomic_write(path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
pub async fn set_app_version(root: String, version: String, build: String) -> Result<(), String> {
    let (version, build) = (version.trim().to_owned(), build.trim().to_owned());
    if !Regex::new(r"^[0-9A-Za-z][0-9A-Za-z.\-]*$").unwrap().is_match(&version) {
        return Err("The version can only contain letters, digits, dots and dashes".into());
    }
    if let Some(project) = android::project::detect(&root) {
        let code: u32 = build.parse().map_err(|_| "The build number (versionCode) must be a whole number")?;
        let script = android::project::app_build_script(&project).ok_or("No application module found")?;
        let text = read(&script)?;
        let (name_re, code_re) = (android_name(), android_code());
        if !name_re.is_match(&text) || !code_re.is_match(&text) {
            return Err("versionName/versionCode aren't plain values in the build script".into());
        }
        // Only the first (defaultConfig) occurrence; flavors may override with their own.
        let text = name_re.replacen(&text, 1, |c: &regex::Captures| format!("{}\"{version}\"", &c[1]));
        let text = code_re.replacen(&text, 1, |c: &regex::Captures| format!("{}{code}", &c[1]));
        return write(&script, &text);
    }

    if !Regex::new(r"^[0-9]+(\.[0-9]+){0,2}$").unwrap().is_match(&build) {
        return Err("The build number must be like 42 or 1.2.3".into());
    }
    let (yml, pbx) = ios_files(&root)?;
    if let Some(y) = &yml {
        let text = read(y)?;
        let text = yml_key("MARKETING_VERSION").replace_all(&text, |c: &regex::Captures| format!("{}\"{version}\"", &c[1]));
        let text = yml_key("CURRENT_PROJECT_VERSION").replace_all(&text, |c: &regex::Captures| format!("{}\"{build}\"", &c[1]));
        write(y, &text)?;
    }
    if let Some(p) = &pbx {
        let text = read(p)?;
        let text = pbx_key("MARKETING_VERSION").replace_all(&text, |c: &regex::Captures| format!("{}{version};", &c[1]));
        let text = pbx_key("CURRENT_PROJECT_VERSION").replace_all(&text, |c: &regex::Captures| format!("{}{build};", &c[1]));
        write(p, &text)?;
    }
    Ok(())
}
