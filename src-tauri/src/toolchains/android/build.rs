//! Builds with the project's Gradle wrapper, condensing Gradle's task log and collecting Kotlin,
//! Java, resource and manifest diagnostics.

use super::project::{self, Project};
use super::sdk;
use crate::process::{self, JobCtx, JobExit, JobHooks};
use crate::toolchains::ios::build::Diagnostic;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

fn diagnostic(file: Option<String>, line: Option<u32>, column: Option<u32>, severity: &str, message: &str) -> Diagnostic {
    let message = message.trim().to_owned();
    Diagnostic { file, line, column, severity: severity.into(), hint: explain(&message).map(str::to_owned), message }
}

/// `file:///a/b.kt` or `/a/b.kt` → `/a/b.kt`.
fn file_path(s: &str) -> Option<String> {
    let p = s.strip_prefix("file://").unwrap_or(s);
    p.starts_with('/').then(|| p.to_owned())
}

/// Splits `/path/File.kt:12:5` into (path, line, column); line and column are optional.
fn split_location(loc: &str) -> Option<(String, Option<u32>, Option<u32>)> {
    let mut parts = loc.rsplitn(3, ':');
    let last = parts.next()?;
    let mid = parts.next();
    let first = parts.next();
    let (file, line, col) = match (first, mid.and_then(|m| m.parse().ok()), last.parse().ok()) {
        (Some(f), Some(l), Some(c)) => (f.to_owned(), Some(l), Some(c)),
        _ => match (mid, last.parse().ok()) {
            (Some(m), Some(l)) => (format!("{}{m}", first.map(|f| format!("{f}:")).unwrap_or_default()), Some(l), None),
            _ => (loc.to_owned(), None, None),
        },
    };
    Some((file_path(&file)?, line, col))
}

/// One compiler/tool diagnostic line from a Gradle build, in any of the formats Android tools print.
pub fn parse_diagnostic(line: &str) -> Option<Diagnostic> {
    let t = line.trim();
    // Kotlin 2.x: `e: file:///path/Main.kt:12:5 Unresolved reference 'x'.`
    for (prefix, severity) in [("e: ", "error"), ("w: ", "warning")] {
        if let Some(rest) = t.strip_prefix(prefix) {
            if let Some((loc, msg)) = rest.split_once(' ') {
                // Kotlin 1.x: `e: /path/Main.kt: (12, 5): message`
                if let Some(old) = loc.strip_suffix(':').filter(|_| msg.starts_with('(')) {
                    let (pos, msg) = msg.split_once("): ").unwrap_or((msg, ""));
                    let mut nums = pos.trim_start_matches('(').split(", ").map(|n| n.parse().ok());
                    return Some(diagnostic(file_path(old), nums.next().flatten(), nums.next().flatten(), severity, msg));
                }
                if let Some((file, l, c)) = split_location(loc) {
                    return Some(diagnostic(Some(file), l, c, severity, msg));
                }
            }
            return Some(diagnostic(None, None, None, severity, rest));
        }
    }
    // AAPT: `ERROR: /path/res/layout/main.xml:12: AAPT: error: message`
    if let Some(rest) = t.strip_prefix("ERROR: ").or_else(|| t.strip_prefix("ERROR:")) {
        let (loc, msg) = rest.split_once(": AAPT: error: ").or_else(|| rest.split_once(": error: "))?;
        let (file, l, c) = split_location(loc.trim())?;
        return Some(diagnostic(Some(file), l, c, "error", msg));
    }
    // javac: `/path/A.java:12: error: cannot find symbol`
    for severity in ["error", "warning"] {
        if let Some((loc, msg)) = t.split_once(&format!(": {severity}: ")) {
            if loc.starts_with('/') {
                let (file, l, c) = split_location(loc)?;
                return Some(diagnostic(Some(file), l, c, severity, msg));
            }
        }
    }
    // Manifest merger: `/path/AndroidManifest.xml:5:5-20:19 Error:` (message continues on the next line)
    if t.starts_with('/') && t.contains("AndroidManifest.xml") {
        for (marker, severity) in [(" Error:", "error"), (" Warning:", "warning")] {
            if let Some((loc, msg)) = t.split_once(marker) {
                let loc = loc.split('-').next().unwrap_or(loc);
                let (file, l, c) = split_location(loc)?;
                return Some(diagnostic(Some(file), l, c, severity, msg));
            }
        }
    }
    None
}

