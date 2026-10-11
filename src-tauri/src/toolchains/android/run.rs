//! Run: build with Gradle → start the emulator if needed → `adb install` → launch → stream Logcat.

use super::build::assemble_step;
use super::devices::{self, adb, adb_output, AVD_PREFIX};
use super::project::{self, Project};
use crate::process::{self, JobCtx, JobExit};
use crate::toolchains::ios::build::Diagnostic;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

/// The APK a variant produced, and its application id, from Gradle's `output-metadata.json`.
pub fn built_apk(project: &Project, module: &str, variant: &str) -> Option<(PathBuf, String)> {
    let outputs = project.dir().join(module.trim_start_matches(':').replace(':', "/")).join("build/outputs/apk");
    let mut stack = vec![outputs];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|n| n == "output-metadata.json") {
                if let Some(found) = parse_output_metadata(&path, variant) {
                    return Some(found);
                }
            }
        }
    }
    None
}

fn parse_output_metadata(path: &Path, variant: &str) -> Option<(PathBuf, String)> {
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    if !json["variantName"].as_str().is_some_and(|v| v.eq_ignore_ascii_case(variant)) {
        return None;
    }
    let file = json["elements"].as_array()?.iter().find_map(|e| e["outputFile"].as_str())?;
    Some((path.parent()?.join(file), json["applicationId"].as_str()?.to_owned()))
}

/// One parsed `adb logcat -v threadtime` line, sent in batches as `job://<id>/logcat`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LogcatLine {
    pub time: String,
    pub pid: u32,
    pub tid: u32,
    /// V, D, I, W, E, F or A.
    pub level: String,
    pub tag: String,
    pub message: String,
}

/// Chatty apps log hundreds of lines a second: Logcat goes to the UI as one `job://<id>/logcat`
/// event (an array) per [`BATCH`], not one event per line.
const BATCH: Duration = Duration::from_millis(100);

struct LogcatBatch {
    lines: Vec<LogcatLine>,
    since: std::time::Instant,
}

impl LogcatBatch {
    fn new() -> Self {
        LogcatBatch { lines: Vec::new(), since: std::time::Instant::now() }
    }

    fn push(&mut self, ctx: &JobCtx, line: LogcatLine) {
        self.lines.push(line);
        if self.since.elapsed() >= BATCH {
            self.flush(ctx);
        }
    }

    fn flush(&mut self, ctx: &JobCtx) {
        if !self.lines.is_empty() {
            ctx.emit("logcat", std::mem::take(&mut self.lines));
        }
        self.since = std::time::Instant::now();
    }
}

/// `10-11 14:03:22.123  1234  1250 I Hello   : MainActivity created`
pub fn parse_logcat(line: &str) -> Option<LogcatLine> {
    let mut rest = line.trim_start();
    let mut fields = Vec::new();
    for _ in 0..5 {
        let (field, tail) = rest.split_once(char::is_whitespace)?;
        fields.push(field);
        rest = tail.trim_start();
    }
    let (tag, message) = rest.split_once(": ").map(|(t, m)| (t.trim_end(), m)).unwrap_or((rest.trim_end_matches(':').trim_end(), ""));
    Some(LogcatLine {
        time: fields[1].to_owned(),
        pid: fields[2].parse().ok()?,
        tid: fields[3].parse().ok()?,
        level: fields[4].to_owned(),
        tag: tag.to_owned(),
        message: message.to_owned(),
    })
}

/// Size and modification time of an APK, to tell whether it changed since it was installed.
type ApkStamp = (u64, std::time::SystemTime);

fn apk_stamp(apk: &Path) -> Option<ApkStamp> {
    let meta = std::fs::metadata(apk).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// What Orbit last installed, per (device serial, package).
fn installed_stamps() -> &'static std::sync::Mutex<std::collections::HashMap<(String, String), ApkStamp>> {
    static STAMPS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<(String, String), ApkStamp>>> = std::sync::OnceLock::new();
    STAMPS.get_or_init(Default::default)
}

