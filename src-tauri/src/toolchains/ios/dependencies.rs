//! Swift package dependencies: listed and added for Swift packages (Package.swift, via SwiftPM)
//! and XcodeGen projects (project.yml `packages:`). Plain .xcodeproj files are read-only here.

use super::project::{self, ProjectKind};
use crate::env;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Dependency {
    name: String,
    url: String,
    /// Version requirement or resolved version, as text.
    version: String,
}

#[derive(Serialize)]
pub struct Dependencies {
    /// "package" | "xcodegen" | "xcodeproj" | "none"
    source: &'static str,
    /// Whether Orbit can add dependencies to this project.
    editable: bool,
    items: Vec<Dependency>,
    error: Option<String>,
}

pub fn parse_swiftpm(json: &Value) -> Vec<Dependency> {
    json["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            Some(Dependency {
                name: d["name"].as_str()?.to_owned(),
                url: d["url"].as_str().unwrap_or("").to_owned(),
                version: d["version"].as_str().unwrap_or("").to_owned(),
            })
        })
        .collect()
}

/// Reads the top-level `packages:` block of a project.yml.
pub fn parse_xcodegen(yml: &str) -> Vec<Dependency> {
    let mut out = Vec::new();
    let mut in_packages = false;
    for line in yml.lines() {
        let indent = line.len() - line.trim_start().len();
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if indent == 0 {
            in_packages = t == "packages:";
            continue;
        }
        if !in_packages {
            continue;
        }
        if indent == 2 && t.ends_with(':') {
            out.push(Dependency { name: t.trim_end_matches(':').to_owned(), url: String::new(), version: String::new() });
        } else if let (Some(dep), Some((key, value))) = (out.last_mut(), t.split_once(':')) {
            let value = value.trim().trim_matches('"').to_owned();
            match key.trim() {
                "url" => dep.url = value,
                "from" | "exactVersion" | "majorVersion" | "minorVersion" | "branch" | "revision" => {
                    dep.version = format!("{} {value}", key.trim())
                }
                _ => {}
            }
        }
    }
    out
}

#[tauri::command]
pub async fn ios_dependencies(root: String) -> Dependencies {
    let none = |source, error: Option<String>| Dependencies { source, editable: false, items: vec![], error };
    let Some(p) = project::detect(&root) else { return none("none", None) };
    let dir = p.dir();
    if p.kind == ProjectKind::Package {
        let out = env::command("swift").args(["package", "show-dependencies", "--format", "json"]).current_dir(&dir).output().await;
        return match out {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                let json: Value = stdout.find('{').and_then(|i| serde_json::from_str(&stdout[i..]).ok()).unwrap_or_default();
                Dependencies { source: "package", editable: true, items: parse_swiftpm(&json), error: None }
            }
            Ok(o) => none("package", Some(String::from_utf8_lossy(&o.stderr).trim().to_owned())),
            Err(e) => none("package", Some(e.to_string())),
        };
    }
    let yml = Path::new(&dir).join("project.yml");
    match std::fs::read_to_string(&yml) {
        Ok(text) => Dependencies { source: "xcodegen", editable: true, items: parse_xcodegen(&text), error: None },
        Err(_) => none("xcodeproj", Some("Add packages to this project in its .xcodeproj, or use an XcodeGen project.yml.".into())),
    }
}

/// Adds `name` to project.yml's `packages:` (creating the block) and as a dependency of `target`.
pub fn add_xcodegen_package(yml: &str, name: &str, url: &str, from: &str, target: &str) -> Option<String> {
    let mut lines: Vec<String> = yml.lines().map(str::to_owned).collect();
    let entry = [format!("  {name}:"), format!("    url: {url}"), format!("    from: \"{from}\"")];
    match lines.iter().position(|l| l.trim_end() == "packages:") {
        Some(i) => {
            for (k, l) in entry.iter().enumerate() {
                lines.insert(i + 1 + k, l.clone());
            }
        }
        None => {
            let at = lines.iter().position(|l| l.trim_end() == "targets:").unwrap_or(lines.len());
            let mut block = vec!["packages:".to_owned()];
            block.extend(entry.iter().cloned());
            lines.splice(at..at, block);
        }
    }
    // Target dependency.
    let t = lines.iter().position(|l| l.trim_end() == format!("  {target}:"))?;
    let end = (t + 1..lines.len()).find(|&i| !lines[i].trim().is_empty() && !lines[i].starts_with("   ")).unwrap_or(lines.len());
    match (t..end).find(|&i| lines[i].trim_end() == "    dependencies:") {
        Some(d) => lines.insert(d + 1, format!("      - package: {name}")),
        None => {
            lines.insert(t + 1, "    dependencies:".into());
            lines.insert(t + 2, format!("      - package: {name}"));
        }
    }
    let mut s = lines.join("\n");
    if yml.ends_with('\n') {
        s.push('\n');
    }
    Some(s)
}

