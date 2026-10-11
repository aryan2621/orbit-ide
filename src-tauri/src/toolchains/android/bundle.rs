//! Release builds: a signed App Bundle (.aab) for Google Play or a signed .apk for sideloading,
//! optionally uploaded to a Play track through the Play Developer API (play.rs).

use super::build::run_gradle;
use super::project::{self, Project};
use super::run::built_apk;
use super::{sdk, signing};
use crate::process::{self, JobCtx, JobExit};
use crate::toolchains::ios::build::Diagnostic;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayUpload {
    /// internal, alpha (closed), beta (open) or production.
    pub track: String,
    /// Google Cloud service-account key with access to the app in Play Console.
    pub service_account_json: String,
    /// Upload as a draft release instead of rolling it out.
    #[serde(default)]
    pub draft: bool,
}

fn fail(ctx: &JobCtx, message: String, hint: Option<&str>) -> JobExit {
    ctx.log(format!("error: {message}"));
    ctx.emit("diagnostics", vec![Diagnostic { file: None, line: None, column: None, severity: "error".into(), message, hint: hint.map(str::to_owned) }]);
    JobExit::failed()
}

/// The .aab Gradle wrote for `variant` (`build/outputs/bundle/<variant>/*.aab`).
fn built_bundle(project: &Project, module: &str, variant: &str) -> Option<PathBuf> {
    let dir = project.dir().join(module.trim_start_matches(':').replace(':', "/")).join("build/outputs/bundle").join(variant);
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "aab"))
}

/// `applicationId = "com.example.app"` from the module's build script (for the Play upload).
fn application_id(project: &Project, module: &str) -> Option<String> {
    let dir = project.dir().join(module.trim_start_matches(':').replace(':', "/"));
    let script = ["build.gradle.kts", "build.gradle"].iter().find_map(|f| std::fs::read_to_string(dir.join(f)).ok())?;
    script.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("applicationId")?;
        let start = rest.find(['"', '\''])? + 1;
        let end = rest[start..].find(['"', '\''])? + start;
        Some(rest[start..end].to_owned())
    })
}

async fn archive_task(ctx: JobCtx, project: Project, module: String, variant: String, format: String, upload: Option<PlayUpload>) -> JobExit {
    let shell = sdk::shell_env().await;
    let mut cmd = project::gradlew(&project, &shell).await;
    let verb = if format == "apk" { "assemble" } else { "bundle" };
    let task = project::task(&module, verb, &variant);
    cmd.arg(&task);

    // Sign with the keystore saved in Android Signing, unless the project signs releases itself.
    match signing::gradle_signing_env(&project.path).await {
        Ok(vars) => {
            cmd.envs(vars);
            ctx.log("Signing with the keystore from Android Signing");
        }
        Err(e) => {
            let script = ["build.gradle.kts", "build.gradle"]
                .iter()
                .find_map(|f| std::fs::read_to_string(project.dir().join(module.trim_start_matches(':').replace(':', "/")).join(f)).ok())
                .unwrap_or_default();
            if !signing::project_signs_release(&script) {
                return fail(&ctx, e, Some("Create or pick an upload keystore in Android Signing, then archive again."));
            }
            ctx.log("Using the signing config from the project's build script");
        }
    }

    ctx.emit("phase", "building");
    ctx.log(format!("$ ./gradlew {task}"));
    let exit = run_gradle(&ctx, cmd).await;
    if !exit.success() {
        return exit;
    }
    let artifact = if format == "apk" { built_apk(&project, &module, &variant).map(|(p, _)| p) } else { built_bundle(&project, &module, &variant) };
    let Some(artifact) = artifact else {
        return fail(&ctx, format!("Gradle finished but no {} was found for {variant}", if format == "apk" { ".apk" } else { ".aab" }), None);
    };
    ctx.log(format!("** {} SUCCEEDED ** {}", if format == "apk" { "APK" } else { "BUNDLE" }, artifact.display()));
    ctx.emit("artifact", artifact.to_string_lossy().into_owned());

    let Some(upload) = upload else { return exit };
    if format == "apk" {
        return fail(&ctx, "Google Play only accepts App Bundles (.aab) for new apps".into(), Some("Archive as App Bundle to upload."));
    }
    if !Path::new(&upload.service_account_json).is_file() {
        return fail(&ctx, format!("Service account key not found: {}", upload.service_account_json), None);
    }
    let Some(package) = application_id(&project, &module) else {
        return fail(&ctx, "Couldn't read applicationId from the build script".into(), None);
    };
    ctx.emit("phase", "installing");
    ctx.log(format!("Uploading to the {} track…", upload.track));
    match super::play::upload(&ctx, &upload.service_account_json, &package, &artifact, &upload.track, upload.draft).await {
        Ok(what) => {
            ctx.log(format!("** UPLOAD SUCCEEDED ** {package} {what} → {}", upload.track));
            exit
        }
        Err(_) if ctx.cancelled() => JobExit { code: None, cancelled: true },
        Err(e) => fail(&ctx, format!("Upload to Google Play failed: {e}"), Some(
            "Check that the service account has access to the app in Play Console (Users and permissions), and that the app already exists there; the very first upload has to be done in Play Console.",
        )),
    }
}

/// Builds a signed release `.aab` (`format: "aab"`) or `.apk` for `scheme` (module) in
/// `configuration` (variant), and uploads the bundle to Google Play when `upload` is given.
#[tauri::command]
pub fn android_archive(app: AppHandle, root: String, scheme: String, configuration: String, format: String, upload: Option<PlayUpload>, job_id: String) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Gradle project found in this folder")?;
    let variant = project::variant_name(&configuration);
    process::spawn_task(&app, job_id, move |ctx| archive_task(ctx, project, scheme, variant, format, upload));
    Ok(())
}