/// Plain-English advice for common Android build failures.
pub fn explain(message: &str) -> Option<&'static str> {
    let m = message.to_lowercase();
    let rules: &[(&[&str], &str)] = &[
        (&["licences have not been accepted", "licenses have not been accepted", "license for package"],
            "Accept the Android SDK licenses: open Setup (Android) and run the \"SDK licenses\" step."),
        (&["unsupported class file major version"],
            "Gradle is running on a JDK this project's Gradle version doesn't support. Use JDK 17 or 21 (set JAVA_HOME), or update distributionUrl in gradle/wrapper/gradle-wrapper.properties."),
        (&["requires java 17", "requires java 11", "android gradle plugin requires java"],
            "This Android Gradle Plugin needs a newer JDK. Install JDK 17 (Setup → Android) and point JAVA_HOME at it."),
        (&["sdk location not found", "android_home"],
            "Gradle can't find the Android SDK. Set ANDROID_HOME (Setup → Android), or add sdk.dir=… to local.properties."),
        (&["minimum supported gradle version is", "requires gradle", "gradle version is too old"],
            "This Android Gradle Plugin needs a newer Gradle. Update distributionUrl in gradle/wrapper/gradle-wrapper.properties to the version named above."),
        (&["to compile against version", "compilesdk"],
            "A dependency needs a newer compileSdk. Raise compileSdk in the app's build.gradle(.kts) to the version named above and install that platform (Setup → Android)."),
        (&["minsdkversion", "cannot be smaller than version"],
            "A dependency needs a higher minSdk. Raise minSdk in the module's build.gradle(.kts), or add tools:overrideLibrary in the manifest."),
        (&["failed to find target with hash string", "failed to find platform sdk"],
            "The Android platform this project compiles against isn't installed. Install it with sdkmanager \"platforms;android-NN\"."),
        (&["could not resolve", "could not get", "could not download"],
            "Gradle couldn't download a dependency. Check your internet connection and the repositories in settings.gradle(.kts)."),
    ];
    rules.iter().find(|(keys, _)| keys.iter().any(|k| m.contains(k))).map(|(_, hint)| *hint)
}

/// Turns Gradle's task list into short steps, keeping only what's worth reading.
pub fn condense(line: &str) -> Option<String> {
    let t = line.trim_end();
    if let Some(task) = t.strip_prefix("> Task ") {
        let (path, outcome) = task.split_once(' ').unwrap_or((task, ""));
        if !outcome.is_empty() {
            return None; // UP-TO-DATE, NO-SOURCE, FROM-CACHE, SKIPPED
        }
        let (module, name) = path.trim_start_matches(':').rsplit_once(':').unwrap_or(("", path.trim_start_matches(':')));
        let module = if module.is_empty() { String::new() } else { format!(" ({module})") };
        let step = if name.starts_with("compile") && name.ends_with("Kotlin") {
            "Compiling Kotlin"
        } else if name.starts_with("compile") && name.ends_with("JavaWithJavac") {
            "Compiling Java"
        } else if name.starts_with("merge") && name.ends_with("Resources") || name.starts_with("process") && name.ends_with("Resources") {
            "Processing resources"
        } else if name.starts_with("process") && name.ends_with("MainManifest") {
            "Merging manifest"
        } else if name.starts_with("dexBuilder") || name.starts_with("mergeProjectDex") {
            "Converting to dex"
        } else if name.starts_with("minify") {
            "Shrinking with R8"
        } else if name.starts_with("package") && !name.contains("Resources") {
            "Packaging"
        } else if name.starts_with("sign") || name.starts_with("bundle") && !name.contains("Resources") {
            "Bundling"
        } else {
            return None;
        };
        return Some(format!("▸ {step}{module}"));
    }
    let keep = ["BUILD ", "FAILURE:", "Downloading https://", "Starting a Gradle Daemon", "Welcome to Gradle"];
    keep.iter().any(|k| t.starts_with(k)).then(|| t.to_owned())
}

