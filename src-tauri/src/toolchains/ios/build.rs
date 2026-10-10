//! Builds with xcodebuild, condensing its very verbose log and collecting compiler diagnostics.

use super::{package, project, signing};
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

/// Parses `path:line:col: error: message` (and the location-less `error: message`) lines.
pub fn parse_diagnostic(line: &str) -> Option<Diagnostic> {
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
                _ => None,
            };
        }
        let bare = format!("{severity}: ");
        if let Some(message) = line.strip_prefix(&bare) {
            return Some(Diagnostic { file: None, line: None, column: None, severity: severity.into(), message: message.trim().to_owned(), hint: None });
        }
    }
    None
}

/// Turns xcodebuild's build-step lines into short summaries; hides the noise (env dumps, commands).
pub fn condense(line: &str) -> Option<String> {
    let t = line.trim_start();
    let file_name = |s: &str| s.rsplit('/').next().unwrap_or(s).to_owned();
    let word = |n: usize| t.split_whitespace().nth(n).map(str::to_owned);

    if t.starts_with("** ") || t.starts_with("note: ") || t.starts_with("Command line invocation") {
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
}

impl process::JobHooks for BuildHooks {
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
    ctx.emit("diagnostics", hooks.lock().unwrap().diagnostics.clone());
    exit
}

/// Builds `scheme` for the iOS Simulator (no device needed), or a package product with SwiftPM.
#[tauri::command]
pub fn ios_build(app: AppHandle, root: String, scheme: String, configuration: String, job_id: String) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Xcode project or Swift package found in this folder")?;
    if project.kind == project::ProjectKind::Package {
        let dir = project.dir();
        process::spawn_task(&app, job_id, |ctx| async move { package_build_step(&ctx, &dir, &scheme, &configuration).await });
        return Ok(());
    }
    let cmd = xcodebuild_command(&project, &scheme, &configuration, "generic/platform=iOS Simulator");
    process::spawn_task(&app, job_id, |ctx| async move { build_step(&ctx, cmd).await });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_located_error() {
        let d = parse_diagnostic("/Users/me/App/ContentView.swift:12:9: error: cannot find 'foo' in scope").unwrap();
        assert_eq!(d.file.as_deref(), Some("/Users/me/App/ContentView.swift"));
        assert_eq!((d.line, d.column), (Some(12), Some(9)));
        assert_eq!(d.severity, "error");
        assert_eq!(d.message, "cannot find 'foo' in scope");
    }

    #[test]
    fn parses_warning_and_bare_error() {
        let w = parse_diagnostic("/a/b.swift:3:1: warning: variable 'x' was never used").unwrap();
        assert_eq!(w.severity, "warning");
        let e = parse_diagnostic("error: No profiles for 'com.x.app' were found").unwrap();
        assert_eq!(e.file, None);
        assert_eq!(e.message, "No profiles for 'com.x.app' were found");
    }

    #[test]
    fn ignores_normal_lines() {
        assert!(parse_diagnostic("    cd /Users/me/App").is_none());
        assert!(parse_diagnostic("note: Building targets in dependency order").is_none());
    }

    #[test]
    fn condenses_steps() {
        assert_eq!(
            condense("SwiftCompile normal arm64 Compiling\\ ContentView.swift /Users/me/App/ContentView.swift (in target 'App' from project 'App')").as_deref(),
            Some("▸ Compiling ContentView.swift")
        );
        assert_eq!(condense("    export PATH=/usr/bin"), None);
        assert_eq!(condense("** BUILD SUCCEEDED **").as_deref(), Some("** BUILD SUCCEEDED **"));
    }
}