/// Plain-English help for `adb install` failures.
fn explain_install(output: &str) -> Option<&'static str> {
    let rules: &[(&str, &str)] = &[
        ("INSTALL_FAILED_UPDATE_INCOMPATIBLE", "A copy of this app signed with a different key is installed. Uninstall it from the device and run again."),
        ("INSTALL_FAILED_OLDER_SDK", "The device's Android version is older than the app's minSdk. Use a newer emulator or lower minSdk."),
        ("INSTALL_FAILED_INSUFFICIENT_STORAGE", "The device is out of storage. Free some space (or wipe the emulator's data) and try again."),
        ("INSTALL_FAILED_NO_MATCHING_ABIS", "The app's native libraries don't support this device's CPU. Use an emulator with a matching ABI."),
        ("INSTALL_FAILED_VERSION_DOWNGRADE", "A newer version of the app is installed. Uninstall it from the device first."),
        ("INSTALL_PARSE_FAILED_NO_CERTIFICATES", "This APK isn't signed. Release builds need a keystore: set one up in Android Signing, or run the debug variant."),
        ("INSTALL_FAILED_TEST_ONLY", "The APK is marked test-only. Run from Orbit (which allows test APKs) or build a non-test variant."),
        ("device offline", "The device went offline. Reconnect it (or restart the emulator) and run again."),
        ("unauthorized", "Allow USB debugging: unlock the phone and accept the \"Allow USB debugging?\" prompt."),
    ];
    rules.iter().find(|(k, _)| output.contains(k)).map(|(_, h)| *h)
}

fn hint_diagnostic(message: String, hint: Option<&str>) -> Diagnostic {
    Diagnostic { file: None, line: None, column: None, severity: "error".into(), message, hint: hint.map(str::to_owned) }
}

/// How a run's Logcat stream ended.
enum RunEnd {
    /// The app's process exited; `crashed` if it died with a FATAL EXCEPTION.
    Exited { crashed: bool },
    /// The user pressed Stop.
    Cancelled,
    /// Logcat stopped because the device disconnected (cable pulled, emulator closed).
    Disconnected,
}

fn is_fatal(l: &LogcatLine) -> bool {
    l.tag == "AndroidRuntime" && l.level == "E" && l.message.starts_with("FATAL EXCEPTION")
}

/// Streams the app's Logcat to `console` (readable) and `logcat` (structured) until the app's
/// process exits, the device goes away, or the job is cancelled.
async fn stream_logcat(ctx: &JobCtx, adb_bin: &PathBuf, serial: &str, package: &str, pid: u32) -> RunEnd {
    let child = adb(adb_bin, Some(serial))
        .args(["logcat", "-v", "threadtime", &format!("--pid={pid}")])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else { return RunEnd::Disconnected };
    let Some(stdout) = child.stdout.take() else { return RunEnd::Disconnected };
    let mut lines = BufReader::new(stdout).lines();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut flush = tokio::time::interval(BATCH);
    let mut batch = LogcatBatch::new();
    let mut crashed = false;
    let mut checks = 0u32;
    loop {
        tokio::select! {
            _ = flush.tick() => batch.flush(ctx),
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    match parse_logcat(&line) {
                        Some(l) => {
                            crashed |= is_fatal(&l);
                            ctx.emit("console", format!("{} {}/{}: {}", l.time, l.level, l.tag, l.message));
                            batch.push(ctx, l);
                        }
                        None if line.starts_with("---------") => {}
                        None => ctx.emit("console", line),
                    }
                }
                _ => {
                    // Logcat ended on its own: either the device is gone, or adb restarted.
                    batch.flush(ctx);
                    let _ = child.kill().await;
                    let still_there = adb_output(adb_bin, Some(serial), &["get-state"]).await.as_deref() == Some("device");
                    return if still_there { RunEnd::Exited { crashed } } else { RunEnd::Disconnected };
                }
            },
            _ = tick.tick() => {
                if ctx.cancelled() {
                    batch.flush(ctx);
                    let _ = child.kill().await;
                    return RunEnd::Cancelled;
                }
                // Every few seconds, stop once the app's process is gone (closed or crashed).
                checks += 1;
                if checks % 3 == 0 && adb_output(adb_bin, Some(serial), &["shell", "pidof", package]).await.and_then(|p| p.split_whitespace().next().and_then(|p| p.parse::<u32>().ok())) != Some(pid) {
                    // Give logcat a moment to flush the crash report.
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    while let Ok(Ok(Some(line))) = tokio::time::timeout(Duration::from_millis(200), lines.next_line()).await {
                        if let Some(l) = parse_logcat(&line) {
                            crashed |= is_fatal(&l);
                            ctx.emit("console", format!("{} {}/{}: {}", l.time, l.level, l.tag, l.message));
                            batch.push(ctx, l);
                        }
                    }
                    break;
                }
            }
        }
    }
    batch.flush(ctx);
    let _ = child.kill().await;
    RunEnd::Exited { crashed }
}

/// What the debugger should attach to, sent as `job://<id>/debug-target`. The app is started with
/// `am start -D`, so it waits until the debugger attaches.
#[derive(Serialize, Clone)]
struct JvmDebugTarget {
    /// Always "jvm" (iOS targets are "attach"/"launch").
    kind: &'static str,
    /// The debug adapter to start through the DAP bridge.
    program: String,
    args: Vec<String>,
    /// Sent in the DAP `attach` request.
    #[serde(rename = "projectRoot")]
    project_root: String,
    #[serde(rename = "hostName")]
    host_name: &'static str,
    port: u16,
}