/// Collects diagnostics while condensing the log. Also captures Gradle's "What went wrong" block,
/// reported only when no located diagnostic explains the failure (e.g. SDK or JDK problems).
#[derive(Default)]
pub struct GradleHooks {
    pub diagnostics: Vec<Diagnostic>,
    seen: HashSet<Diagnostic>,
    last: Option<String>,
    /// Inside `* What went wrong:` until `* Try:`.
    in_failure: bool,
    failure: Vec<String>,
    /// A manifest-merger diagnostic whose message is on the following line.
    pending: Option<Diagnostic>,
    pub verbatim: bool,
}

impl GradleHooks {
    fn push(&mut self, d: Diagnostic) {
        if self.seen.insert(d.clone()) {
            self.diagnostics.push(d);
        }
    }

    /// Diagnostics for the finished build.
    pub fn finish(&mut self) -> Vec<Diagnostic> {
        if let Some(d) = self.pending.take() {
            self.push(d);
        }
        let located = self.diagnostics.iter().any(|d| d.severity == "error" && d.file.is_some());
        if !located && !self.failure.is_empty() {
            let lines: Vec<&str> = self.failure.iter().map(|l| l.trim().trim_start_matches("> ").trim()).filter(|l| !l.is_empty()).collect();
            // The hint looks at the whole block; the message keeps its first few lines.
            let mut d = diagnostic(None, None, None, "error", &lines.join("\n"));
            d.message = lines.iter().take(6).copied().collect::<Vec<_>>().join(" — ");
            self.push(d);
        }
        self.diagnostics.clone()
    }
}

impl JobHooks for GradleHooks {
    fn line(&mut self, line: &str) -> Option<String> {
        let t = line.trim_end();
        if let Some(mut d) = self.pending.take() {
            if d.message.is_empty() {
                d.message = t.trim().to_owned();
                d.hint = explain(&d.message).map(str::to_owned);
            }
            self.push(d);
        }
        if t.starts_with("* What went wrong:") {
            self.in_failure = true;
            return Some(t.to_owned());
        }
        if self.in_failure {
            if t.starts_with("* Try:") || t.starts_with("BUILD ") {
                self.in_failure = false;
            } else {
                self.failure.push(t.to_owned());
                return Some(t.to_owned());
            }
        }
        if let Some(d) = parse_diagnostic(t) {
            let shown = t.to_owned();
            if d.message.is_empty() && d.file.as_deref().is_some_and(|f| f.ends_with("AndroidManifest.xml")) {
                self.pending = Some(d);
            } else {
                self.push(d);
            }
            return Some(shown);
        }
        let out = if self.verbatim { Some(t.to_owned()) } else { condense(t) };
        // Several tasks map to the same step; show it once in a row.
        if out.is_some() && out == self.last {
            return None;
        }
        if out.is_some() {
            self.last = out.clone();
        }
        out
    }
}

/// Runs a Gradle invocation inside a job: condensed log on `log`, then `diagnostics`.
pub async fn run_gradle(ctx: &JobCtx, cmd: tokio::process::Command) -> JobExit {
    let hooks = Arc::new(Mutex::new(GradleHooks::default()));
    let exit = ctx.run(cmd, "log", hooks.clone()).await;
    let diagnostics = hooks.lock().unwrap().finish();
    ctx.emit("diagnostics", diagnostics);
    exit
}

/// `./gradlew :module:assemble<Variant>` as a job step.
pub async fn assemble_step(ctx: &JobCtx, project: &Project, module: &str, variant: &str) -> JobExit {
    let shell = sdk::shell_env().await;
    let mut cmd = project::gradlew(project, &shell).await;
    let task = project::task(module, "assemble", variant);
    cmd.arg(&task);
    ctx.log(format!("$ ./gradlew {task}"));
    run_gradle(ctx, cmd).await
}