/// Package name from its URL: `https://github.com/pointfreeco/swift-composable-architecture.git` →
/// `swift-composable-architecture`.
fn name_from_url(url: &str) -> String {
    url.trim_end_matches('/').rsplit('/').next().unwrap_or(url).trim_end_matches(".git").to_owned()
}

#[tauri::command]
pub async fn ios_add_dependency(root: String, url: String, from: String, target: Option<String>) -> Result<(), String> {
    let p = project::detect(&root).ok_or("No project found")?;
    let dir = p.dir();
    if p.kind == ProjectKind::Package {
        let out = env::command("swift")
            .args(["package", "add-dependency", &url, "--from", &from])
            .current_dir(&dir)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        return if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_owned()) };
    }
    let path = Path::new(&dir).join("project.yml");
    let yml = std::fs::read_to_string(&path).map_err(|_| "Only XcodeGen projects (project.yml) can be edited here")?;
    let target = target.unwrap_or_else(|| p.name.clone());
    let updated = add_xcodegen_package(&yml, &name_from_url(&url), &url, &from, &target)
        .ok_or_else(|| format!("Couldn't find target '{target}' in project.yml"))?;
    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    let xcodegen = env::which("xcodegen").ok_or("XcodeGen is not installed")?;
    let out = env::command(&xcodegen).arg("generate").current_dir(&dir).output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodsStatus {
    /// The folder with the Podfile, when there is one.
    podfile_dir: Option<String>,
    /// `Pods/` is missing or out of date with Podfile / Podfile.lock.
    needs_install: bool,
    /// Why, for the UI.
    reason: Option<String>,
}

/// Whether a CocoaPods project needs `pod install` (CocoaPods' own check: Pods/Manifest.lock must
/// match Podfile.lock, and the Podfile must not be newer than its lock).
#[tauri::command]
pub fn ios_pods_status(root: String) -> PodsStatus {
    let dirs = [Some(Path::new(&root).to_path_buf()), project::detect(&root).map(|p| Path::new(&p.dir()).to_path_buf())];
    let Some(dir) = dirs.into_iter().flatten().find(|d| d.join("Podfile").is_file()) else {
        return PodsStatus { podfile_dir: None, needs_install: false, reason: None };
    };
    let modified = |f: &str| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok();
    let reason = if !dir.join("Pods").is_dir() {
        Some("Pods aren't installed")
    } else if std::fs::read(dir.join("Podfile.lock")).ok() != std::fs::read(dir.join("Pods/Manifest.lock")).ok() {
        Some("Installed pods don't match Podfile.lock")
    } else if modified("Podfile") > modified("Podfile.lock") {
        Some("The Podfile changed since the last pod install")
    } else {
        None
    };
    PodsStatus { podfile_dir: Some(dir.to_string_lossy().into_owned()), needs_install: reason.is_some(), reason: reason.map(str::to_owned) }
}

/// `pod install` in the Podfile's folder, as a job.
#[tauri::command]
pub fn ios_pod_install(app: tauri::AppHandle, root: String, job_id: String) -> Result<(), String> {
    let status = ios_pods_status(root);
    let dir = status.podfile_dir.ok_or("No Podfile in this project")?;
    let pod = env::which("pod").ok_or("CocoaPods isn't installed. Install it with `brew install cocoapods`, then try again.")?;
    let mut cmd = env::command(&pod);
    cmd.args(["install", "--no-ansi"]).current_dir(dir).env("LANG", "en_US.UTF-8");
    crate::process::spawn_job(&app, job_id, cmd);
    Ok(())
}
