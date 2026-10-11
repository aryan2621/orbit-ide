//! Builds with xcodebuild, condensing its very verbose log and collecting compiler diagnostics.

use super::{devices, package, project, signing};
use crate::{env, process};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[derive(Serialize, Clone, PartialEq, Eq, Hash, Debug)]
pub struct Diagnostic {
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub severity: String,
    pub message: String,
    /// Plain-English advice for known problems (mostly signing).
    pub hint: Option<String>,
}

/// Parses `path:line:col: error: message`, tool-prefixed `xcodebuild: error: message` /
/// `clang: error: …`, the location-less `error: message`, and linker failures (`ld: …`,
/// `Undefined symbols for architecture …`).
pub fn parse_diagnostic(line: &str) -> Option<Diagnostic> {
    let bare = |severity: &str, message: &str| Diagnostic {
        file: None,
        line: None,
        column: None,
        severity: severity.into(),
        message: message.trim().to_owned(),
        hint: None,
    };
    for severity in ["error", "warning"] {
        let marker = format!(" {severity}: ");
        if let Some(idx) = line.find(&marker) {
            let location = line[..idx].trim_end_matches(':');
            let message = line[idx + marker.len()..].trim().to_owned();
            let mut parts = location.rsplitn(3, ':');
            let (col, ln, file) = (parts.next(), parts.next(), parts.next());
            return match (file, ln.and_then(|l| l.parse().ok()), col.and_then(|c| c.parse().ok())) {
                (Some(file), Some(line), Some(column)) if file.starts_with('/') => Some(Diagnostic {
                    file: Some(file.to_owned()),
                    line: Some(line),
                    column: Some(column),
                    severity: severity.into(),
                    message,
                    hint: None,
                }),
                _ if location.starts_with('/') => Some(Diagnostic {
                    file: Some(location.to_owned()),
                    line: None,
                    column: None,
                    severity: severity.into(),
                    message,
                    hint: None,
                }),
                // A tool name such as `xcodebuild`, `clang` or `ld`: keep it, these are often the
                // only explanation of why the build failed.
                _ if is_tool_name(location) => Some(bare(severity, &format!("{location}: {message}"))),
                _ => None,
            };
        }
        if let Some(message) = line.strip_prefix(&format!("{severity}: ")) {
            return Some(bare(severity, message));
        }
    }
    if let Some(rest) = line.strip_prefix("ld: ") {
        return Some(bare("error", &format!("ld: {rest}")));
    }
    if line.starts_with("Undefined symbols for architecture") {
        return Some(bare("error", line.trim_end_matches(':')));
    }
    None
}

/// `xcodebuild`, `clang`, `swift-frontend`, `ld`… (one word, no path, no spaces).
fn is_tool_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Turns xcodebuild's build-step lines into short summaries; hides the noise (env dumps, commands).
pub fn condense(line: &str) -> Option<String> {
    let t = line.trim_start();
    let file_name = |s: &str| s.rsplit('/').next().unwrap_or(s).to_owned();
    let word = |n: usize| t.split_whitespace().nth(n).map(str::to_owned);

    if t.starts_with("** ") || t.starts_with("note: ") || t.starts_with("Command line invocation") {
        return Some(t.to_owned());
    }
    // Linker detail lines following "Undefined symbols…" ("_foo", referenced from: …).
    if t.contains("referenced from") || (t.starts_with('"') && line.starts_with(' ')) || t.starts_with("clang: ") {
        return Some(t.to_owned());
    }
    if parse_diagnostic(t).is_some() {
        return Some(t.to_owned());
    }
    let step = |verb: &str, arg: Option<String>| Some(format!("▸ {verb} {}", arg.unwrap_or_default()));
    match t.split_whitespace().next()? {
        "SwiftCompile" | "CompileSwift" => {
            let path = t.split_whitespace().find(|w| w.ends_with(".swift"))?;
            step("Compiling", Some(file_name(path)))
        }
        "CompileC" => step("Compiling", word(2).map(|p| file_name(&p))),
        "SwiftEmitModule" | "EmitSwiftModule" => step("Emitting module", None),
        "Ld" => step("Linking", word(1).map(|p| file_name(&p))),
        "CompileAssetCatalog" | "CompileAssetCatalogVariant" => step("Compiling assets", None),
        "CompileStoryboard" | "CompileXIB" => step("Compiling", word(1).map(|p| file_name(&p))),
        "ProcessInfoPlistFile" => step("Processing", word(1).map(|p| file_name(&p))),
        "CodeSign" => step("Signing", word(1).map(|p| file_name(&p))),
        "Touch" | "RegisterExecutionPolicyException" => None,
        "Validate" => step("Validating", word(1).map(|p| file_name(&p))),
        "PhaseScriptExecution" => step("Running script", t.split_whitespace().nth(1).map(str::to_owned)),
        _ => None,
    }
}

#[derive(Default)]
struct BuildHooks {
    diagnostics: Vec<Diagnostic>,
    seen: HashSet<Diagnostic>,
    /// SwiftPM output is already concise; only xcodebuild's needs condensing.
    verbatim: bool,
    steps: u32,
}