#[tauri::command]
pub fn android_build(app: AppHandle, root: String, scheme: String, configuration: String, job_id: String) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Gradle project found in this folder")?;
    process::spawn_task(&app, job_id, |ctx| async move { assemble_step(&ctx, &project, &scheme, &configuration).await });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(log: &str) -> (Vec<String>, Vec<Diagnostic>) {
        let mut hooks = GradleHooks::default();
        let shown = log.lines().filter_map(|l| hooks.line(l)).collect();
        (shown, hooks.finish())
    }

    #[test]
    fn kotlin_diagnostics() {
        let d = parse_diagnostic("e: file:///Users/me/app/src/main/java/A.kt:14:24 Unresolved reference 'x'.").unwrap();
        assert_eq!(d.file.as_deref(), Some("/Users/me/app/src/main/java/A.kt"));
        assert_eq!((d.line, d.column, d.severity.as_str()), (Some(14), Some(24), "error"));
        assert_eq!(d.message, "Unresolved reference 'x'.");
        let old = parse_diagnostic("w: /Users/me/A.kt: (3, 9): Variable 'y' is never used").unwrap();
        assert_eq!((old.file.as_deref(), old.line, old.column), (Some("/Users/me/A.kt"), Some(3), Some(9)));
        assert_eq!(old.message, "Variable 'y' is never used");
    }

    #[test]
    fn java_aapt_manifest_diagnostics() {
        let j = parse_diagnostic("/Users/me/app/src/main/java/B.java:7: error: cannot find symbol").unwrap();
        assert_eq!((j.line, j.column, j.message.as_str()), (Some(7), None, "cannot find symbol"));
        let a = parse_diagnostic("ERROR: /Users/me/app/src/main/res/layout/main.xml:12: AAPT: error: attribute android:foo not found.").unwrap();
        assert_eq!((a.file.as_deref(), a.line), (Some("/Users/me/app/src/main/res/layout/main.xml"), Some(12)));
        let (_, ds) = run("/Users/me/app/src/main/AndroidManifest.xml:5:5-20:19 Error:\n\tAttribute application@label value=(A) is also present at [lib] value=(B).\n");
        assert_eq!(ds[0].file.as_deref(), Some("/Users/me/app/src/main/AndroidManifest.xml"));
        assert_eq!((ds[0].line, ds[0].column), (Some(5), Some(5)));
        assert!(ds[0].message.starts_with("Attribute application@label"));
        assert!(parse_diagnostic("> Task :app:compileDebugKotlin").is_none());
        assert!(parse_diagnostic("BUILD SUCCESSFUL in 4s").is_none());
    }

    #[test]
    fn kotlin_error_build_log() {
        let (shown, ds) = run(include_str!("fixtures/kotlin_error.log"));
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert!(ds[0].file.as_deref().unwrap().ends_with("MainActivity.kt"));
        assert_eq!(ds[0].line, Some(14));
        assert!(shown.iter().any(|l| l.starts_with("BUILD FAILED")));
        assert!(!shown.iter().any(|l| l.contains("UP-TO-DATE")));
    }

    #[test]
    fn configuration_failure_gets_hint() {
        let (_, ds) = run(include_str!("fixtures/aar_metadata_failure.log"));
        assert_eq!(ds.len(), 1, "{ds:?}");
        assert_eq!(ds[0].file, None);
        assert!(ds[0].message.contains("checkDebugAarMetadata"));
        assert!(ds[0].hint.as_deref().unwrap().contains("compileSdk"));
    }

    #[test]
    fn condenses_tasks() {
        assert_eq!(condense("> Task :app:compileDebugKotlin").as_deref(), Some("▸ Compiling Kotlin (app)"));
        assert_eq!(condense("> Task :app:packageDebug").as_deref(), Some("▸ Packaging (app)"));
        assert_eq!(condense("> Task :app:mergeDebugResources UP-TO-DATE"), None);
        assert_eq!(condense("> Task :app:preBuild"), None);
        assert_eq!(condense("BUILD SUCCESSFUL in 4s").as_deref(), Some("BUILD SUCCESSFUL in 4s"));
        assert_eq!(explain("Unsupported class file major version 69"), explain("unsupported class file major version 65"));
    }
}
