//! Finds the Xcode project in a folder and reads its schemes.

use super::package;
use crate::env;
use serde::Serialize;
use regex::Regex;
use std::path::Path;

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ProjectKind {
    Workspace,
    Project,
    Package,
}

#[derive(Serialize, Clone, Debug)]
pub struct Project {
    pub kind: ProjectKind,
    /// Path to the .xcworkspace / .xcodeproj / folder containing Package.swift.
    pub path: String,
    pub name: String,
}

impl Project {
    /// The `-workspace X` / `-project X` arguments for xcodebuild (packages need none; run in the folder).
    pub fn xcodebuild_args(&self) -> Vec<String> {
        match self.kind {
            ProjectKind::Workspace => vec!["-workspace".into(), self.path.clone()],
            ProjectKind::Project => vec!["-project".into(), self.path.clone()],
            ProjectKind::Package => vec![],
        }
    }

    pub fn dir(&self) -> String {
        match self.kind {
            ProjectKind::Package => self.path.clone(),
            _ => Path::new(&self.path).parent().unwrap_or(Path::new("/")).to_string_lossy().into_owned(),
        }
    }
}

/// Looks in `root` and its immediate subfolders. A workspace wins over a project (CocoaPods
/// projects must be built through the workspace), and a project wins over a package.
pub fn detect(root: &str) -> Option<Project> {
    let mut found: Vec<Project> = Vec::new();
    let mut dirs = vec![root.to_owned()];
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() && !name.starts_with('.') && !name.contains('.') && name != "Pods" {
                dirs.push(e.path().to_string_lossy().into_owned());
            }
        }
    }
    for dir in &dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            let kind = match path.extension().and_then(|x| x.to_str()) {
                Some("xcworkspace") => ProjectKind::Workspace,
                Some("xcodeproj") => ProjectKind::Project,
                _ if name == "Package.swift" => {
                    found.push(Project {
                        kind: ProjectKind::Package,
                        path: dir.clone(),
                        name: Path::new(dir).file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    });
                    continue;
                }
                _ => continue,
            };
            found.push(Project { kind, path: path.to_string_lossy().into_owned(), name: stem });
        }
    }
    // Prefer the shallowest match, then by kind.
    let rank = |p: &Project| {
        let depth = if p.dir() == root { 0 } else { 1 };
        let kind = match p.kind {
            ProjectKind::Workspace => 0,
            ProjectKind::Project => 1,
            ProjectKind::Package => 2,
        };
        (depth, kind)
    };
    found.into_iter().min_by_key(rank)
}

#[derive(Serialize)]
pub struct ProjectInfo {
    project: Option<Project>,
    schemes: Vec<String>,
    /// Schemes that produce something runnable (all of them for apps; executables for packages).
    runnable: Vec<String>,
    /// "ios" for Xcode projects, "mac" for Swift packages (built and run with SwiftPM).
    platform: &'static str,
    configurations: Vec<String>,
    /// Why schemes couldn't be listed (e.g. Xcode missing), if they couldn't.
    error: Option<String>,
}