impl process::JobHooks for BuildHooks {
    /// SwiftPM prints `[12/80] Compiling …`; xcodebuild has no total, so its steps are counted.
    fn progress(&mut self, line: &str) -> Option<process::Progress> {
        if self.verbatim {
            let (done, total) = line.strip_prefix('[')?.split_once(']')?.0.split_once('/')?;
            return Some(process::Progress { done: done.parse().ok()?, total: total.parse().ok() });
        }
        condense(line).filter(|s| s.starts_with('▸')).map(|_| {
            self.steps += 1;
            process::Progress { done: self.steps, total: None }
        })
    }

    fn line(&mut self, line: &str) -> Option<String> {
        if let Some(mut d) = parse_diagnostic(line.trim()) {
            if self.seen.insert(d.clone()) {
                d.hint = signing::explain(&d.message).map(str::to_owned);
                self.diagnostics.push(d);
            } else {
                return None; // xcodebuild repeats each diagnostic
            }
        }
        if self.verbatim {
            Some(line.to_owned())
        } else {
            condense(line)
        }
    }
}

/// xcodebuild arguments shared by build, run and build-settings queries.
pub fn xcodebuild_command(project: &project::Project, scheme: &str, configuration: &str, destination: &str) -> tokio::process::Command {
    let mut cmd = env::command("xcodebuild");
    cmd.args(project.xcodebuild_args())
        .args(["-scheme", scheme, "-configuration", configuration, "-destination", destination])
        // Without these, projects using Swift macros or package plugins fail on the command line
        // (Xcode asks for trust in a dialog; xcodebuild just errors).
        .args(["-skipMacroValidation", "-skipPackagePluginValidation"])
        .current_dir(project.dir());
    cmd
}

/// Runs `xcodebuild build` inside a job: condensed log on `job://<id>/log`, then
/// `job://<id>/diagnostics` with the deduplicated compiler errors and warnings.
pub async fn build_step(ctx: &process::JobCtx, mut cmd: tokio::process::Command) -> process::JobExit {
    cmd.arg("build");
    run_build(ctx, cmd, false).await
}

/// `swift build` for a package product.
pub async fn package_build_step(ctx: &process::JobCtx, dir: &str, product: &str, configuration: &str) -> process::JobExit {
    run_build(ctx, package::build_command(dir, product, configuration), true).await
}

pub async fn run_build(ctx: &process::JobCtx, cmd: tokio::process::Command, verbatim: bool) -> process::JobExit {
    let hooks = Arc::new(Mutex::new(BuildHooks { verbatim, ..Default::default() }));
    let exit = ctx.run(cmd, "log", hooks.clone()).await;
    ctx.emit("diagnostics", process::lock(&hooks).diagnostics.clone());
    exit
}

/// Builds `scheme` for the selected device (any Simulator when none is selected or it's gone), or a
/// package product with SwiftPM. Building for an iPhone uses the saved signing options.
#[tauri::command]
pub async fn ios_build(
    app: AppHandle,
    root: String,
    scheme: String,
    configuration: String,
    device_id: Option<String>,
    signing: Option<signing::SigningOptions>,
    job_id: String,
) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Xcode project or Swift package found in this folder")?;
    if project.kind == project::ProjectKind::Package {
        let dir = project.dir();
        process::spawn_task(&app, job_id, |ctx| async move { package_build_step(&ctx, &dir, &scheme, &configuration).await });
        return Ok(());
    }
    let device = match device_id {
        Some(id) => devices::list().await.into_iter().find(|d| d.id == id),
        None => None,
    };
    let destination = device.as_ref().map_or_else(|| "generic/platform=iOS Simulator".to_owned(), |d| d.destination());
    let mut cmd = xcodebuild_command(&project, &scheme, &configuration, &destination);
    if device.is_some_and(|d| d.kind == devices::DeviceKind::Device) {
        cmd.args(signing.unwrap_or_default().xcodebuild_args());
    }
    process::spawn_task(&app, job_id, |ctx| async move { build_step(&ctx, cmd).await });
    Ok(())
}

/// Clean (`xcodebuild clean` / `swift package clean`) or Resolve Packages
/// (`xcodebuild -resolvePackageDependencies` / `swift package resolve`) as a job.
#[tauri::command]
pub fn ios_project_action(app: AppHandle, root: String, scheme: String, configuration: String, action: String, job_id: String) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Xcode project or Swift package found in this folder")?;
    let cmd = match (action.as_str(), &project.kind) {
        ("clean", project::ProjectKind::Package) => package_command(&project.dir(), "clean"),
        ("resolve", project::ProjectKind::Package) => package_command(&project.dir(), "resolve"),
        ("clean", _) => {
            let mut cmd = xcodebuild_command(&project, &scheme, &configuration, "generic/platform=iOS Simulator");
            cmd.arg("clean");
            cmd
        }
        ("resolve", _) => {
            let mut cmd = env::command("xcodebuild");
            cmd.args(project.xcodebuild_args()).args(["-scheme", &scheme, "-resolvePackageDependencies"]).current_dir(project.dir());
            cmd
        }
        _ => return Err(format!("Unknown action {action}")),
    };
    process::spawn_task(&app, job_id, |ctx| async move { run_build(&ctx, cmd, true).await });
    Ok(())
}

fn package_command(dir: &str, verb: &str) -> tokio::process::Command {
    let mut cmd = env::command("swift");
    cmd.args(["package", verb]).current_dir(dir);
    cmd
}
