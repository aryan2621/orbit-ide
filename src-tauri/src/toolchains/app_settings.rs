//! Reads and edits the app's display name and permissions.
//!
//! iOS: `CFBundleDisplayName` and the `NS…UsageDescription` strings, in the target's Info.plist
//! (through `plutil`) and/or its `INFOPLIST_KEY_…` build settings (generated Info.plist).
//! Android: the `<application android:label>` (or the string it references) and the
//! `<uses-permission>` elements of the app module's AndroidManifest.xml.

use super::{android, ios};
use crate::env;
use crate::workspace::atomic_write;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
pub struct Permission {
    /// iOS: the Info.plist key. Android: the permission name.
    pub key: String,
    /// iOS: the usage description shown to users. Android: unused.
    #[serde(default)]
    pub value: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub platform: &'static str,
    pub display_name: Option<String>,
    pub permissions: Vec<Permission>,
    /// Files the values are read from and written to.
    pub files: Vec<String>,
    pub error: Option<String>,
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    atomic_write(path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

// ---- iOS ----

const DISPLAY_NAME: &str = "CFBundleDisplayName";
const GENERATED: &str = "INFOPLIST_KEY_";

fn is_usage_key(key: &str) -> bool {
    key.starts_with("NS") && key.ends_with("UsageDescription")
}

/// The app target and its build settings for `scheme`.
struct IosTarget {
    project: ios::project::Project,
    name: String,
    settings: Value,
    /// The Info.plist file, when the target has one.
    plist: Option<PathBuf>,
}

async fn ios_target(root: &str, scheme: &str, configuration: &str) -> Result<IosTarget, String> {
    let project = ios::project::detect(root).ok_or("No Xcode project found")?;
    if matches!(project.kind, ios::project::ProjectKind::Package) {
        return Err("Swift packages don't have app settings".into());
    }
    if scheme.is_empty() {
        return Err("Choose a scheme in the toolbar first.".into());
    }
    let mut cmd = ios::build::xcodebuild_command(&project, scheme, configuration, "generic/platform=iOS");
    cmd.args(["-showBuildSettings", "-json"]);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let json: Value = stdout.find('[').and_then(|i| serde_json::from_str(&stdout[i..]).ok()).unwrap_or_default();
    let target = ios::signing::app_settings(&json).ok_or("This scheme doesn't build an iOS app.")?;
    let settings = target["buildSettings"].clone();
    let name = target["target"].as_str().ok_or("This scheme doesn't build an iOS app.")?.to_owned();
    let plist = settings["INFOPLIST_FILE"].as_str().filter(|f| !f.is_empty()).map(|f| {
        let f = f.replace("$(SRCROOT)/", "").replace("${SRCROOT}/", "");
        let src_root = settings["SRCROOT"].as_str().map(PathBuf::from).unwrap_or_else(|| PathBuf::from(project.dir()));
        if Path::new(&f).is_absolute() { PathBuf::from(f) } else { src_root.join(f) }
    });
    Ok(IosTarget { project, name, settings, plist: plist.filter(|p| p.is_file()) })
}

async fn plist_json(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let out = env::command("plutil").args(["-convert", "json", "-o", "-"]).arg(path).output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("{}: {}", path.display(), String::from_utf8_lossy(&out.stderr).trim()));
    }
    match serde_json::from_slice(&out.stdout) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(format!("{} isn't a property list dictionary", path.display())),
    }
}

/// Usage strings and display name: generated keys first, then the Info.plist file's (which wins).
async fn ios_values(t: &IosTarget) -> Result<(Option<String>, BTreeMap<String, String>, BTreeMap<String, String>), String> {
    let mut generated = BTreeMap::new();
    if let Some(s) = t.settings.as_object() {
        for (k, v) in s {
            if let (Some(key), Some(v)) = (k.strip_prefix(GENERATED), v.as_str()) {
                if key == DISPLAY_NAME || is_usage_key(key) {
                    generated.insert(key.to_owned(), v.to_owned());
                }
            }
        }
    }
    let mut all = generated.clone();
    if let Some(p) = &t.plist {
        for (k, v) in plist_json(p).await? {
            if let Some(v) = v.as_str().filter(|_| k == DISPLAY_NAME || is_usage_key(&k)) {
                all.insert(k, v.to_owned());
            }
        }
    }
    let name = all.remove(DISPLAY_NAME);
    Ok((name, all, generated))
}

