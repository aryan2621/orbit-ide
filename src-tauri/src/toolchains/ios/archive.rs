//! Release builds: archive → export a signed .ipa → optionally upload to App Store Connect.
//!
//! Upload uses `xcodebuild -exportArchive` with `destination = upload`, which sends the build
//! straight to App Store Connect/TestFlight — no Transporter or altool needed.

use super::{build, project, signing};
use crate::process::{self, JobExit};
use serde::Deserialize;
use std::path::Path;
use tauri::AppHandle;

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    /// App Store and TestFlight.
    AppStoreConnect,
    /// Ad hoc: install on registered devices.
    ReleaseTesting,
    /// Development-signed, for your own devices.
    Debugging,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Method::AppStoreConnect => "app-store-connect",
            Method::ReleaseTesting => "release-testing",
            Method::Debugging => "debugging",
        }
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn export_options_plist(method: Method, upload: bool, team_id: Option<&str>) -> String {
    let mut entries = vec![
        ("method", method.as_str().to_owned()),
        ("destination", if upload { "upload" } else { "export" }.to_owned()),
        ("signingStyle", "automatic".to_owned()),
    ];
    if let Some(team) = team_id.filter(|t| !t.is_empty()) {
        entries.push(("teamID", team.to_owned()));
    }
    let body: String = entries
        .iter()
        .map(|(k, v)| format!("\t<key>{k}</key>\n\t<string>{}</string>\n", xml_escape(v)))
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n{body}</dict>\n</plist>\n"
    )
}

#[tauri::command]
pub fn ios_archive(
    app: AppHandle,
    root: String,
    scheme: String,
    method: Method,
    upload: bool,
    signing: Option<signing::SigningOptions>,
    job_id: String,
) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Xcode project found in this folder")?;
    if project.kind == project::ProjectKind::Package {
        return Err("Swift packages can't be archived as apps. Open an Xcode project.".into());
    }
    let signing = signing.unwrap_or_default();
    let out_dir = Path::new(&project.dir()).join("build");
    let stamp = chrono_stamp();
    let archive_path = out_dir.join(format!("{scheme} {stamp}.xcarchive"));
    let export_path = out_dir.join(format!("{scheme} {stamp}"));
    let plist_path = out_dir.join("ExportOptions.plist");

    process::spawn_task(&app, job_id, move |ctx| async move {
        let _ = std::fs::create_dir_all(&out_dir);
        ctx.emit("phase", "building");
        ctx.log("▸ Archiving (Release, generic iOS device)");
        let mut cmd = build::xcodebuild_command(&project, &scheme, "Release", "generic/platform=iOS");
        cmd.arg("archive").arg("-archivePath").arg(&archive_path).args(signing.xcodebuild_args());
        let archived = build::run_build(&ctx, cmd, false).await;
        if !archived.success() {
            return archived;
        }

        ctx.emit("phase", "installing");
        let plist = export_options_plist(method, upload, signing.team_id.as_deref());
        if let Err(e) = std::fs::write(&plist_path, plist) {
            ctx.log(format!("error: Could not write ExportOptions.plist: {e}"));
            return JobExit::failed();
        }
        ctx.log(if upload { "▸ Exporting and uploading to App Store Connect" } else { "▸ Exporting .ipa" });
        let mut export = crate::env::command("xcodebuild");
        export
            .arg("-exportArchive")
            .arg("-archivePath")
            .arg(&archive_path)
            .arg("-exportPath")
            .arg(&export_path)
            .arg("-exportOptionsPlist")
            .arg(&plist_path)
            .args(signing.xcodebuild_args().into_iter().filter(|a| !a.contains('=')));
        let exported = build::run_build(&ctx, export, false).await;
        if exported.success() {
            let artifact = if upload { archive_path } else { export_path };
            ctx.log(if upload {
                "** UPLOADED: the build appears in TestFlight after Apple finishes processing (usually 5–30 min) **"
            } else {
                "** EXPORT SUCCEEDED **"
            });
            ctx.emit("artifact", artifact.to_string_lossy().into_owned());
        }
        exported
    });
    Ok(())
}

/// `2026-10-11 14.05.09`, like Xcode's archive names (no dependency on a date crate).
fn chrono_stamp() -> String {
    let out = std::process::Command::new("date").arg("+%Y-%m-%d %H.%M.%S").output();
    out.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "latest".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_options_for_testflight_upload() {
        let p = export_options_plist(Method::AppStoreConnect, true, Some("TEAM123456"));
        assert!(p.contains("<key>method</key>\n\t<string>app-store-connect</string>"));
        assert!(p.contains("<key>destination</key>\n\t<string>upload</string>"));
        assert!(p.contains("<key>teamID</key>\n\t<string>TEAM123456</string>"));
    }

    #[test]
    fn export_options_without_team() {
        let p = export_options_plist(Method::ReleaseTesting, false, None);
        assert!(p.contains("<string>release-testing</string>") && p.contains("<string>export</string>"));
        assert!(!p.contains("teamID"));
    }
}