#[tauri::command]
pub async fn ios_project_info(root: String) -> ProjectInfo {
    let Some(project) = detect(&root) else {
        return ProjectInfo { project: None, schemes: vec![], runnable: vec![], platform: "ios", configurations: vec![], error: None };
    };
    if project.kind == ProjectKind::Package {
        let configurations = vec!["Debug".into(), "Release".into()];
        return match package::products(&project.dir()).await {
            Ok(products) => ProjectInfo {
                schemes: products.iter().map(|p| p.name.clone()).collect(),
                runnable: products.iter().filter(|p| p.executable).map(|p| p.name.clone()).collect(),
                error: products.is_empty().then(|| "Package.swift declares no products".into()),
                project: Some(project),
                platform: "mac",
                configurations,
            },
            Err(e) => ProjectInfo { project: Some(project), schemes: vec![], runnable: vec![], platform: "mac", configurations, error: Some(e) },
        };
    }
    let mut cmd = env::command("xcodebuild");
    cmd.arg("-list").arg("-json").args(project.xcodebuild_args()).current_dir(project.dir()).kill_on_drop(true);
    // `-list` resolves Swift packages first, which can take minutes or hang on a bad network.
    let listed = match tokio::time::timeout(std::time::Duration::from_secs(180), cmd.output()).await {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => Err("Reading the project took more than 3 minutes (often Swift package resolution). Check your network, then reopen the folder.".into()),
    };
    let out = match listed {
        Ok(o) => o,
        Err(e) => {
            return ProjectInfo {
                project: Some(project),
                schemes: vec![],
                runnable: vec![],
                platform: "ios",
                configurations: vec![],
                error: Some(e),
            }
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    // xcodebuild may print warnings before the JSON.
    let json: serde_json::Value = stdout
        .find('{')
        .and_then(|i| serde_json::from_str(&stdout[i..]).ok())
        .unwrap_or_default();
    let section = json.get("workspace").or_else(|| json.get("project")).cloned().unwrap_or_default();
    let strings = |key: &str| -> Vec<String> {
        section[key].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
    };
    let schemes = strings("schemes");
    let mut configurations = strings("configurations");
    if configurations.is_empty() {
        configurations = vec!["Debug".into(), "Release".into()];
    }
    let error = if schemes.is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Some(if stderr.contains("requires Xcode") {
            "Xcode is required to read this project. Open the setup wizard.".into()
        } else {
            stderr.lines().find(|l| l.contains("error")).unwrap_or("No schemes found").trim().to_owned()
        })
    } else {
        None
    };
    let dir = project.dir();
    let runnable = schemes.iter().filter(|s| scheme_builds_app(&dir, s)).cloned().collect();
    ProjectInfo { project: Some(project), runnable, schemes, platform: "ios", configurations, error }
}

/// Whether a scheme's launch target is an `.app`, from its `.xcscheme` (shared or per-user, in any
/// project or workspace under `dir`). Schemes without a file (autogenerated) count as runnable.
fn scheme_builds_app(dir: &str, scheme: &str) -> bool {
    let Some(file) = find_scheme_file(Path::new(dir), &format!("{scheme}.xcscheme"), 0) else { return true };
    let Ok(xml) = std::fs::read_to_string(file) else { return true };
    let Ok(re) = Regex::new(r#"BuildableName\s*=\s*"([^"]+)""#) else { return true };
    let name_in = |section: &str| re.captures_iter(section).map(|c| c[1].to_owned()).collect::<Vec<_>>();
    // The launch action's runnable decides; fall back to anything the scheme builds.
    let launch = xml.find("<BuildableProductRunnable").map(|i| &xml[i..]).and_then(|s| s.find("</BuildableProductRunnable>").map(|e| &s[..e]));
    let names: Vec<String> = match launch {
        Some(section) => name_in(section),
        None => name_in(&xml),
    };
    names.iter().any(|n| n.ends_with(".app"))
}

fn find_scheme_file(dir: &Path, file_name: &str, depth: u32) -> Option<std::path::PathBuf> {
    if depth > 6 {
        return None;
    }
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name == file_name && path.parent().is_some_and(|p| p.ends_with("xcschemes")) {
            return Some(path);
        }
        // Only descend into project bundles and their scheme folders, plus plain subfolders that may
        // hold nested projects (not build output or dependencies).
        let skip = name.starts_with('.') || matches!(name.as_str(), "Pods" | "build" | "DerivedData" | "node_modules" | "Carthage");
        if path.is_dir() && !skip {
            if let Some(found) = find_scheme_file(&path, file_name, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// Generates `buildServer.json` so sourcekit-lsp understands Xcode projects (via xcode-build-server),
/// and regenerates it when the scheme changes. Returns true if the file was (re)written and the
/// language server should restart.
#[tauri::command]
pub async fn ios_configure_lsp(root: String, scheme: String) -> Result<bool, String> {
    let Some(project) = detect(&root) else { return Ok(false) };
    let config = Path::new(&root).join("buildServer.json");
    let current_scheme = std::fs::read_to_string(&config)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["scheme"].as_str().map(str::to_owned));
    if project.kind == ProjectKind::Package || (config.exists() && current_scheme.as_deref() == Some(scheme.as_str())) {
        return Ok(false);
    }
    let Some(tool) = env::which("xcode-build-server") else { return Ok(false) };
    let mut cmd = env::command(&tool);
    cmd.arg("config").args(project.xcodebuild_args()).args(["-scheme", &scheme]).current_dir(&root);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    git_exclude(&root, "buildServer.json");
    Ok(true)
}

/// Adds `pattern` to `.git/info/exclude` (when `root` is a repo) so a generated file never shows as a change.
fn git_exclude(root: &str, pattern: &str) {
    let info = Path::new(root).join(".git/info");
    if !Path::new(root).join(".git").is_dir() {
        return;
    }
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == pattern || l.trim() == format!("/{pattern}")) {
        return;
    }
    let _ = std::fs::create_dir_all(&info);
    let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    let _ = std::fs::write(&exclude, format!("{existing}{sep}/{pattern}\n"));
}