async fn read_ios(root: &str, scheme: &str, configuration: &str) -> Result<AppSettings, String> {
    let t = ios_target(root, scheme, configuration).await?;
    let (display_name, usage, _) = ios_values(&t).await?;
    // Fall back to the name the Home Screen shows when no display name is set.
    let display_name = display_name.or_else(|| t.settings["PRODUCT_NAME"].as_str().map(str::to_owned));
    let mut files: Vec<String> = t.plist.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    if t.plist.is_none() || t.settings.as_object().is_some_and(|s| s.keys().any(|k| k.starts_with(GENERATED))) {
        let yml = Path::new(&t.project.dir()).join("project.yml");
        let settings = if yml.exists() { Some(yml) } else { super::version::pbxproj(&t.project) };
        files.extend(settings.map(|p| p.to_string_lossy().into_owned()));
    }
    let permissions = usage.into_iter().map(|(key, value)| Permission { key, value }).collect();
    Ok(AppSettings { platform: "ios", display_name, permissions, files, error: None })
}

async fn plutil(args: &[&str], path: &Path) -> Result<(), String> {
    let out = env::command("plutil").args(args).arg(path).output().await.map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) }
}

async fn save_ios(root: &str, scheme: &str, configuration: &str, display_name: &str, permissions: &[Permission]) -> Result<(), String> {
    let t = ios_target(root, scheme, configuration).await?;
    let (_, old, generated) = ios_values(&t).await?;
    let mut wanted: BTreeMap<String, String> = permissions.iter().filter(|p| is_usage_key(&p.key)).map(|p| (p.key.clone(), p.value.trim().to_owned())).collect();
    if !display_name.trim().is_empty() {
        wanted.insert(DISPLAY_NAME.into(), display_name.trim().to_owned());
    }
    let removed: Vec<String> = old.keys().filter(|k| !wanted.contains_key(*k)).cloned().chain((display_name.trim().is_empty()).then(|| DISPLAY_NAME.to_owned())).collect();

    // Build settings to change: with an Info.plist file, the file becomes the source and the
    // generated keys it replaces are dropped; without one, everything goes in the build settings.
    let mut settings: Vec<(String, String)> = Vec::new();
    match &t.plist {
        Some(plist) => {
            for (k, v) in &wanted {
                plutil(&["-replace", k, "-string", v], plist).await?;
            }
            for k in &removed {
                if old.contains_key(k) || k == DISPLAY_NAME {
                    // -remove fails when the key isn't there; that's fine.
                    let _ = plutil(&["-remove", k], plist).await;
                }
            }
            for k in wanted.keys().chain(removed.iter()) {
                if generated.contains_key(k) {
                    settings.push((format!("{GENERATED}{k}"), String::new()));
                }
            }
        }
        None => {
            settings.extend(wanted.iter().filter(|(k, v)| generated.get(*k) != Some(*v)).map(|(k, v)| (format!("{GENERATED}{k}"), v.clone())));
            settings.extend(removed.iter().filter(|k| generated.contains_key(*k)).map(|k| (format!("{GENERATED}{k}"), String::new())));
        }
    }
    if settings.is_empty() {
        return Ok(());
    }
    let values: Vec<(&str, &str)> = settings.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    ios::signing::save_target_settings(&t.project, &t.name, &values).await
}

// ---- Android ----

fn manifest(root: &str) -> Result<PathBuf, String> {
    let project = android::project::detect(root).ok_or("No Gradle project found")?;
    let script = android::project::app_build_script(&project).ok_or("No application module found")?;
    let manifest = script.parent().unwrap_or(Path::new(root)).join("src/main/AndroidManifest.xml");
    if manifest.is_file() { Ok(manifest) } else { Err(format!("{} not found", manifest.display())) }
}