async fn run_task(ctx: JobCtx, project: Project, module: String, variant: String, device_id: String, debug: bool) -> JobExit {
    let fail = |ctx: &JobCtx, message: String, hint: Option<&str>| {
        ctx.log(format!("error: {message}"));
        ctx.emit("diagnostics", vec![hint_diagnostic(message, hint)]);
        JobExit::failed()
    };
    let Some(adb_bin) = devices::adb_path().await else {
        return fail(&ctx, "adb isn't installed".into(), Some("Install the SDK platform tools: open Setup (Android)."));
    };
    let adapter = if debug {
        match super::lsp::debug_adapter() {
            Some(a) => Some(a),
            None => return fail(&ctx, "The Kotlin debugger isn't installed".into(), Some("Install it from Setup (Android) → Debugger.")),
        }
    } else {
        None
    };

    // A connected device must be ready before spending minutes on a build.
    if !device_id.starts_with(AVD_PREFIX) {
        match adb_output(&adb_bin, Some(&device_id), &["get-state"]).await.as_deref() {
            Some("device") => {}
            _ => {
                return fail(
                    &ctx,
                    format!("{device_id} isn't ready"),
                    Some("Unlock the phone and accept \"Allow USB debugging?\", or reconnect it. Then refresh the device list."),
                )
            }
        }
    }

    ctx.emit("phase", "building");
    let exit = assemble_step(&ctx, &project, &module, &variant).await;
    if !exit.success() {
        return exit;
    }
    let Some((apk, package)) = built_apk(&project, &module, &variant) else {
        return fail(&ctx, format!("Gradle finished but no APK was found for the {variant} variant"), None);
    };

    // Start the emulator now (not before the build) so a failed build doesn't boot one for nothing.
    let serial = match device_id.strip_prefix(AVD_PREFIX) {
        Some(avd) => match devices::boot_avd(&adb_bin, avd, |l| ctx.log(l), || ctx.cancelled()).await {
            Ok(s) => s,
            Err(_) if ctx.cancelled() => return JobExit { code: None, cancelled: true },
            Err(e) => return fail(&ctx, e, None),
        },
        None => device_id,
    };

    ctx.emit("phase", "installing");
    // Gradle often finds nothing to rebuild; reinstalling the same APK then just wastes seconds.
    let stamp = apk_stamp(&apk);
    let unchanged = stamp.is_some()
        && process::lock(installed_stamps()).get(&(serial.clone(), package.clone())) == stamp.as_ref()
        && adb_output(&adb_bin, Some(&serial), &["shell", "pm", "path", &package]).await.is_some_and(|o| o.starts_with("package:"));
    if unchanged {
        ctx.log("App is unchanged since the last install; skipping install");
    } else {
        ctx.log(format!("Installing {} on {serial}…", apk.file_name().unwrap_or_default().to_string_lossy()));
        let (ok, out, err) = ctx.output({
            let mut c = adb(&adb_bin, Some(&serial));
            c.args(["install", "-r", "-t"]).arg(&apk);
            c
        }).await;
        if !ok || out.contains("Failure") {
            let text = format!("{out}{err}");
            let reason = text.lines().find(|l| l.contains("Failure") || l.contains("error")).unwrap_or(text.trim()).trim().to_owned();
            return fail(&ctx, format!("Install failed: {reason}"), explain_install(&text));
        }
        if let Some(stamp) = stamp {
            process::lock(installed_stamps()).insert((serial.clone(), package.clone()), stamp);
        }
    }

    // The launcher activity, e.g. `com.example.hello/.MainActivity`.
    let component = adb_output(&adb_bin, Some(&serial), &["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", &package])
        .await
        .and_then(|o| o.lines().last().map(str::to_owned))
        .filter(|c| c.contains('/'));
    let Some(component) = component else {
        return fail(&ctx, format!("{package} has no launcher activity"), Some("Add an activity with the MAIN action and LAUNCHER category to AndroidManifest.xml."));
    };
    ctx.log(format!("Launching {component}"));
    let _ = adb_output(&adb_bin, Some(&serial), &["shell", "am", "force-stop", &package]).await;
    let (ok, out, err) = ctx.output({
        let mut c = adb(&adb_bin, Some(&serial));
        c.args(["shell", "am", "start", "-n", &component]);
        if debug {
            c.arg("-D"); // wait for the debugger before running any app code
        }
        c
    }).await;
    if !ok || out.contains("Error") {
        return fail(&ctx, format!("Launch failed: {}{}", out.trim(), err.trim()), None);
    }

    let mut pid = None;
    for _ in 0..40 {
        pid = adb_output(&adb_bin, Some(&serial), &["shell", "pidof", &package]).await.and_then(|p| p.split_whitespace().next().and_then(|p| p.parse::<u32>().ok()));
        if pid.is_some() || ctx.cancelled() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let Some(pid) = pid else {
        return fail(&ctx, format!("{package} started but exited immediately; check Logcat for a crash"), None);
    };

    let mut forward = None;
    if let Some((program, args)) = adapter {
        // Expose the app's JDWP port on this Mac; tcp:0 lets adb pick a free port and print it.
        let port = adb_output(&adb_bin, Some(&serial), &["forward", "tcp:0", &format!("jdwp:{pid}")]).await.and_then(|p| p.parse::<u16>().ok());
        let Some(port) = port else {
            let _ = adb_output(&adb_bin, Some(&serial), &["shell", "am", "force-stop", &package]).await;
            return fail(&ctx, "Couldn't connect to the app's debug port".into(), Some("Debugging needs a debuggable build: use the debug variant."));
        };
        ctx.log(format!("Waiting for the debugger on port {port}…"));
        ctx.emit("debug-target", JvmDebugTarget { kind: "jvm", program, args, project_root: project.path.clone(), host_name: "localhost", port });
        forward = Some(port);
    }

    ctx.emit("phase", "running");
    ctx.log(format!("Running {package} (pid {pid})"));
    let result = stream_logcat(&ctx, &adb_bin, &serial, &package, pid).await;
    if let Some(port) = forward {
        let _ = adb_output(&adb_bin, Some(&serial), &["forward", "--remove", &format!("tcp:{port}")]).await;
    }
    match result {
        RunEnd::Exited { crashed: false } => JobExit { code: Some(0), cancelled: false },
        RunEnd::Exited { crashed: true } => {
            ctx.emit("diagnostics", vec![hint_diagnostic(format!("{package} crashed"), Some("See the FATAL EXCEPTION stack trace in the Console/Logcat."))]);
            JobExit::failed()
        }
        RunEnd::Disconnected => fail(&ctx, format!("Lost connection to {serial}"), Some("The device disconnected or the emulator was closed. Reconnect it and run again.")),
        RunEnd::Cancelled => {
            // Stop: close the app on the device too.
            let _ = adb_output(&adb_bin, Some(&serial), &["shell", "am", "force-stop", &package]).await;
            JobExit { code: None, cancelled: true }
        }
    }
}

/// Streams a device's whole Logcat (all apps and the system) as job `job_id`: the last 500 lines,
/// then live, as `job://<id>/logcat` events until cancelled or the device goes away.
#[tauri::command]
pub fn android_logcat(app: AppHandle, serial: String, job_id: String) -> Result<(), String> {
    process::spawn_task(&app, job_id, move |ctx| async move {
        let Some(adb_bin) = devices::adb_path().await else {
            ctx.log("error: adb isn't installed");
            return JobExit::failed();
        };
        let mut cmd = adb(&adb_bin, Some(&serial));
        cmd.args(["logcat", "-v", "threadtime", "-T", "500"]).stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null()).kill_on_drop(true);
        crate::children::own_group(&mut cmd);
        let Ok(mut child) = cmd.spawn() else { return JobExit::failed() };
        let pid = child.id();
        crate::children::track(pid);
        let Some(stdout) = child.stdout.take() else { return JobExit::failed() };
        let mut lines = BufReader::new(stdout).lines();
        let mut tick = tokio::time::interval(BATCH);
        let mut batch = LogcatBatch::new();
        let exit = loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        if let Some(l) = parse_logcat(&line) {
                            batch.push(&ctx, l);
                        }
                    }
                    _ => break JobExit { code: Some(0), cancelled: false },
                },
                _ = tick.tick() => {
                    batch.flush(&ctx);
                    if ctx.cancelled() {
                        break JobExit { code: None, cancelled: true };
                    }
                }
            }
        };
        batch.flush(&ctx);
        let _ = child.kill().await;
        crate::children::untrack(pid);
        exit
    });
    Ok(())
}

/// Builds `scheme` (module) in `configuration` (variant), installs and launches it on `device_id`.
/// With `debug`, the app waits for the debugger and a `debug-target` event says how to attach.
#[tauri::command]
pub fn android_run(app: AppHandle, root: String, scheme: String, configuration: String, device_id: String, debug: Option<bool>, job_id: String) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Gradle project found in this folder")?;
    let variant = project::variant_name(&configuration);
    process::spawn_task(&app, job_id, move |ctx| run_task(ctx, project, scheme, variant, device_id, debug.unwrap_or(false)));
    Ok(())
}
