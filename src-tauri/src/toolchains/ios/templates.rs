//! New SwiftUI app projects, generated with XcodeGen so nobody hand-edits a .pbxproj.

use crate::{env, process};
use std::fs;
use std::path::Path;
use tauri::AppHandle;

fn project_yml(name: &str, bundle_id: &str, deployment_target: &str) -> String {
    format!(
        r#"name: {name}
options:
  deploymentTarget:
    iOS: "{deployment_target}"
  createIntermediateGroups: true
settings:
  base:
    MARKETING_VERSION: "1.0"
    CURRENT_PROJECT_VERSION: "1"
    SWIFT_VERSION: "5.0"
    GENERATE_INFOPLIST_FILE: YES
    INFOPLIST_KEY_UILaunchScreen_Generation: YES
    INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES
    INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents: YES
    INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone: "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
    INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad: "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
    ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
    ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor
    ENABLE_PREVIEWS: YES
    CODE_SIGN_STYLE: Automatic
targets:
  {name}:
    type: application
    platform: iOS
    sources: [{name}]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: {bundle_id}
        TARGETED_DEVICE_FAMILY: "1,2"
    scheme: {{}}
"#
    )
}

fn app_swift(name: &str) -> String {
    let type_name = format!("{name}App");
    format!(
        r#"import SwiftUI

@main
struct {type_name}: App {{
    var body: some Scene {{
        WindowGroup {{
            ContentView()
        }}
    }}
}}
"#
    )
}

const CONTENT_VIEW: &str = r#"import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "sparkles")
                .imageScale(.large)
                .foregroundStyle(.tint)
            Text("Hello from Orbit")
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
"#;

const ASSETS_CONTENTS: &str = r#"{
  "info" : { "author" : "xcode", "version" : 1 }
}
"#;

const ACCENT_COLOR: &str = r#"{
  "colors" : [ { "idiom" : "universal" } ],
  "info" : { "author" : "xcode", "version" : 1 }
}
"#;

const APP_ICON: &str = r#"{
  "images" : [ { "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" } ],
  "info" : { "author" : "xcode", "version" : 1 }
}
"#;

const GITIGNORE: &str = "xcuserdata/\nDerivedData/\n.build/\n*.xcresult\n.DS_Store\n";

pub fn validate_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return Err("App name must start with a letter".into()),
    }
    if !chars.all(|c| c.is_ascii_alphanumeric()) {
        return Err("App name can only contain letters and numbers".into());
    }
    Ok(())
}

pub fn write_template(dir: &Path, name: &str, bundle_id: &str, deployment_target: &str) -> std::io::Result<()> {
    let src = dir.join(name);
    let assets = src.join("Assets.xcassets");
    fs::create_dir_all(assets.join("AccentColor.colorset"))?;
    fs::create_dir_all(assets.join("AppIcon.appiconset"))?;
    fs::write(dir.join("project.yml"), project_yml(name, bundle_id, deployment_target))?;
    fs::write(dir.join(".gitignore"), GITIGNORE)?;
    fs::write(src.join(format!("{name}App.swift")), app_swift(name))?;
    fs::write(src.join("ContentView.swift"), CONTENT_VIEW)?;
    fs::write(assets.join("Contents.json"), ASSETS_CONTENTS)?;
    fs::write(assets.join("AccentColor.colorset/Contents.json"), ACCENT_COLOR)?;
    fs::write(assets.join("AppIcon.appiconset/Contents.json"), APP_ICON)?;
    Ok(())
}

/// Creates `<parent>/<name>` with a SwiftUI app and runs `xcodegen generate` as a job.
/// Returns the new project folder.
#[tauri::command]
pub fn ios_new_project(
    app: AppHandle,
    parent: String,
    name: String,
    bundle_id: String,
    deployment_target: String,
    job_id: String,
) -> Result<String, String> {
    validate_name(&name)?;
    let xcodegen = env::which("xcodegen").ok_or("XcodeGen is not installed. Run the setup wizard.")?;
    let dir = Path::new(&parent).join(&name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    write_template(&dir, &name, &bundle_id, &deployment_target).map_err(|e| e.to_string())?;

    let mut cmd = env::command(&xcodegen);
    cmd.arg("generate").current_dir(&dir);
    process::spawn_job(&app, job_id, cmd);
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names() {
        assert!(validate_name("MyApp2").is_ok());
        assert!(validate_name("2App").is_err());
        assert!(validate_name("My App").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn writes_expected_files() {
        let dir = std::env::temp_dir().join(format!("orbit-template-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_template(&dir, "Demo", "com.example.demo", "17.0").unwrap();
        assert!(dir.join("project.yml").exists());
        assert!(dir.join("Demo/DemoApp.swift").exists());
        assert!(dir.join("Demo/Assets.xcassets/AppIcon.appiconset/Contents.json").exists());
        let yml = fs::read_to_string(dir.join("project.yml")).unwrap();
        assert!(yml.contains("PRODUCT_BUNDLE_IDENTIFIER: com.example.demo"));
        assert!(yml.contains("  Demo:\n    type: application"));
    }
}

#[cfg(test)]
mod xcodegen_tests {
    /// Generates a real project; needs XcodeGen. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn xcodegen_accepts_template() {
        let dir = std::env::temp_dir().join(format!("orbit-xcodegen-{}", std::process::id())).join("Demo");
        let _ = std::fs::remove_dir_all(&dir);
        super::write_template(&dir, "Demo", "com.example.demo", "17.0").unwrap();
        let out = std::process::Command::new("xcodegen").arg("generate").current_dir(&dir).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(dir.join("Demo.xcodeproj/project.pbxproj").exists());
        assert!(dir.join("Demo.xcodeproj/xcshareddata/xcschemes/Demo.xcscheme").exists());
        let pbx = std::fs::read_to_string(dir.join("Demo.xcodeproj/project.pbxproj")).unwrap();
        assert!(pbx.contains("ContentView.swift") && pbx.contains("Assets.xcassets"));
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}

/// Re-runs XcodeGen after files were added, renamed or removed, so the .xcodeproj includes them.
/// Returns false (and does nothing) for projects without a project.yml.
#[tauri::command]
pub async fn ios_regenerate(root: String) -> Result<bool, String> {
    let Some(project) = super::project::detect(&root) else { return Ok(false) };
    let dir = project.dir();
    if !Path::new(&dir).join("project.yml").exists() {
        return Ok(false);
    }
    let xcodegen = env::which("xcodegen").ok_or("XcodeGen is not installed")?;
    let out = env::command(&xcodegen).args(["generate", "--quiet"]).current_dir(&dir).output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(true)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}