fn label_re() -> Regex {
    Regex::new(r#"(<application\b[^>]*?\bandroid:label\s*=\s*")([^"]*)(")"#).unwrap()
}
fn permission_re() -> Regex {
    Regex::new(r#"(?s)[ \t]*<uses-permission\b[^>]*?\bandroid:name\s*=\s*"([^"]+)"[^>]*?(?:/>|>\s*</uses-permission>)[ \t]*\n?"#).unwrap()
}
fn string_re(name: &str) -> Regex {
    Regex::new(&format!(r#"(<string\b[^>]*\bname\s*=\s*"{}"[^>]*>)([^<]*)(</string>)"#, regex::escape(name))).unwrap()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}
/// strings.xml values also escape apostrophes and quotes with backslashes.
fn res_escape(s: &str) -> String {
    xml_escape(s).replace('\'', "\\'")
}
fn res_unescape(s: &str) -> String {
    xml_unescape(s).replace("\\'", "'").replace("\\\"", "\"")
}

/// `@string/app_name` → (values/strings.xml, "app_name") when that file defines it.
fn label_string(manifest: &Path, label: &str) -> Option<(PathBuf, String)> {
    let name = label.strip_prefix("@string/")?;
    let file = manifest.parent()?.join("res/values/strings.xml");
    let text = std::fs::read_to_string(&file).ok()?;
    string_re(name).is_match(&text).then(|| (file, name.to_owned()))
}

fn read_android(root: &str) -> Result<AppSettings, String> {
    let manifest = manifest(root)?;
    let text = read(&manifest)?;
    let mut files = vec![manifest.to_string_lossy().into_owned()];
    let label = label_re().captures(&text).map(|c| xml_unescape(&c[2]));
    let display_name = match label.as_deref().and_then(|l| label_string(&manifest, l)) {
        Some((file, name)) => {
            let strings = read(&file)?;
            files.push(file.to_string_lossy().into_owned());
            string_re(&name).captures(&strings).map(|c| res_unescape(&c[2]))
        }
        None => label,
    };
    let mut permissions: Vec<Permission> = Vec::new();
    for c in permission_re().captures_iter(&text) {
        if !permissions.iter().any(|p| p.key == c[1]) {
            permissions.push(Permission { key: c[1].to_owned(), value: String::new() });
        }
    }
    Ok(AppSettings { platform: "android", display_name, permissions, files, error: None })
}

fn save_android(root: &str, display_name: &str, permissions: &[Permission]) -> Result<(), String> {
    let manifest = manifest(root)?;
    let mut text = read(&manifest)?;
    let display_name = display_name.trim();

    if !display_name.is_empty() {
        let label = label_re().captures(&text).map(|c| xml_unescape(&c[2]));
        match label.as_deref().and_then(|l| label_string(&manifest, l)) {
            Some((file, name)) => {
                let strings = read(&file)?;
                let updated = string_re(&name).replacen(&strings, 1, |c: &regex::Captures| format!("{}{}{}", &c[1], res_escape(display_name), &c[3]));
                if updated != strings {
                    write(&file, &updated)?;
                }
            }
            None if label.is_some() => {
                text = label_re().replacen(&text, 1, |c: &regex::Captures| format!("{}{}{}", &c[1], xml_escape(display_name), &c[3])).into_owned();
            }
            None => {
                let app = Regex::new(r"<application\b").unwrap();
                if !app.is_match(&text) {
                    return Err("AndroidManifest.xml has no <application> element".into());
                }
                text = app.replacen(&text, 1, format!("<application android:label=\"{}\"", xml_escape(display_name)).as_str()).into_owned();
            }
        }
    }

    let valid = Regex::new(r"^[A-Za-z_][A-Za-z0-9_.]*$").unwrap();
    if let Some(bad) = permissions.iter().find(|p| !valid.is_match(&p.key)) {
        return Err(format!("\"{}\" isn't a valid permission name", bad.key));
    }
    let wanted: Vec<&str> = permissions.iter().map(|p| p.key.as_str()).collect();
    let existing: Vec<String> = permission_re().captures_iter(&text).map(|c| c[1].to_owned()).collect();
    text = permission_re().replace_all(&text, |c: &regex::Captures| if wanted.contains(&&c[1]) { c[0].to_owned() } else { String::new() }).into_owned();
    let added: Vec<&str> = wanted.iter().copied().filter(|p| !existing.iter().any(|e| e == p)).collect();
    if !added.is_empty() {
        // Before <application>, at its indentation.
        let app = Regex::new(r"(?m)^([ \t]*)<application\b").unwrap();
        let (at, indent) = app.captures(&text).map(|c| (c.get(0).map_or(0, |m| m.start()), c[1].to_owned())).ok_or("AndroidManifest.xml has no <application> element")?;
        let lines: String = added.iter().map(|p| format!("{indent}<uses-permission android:name=\"{p}\" />\n")).collect();
        text.insert_str(at, &format!("{lines}\n"));
    }
    write(&manifest, &text)
}

#[tauri::command]
pub async fn app_settings(root: String, scheme: String, configuration: String) -> AppSettings {
    let result = if android::project::detect(&root).is_some() { read_android(&root) } else { read_ios(&root, &scheme, &configuration).await };
    result.unwrap_or_else(|error| AppSettings { error: Some(error), ..Default::default() })
}

#[tauri::command]
pub async fn save_app_settings(root: String, scheme: String, configuration: String, display_name: String, permissions: Vec<Permission>) -> Result<(), String> {
    if android::project::detect(&root).is_some() {
        save_android(&root, &display_name, &permissions)
    } else {
        save_ios(&root, &scheme, &configuration, &display_name, &permissions).await
    }
}
