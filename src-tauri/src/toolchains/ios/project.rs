//! Finds the Xcode project in a folder and reads its schemes.

use super::package;
use crate::env;
use serde::Serialize;
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
            _ => Path::new(&self.path).parent().unwrap().to_string_lossy().into_owned(),
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
    cmd.arg("-list").arg("-json").args(project.xcodebuild_args()).current_dir(project.dir());
    let out = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            return ProjectInfo {
                project: Some(project),
                schemes: vec![],
                runnable: vec![],
                platform: "ios",
                configurations: vec![],
                error: Some(e.to_string()),
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
    ProjectInfo { project: Some(project), runnable: schemes.clone(), schemes, platform: "ios", configurations, error }
}

/// Generates `buildServer.json` so sourcekit-lsp understands Xcode projects (via xcode-build-server).
/// Returns true if the file was created and the language server should restart.
#[tauri::command]
pub async fn ios_configure_lsp(root: String, scheme: String) -> Result<bool, String> {
    let Some(project) = detect(&root) else { return Ok(false) };
    if project.kind == ProjectKind::Package || Path::new(&root).join("buildServer.json").exists() {
        return Ok(false);
    }
    let Some(tool) = env::which("xcode-build-server") else { return Ok(false) };
    let mut cmd = env::command(&tool);
    cmd.arg("config").args(project.xcodebuild_args()).args(["-scheme", &scheme]).current_dir(&root);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("orbit-detect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn prefers_workspace_over_project() {
        let dir = tmp("ws");
        std::fs::create_dir(dir.join("App.xcodeproj")).unwrap();
        std::fs::create_dir(dir.join("App.xcworkspace")).unwrap();
        let p = detect(dir.to_str().unwrap()).unwrap();
        assert_eq!(p.kind, ProjectKind::Workspace);
        assert_eq!(p.name, "App");
    }

    #[test]
    fn finds_project_in_subfolder() {
        let dir = tmp("sub");
        std::fs::create_dir_all(dir.join("ios/Runner.xcodeproj")).unwrap();
        let p = detect(dir.to_str().unwrap()).unwrap();
        assert_eq!(p.kind, ProjectKind::Project);
        assert_eq!(p.dir(), dir.join("ios").to_string_lossy());
    }

    #[test]
    fn root_project_wins_over_nested_package() {
        let dir = tmp("pkg");
        std::fs::create_dir(dir.join("App.xcodeproj")).unwrap();
        std::fs::create_dir(dir.join("Core")).unwrap();
        std::fs::write(dir.join("Core/Package.swift"), "").unwrap();
        assert_eq!(detect(dir.to_str().unwrap()).unwrap().kind, ProjectKind::Project);
    }
}
