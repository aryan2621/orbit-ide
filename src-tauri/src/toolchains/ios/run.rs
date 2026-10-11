//! Build → install → launch on a Simulator or device, streaming the app's output.
//!
//! Events on `job://<id>/…`: `log` (build log and progress), `diagnostics`, `phase`
//! (building | installing | running), `console` (the app's stdout/stderr), `exit`.

use super::{build, crash, devices, package, project, signing};
use crate::{env, process};
use process::{JobCtx, JobExit, Passthrough};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

struct AppProduct {
    path: String,
    bundle_id: String,
}

/// Finds the built .app and its bundle id from `xcodebuild -showBuildSettings`.
pub fn find_app_product(settings: &Value) -> Option<(String, String)> {
    settings.as_array()?.iter().find_map(|target| {
        let s = &target["buildSettings"];
        if s["WRAPPER_EXTENSION"].as_str() != Some("app") {
            return None;
        }
        let path = format!("{}/{}", s["TARGET_BUILD_DIR"].as_str()?, s["FULL_PRODUCT_NAME"].as_str()?);
        Some((path, s["PRODUCT_BUNDLE_IDENTIFIER"].as_str()?.to_owned()))
    })
}

async fn app_product(ctx: &JobCtx, mut settings_cmd: tokio::process::Command) -> Result<AppProduct, String> {
    settings_cmd.args(["-showBuildSettings", "-json"]);
    let (ok, stdout, stderr) = ctx.output(settings_cmd).await;
    if !ok {
        return Err(format!("Could not read build settings: {}", stderr.trim()));
    }
    let json: Value = stdout.find('[').and_then(|i| serde_json::from_str(&stdout[i..]).ok()).unwrap_or_default();
    let (path, bundle_id) = find_app_product(&json).ok_or("This scheme doesn't build an iOS app")?;
    Ok(AppProduct { path, bundle_id })
}

fn xcrun(args: &[&str]) -> tokio::process::Command {
    let mut cmd = env::command("xcrun");
    cmd.args(args);
    cmd
}

/// Runs a quick xcrun step; logs and fails the job on error.
async fn step(ctx: &JobCtx, what: &str, args: &[&str]) -> Result<(), JobExit> {
    let (ok, _, stderr) = ctx.output(xcrun(args)).await;
    if ok {
        Ok(())
    } else {
        ctx.log(format!("error: {what} failed: {}", stderr.trim()));
        Err(JobExit::failed())
    }
}

/// What the UI's debugger should attach to or launch, sent as `job://<id>/debug-target`.
#[derive(serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DebugTarget {
    /// Attach to a process already started and waiting (Simulator apps).
    Attach { pid: u32, program: String },
    /// Launch an executable under the debugger (Mac packages).
    Launch { program: String, cwd: String },
}

/// Streams the app's console; when debugging, picks the pid out of simctl's first line
/// (`com.example.app: 12345`) and announces it so the debugger can attach.
struct LaunchHooks {
    ctx: JobCtx,
    prefix: String,
    program: String,
    debug: bool,
    announced: bool,
}

impl process::JobHooks for LaunchHooks {
    fn line(&mut self, line: &str) -> Option<String> {
        if !self.announced {
            if let Some(pid) = line.trim().strip_prefix(&self.prefix).and_then(|p| p.trim().parse::<u32>().ok()) {
                self.announced = true;
                if self.debug {
                    self.ctx.emit("debug-target", DebugTarget::Attach { pid, program: self.program.clone() });
                }
                return None;
            }
        }
        Some(line.to_owned())
    }
}

async fn run_on_simulator(ctx: &JobCtx, root: &str, device: &devices::Device, app: &AppProduct, debug: bool) -> JobExit {
    let id = device.id.as_str();
    ctx.emit("phase", "installing");
    if !device.booted {
        ctx.log(format!("▸ Booting {}", device.name));
        let (ok, _, stderr) = ctx.output(xcrun(&["simctl", "boot", id])).await;
        // "Unable to boot device in current state: Booted" is fine.
        if !ok && !stderr.contains("Booted") {
            ctx.log(format!("error: Could not boot {}: {}", device.name, stderr.trim()));
            return JobExit::failed();
        }
    }
    // `boot` returns before the device can take installs; wait until it has finished booting.
    let (ok, _, stderr) = ctx.output_timeout(xcrun(&["simctl", "bootstatus", id, "-b"]), Some(Duration::from_secs(300))).await;
    if !ok {
        if ctx.cancelled() {
            return JobExit { code: None, cancelled: true };
        }
        ctx.log(format!("error: {} didn't finish booting: {}", device.name, stderr.trim()));
        return JobExit::failed();
    }
    // Bring the Simulator window up on this device, using the Simulator that belongs to the
    // selected Xcode (not whichever copy Launch Services finds first).
    let mut open = env::command("open");
    match simulator_app().await {
        Some(app) => open.arg("-a").arg(app),
        None => open.args(["-a", "Simulator"]),
    };
    open.args(["--args", "-CurrentDeviceUDID", id]);
    let _ = ctx.output_timeout(open, Some(Duration::from_secs(15))).await;

    ctx.log(format!("▸ Installing on {}", device.name));
    if let Err(e) = step(ctx, "Install", &["simctl", "install", id, &app.path]).await {
        return e;
    }

    ctx.log(format!("▸ Launching {}", app.bundle_id));
    ctx.emit("phase", "running");
    let mut args = vec!["simctl", "launch", "--console-pty", "--terminate-running-process"];
    if debug {
        // The app starts suspended until the debugger attaches and continues it.
        args.push("--wait-for-debugger");
    }
    args.extend([id, app.bundle_id.as_str()]);
    let hooks = LaunchHooks {
        ctx: ctx.clone(),
        prefix: format!("{}:", app.bundle_id),
        program: app.path.clone(),
        debug,
        announced: false,
    };
    // print() reaches the console through --console-pty; os_log / Logger messages only go to the
    // unified log, so stream those alongside.
    let exec = std::path::Path::new(&app.path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let log_stream = tokio::spawn(stream_unified_log(ctx.clone(), id.to_owned(), exec.clone()));
    let launched = std::time::SystemTime::now();
    let exit = ctx.run(xcrun(&args), "console", Arc::new(Mutex::new(hooks))).await;
    log_stream.abort();
    if exit.cancelled {
        // Stopping our console stream leaves the app running; stop it too, like Xcode.
        let _ = ctx.output(xcrun(&["simctl", "terminate", id, &app.bundle_id])).await;
    } else if !debug && crash::report(ctx, root, &exec, launched).await {
        // The debugger shows crashes itself.
        return JobExit::failed();
    }
    exit
}

/// Streams the app's unified-log messages (os_log, Logger, NSLog) from the Simulator to the console
/// as `[level] message` lines. Ends when the task is aborted (the child is killed on drop).
async fn stream_unified_log(ctx: JobCtx, udid: String, executable: String) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    if executable.is_empty() {
        return;
    }
    let predicate = format!("process == \"{}\"", executable.replace('"', ""));
    let mut cmd = xcrun(&["simctl", "spawn", &udid, "log", "stream", "--style", "compact", "--level", "debug", "--predicate", &predicate]);
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let Ok(mut child) = cmd.spawn() else { return };
    let Some(stdout) = child.stdout.take() else { return };
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(text) = format_log_line(&line) {
            ctx.emit("console", text);
        }
    }
}

/// `2026-10-11 12:00:00.123 Db MyApp[123:456] [com.x:ui] Hello` → `12:00:00.123 [Debug] [com.x:ui] Hello`.
/// Header lines ("Filtering the log data…", the column titles) are dropped.
fn format_log_line(line: &str) -> Option<String> {
    // Columns are separated by runs of spaces: date, time, type, process[pid:tid], message.
    let mut rest = line.trim_start();
    let mut cols = Vec::with_capacity(4);
    for _ in 0..4 {
        let (col, tail) = rest.split_once(' ')?;
        cols.push(col);
        rest = tail.trim_start();
    }
    if !cols[1].contains(':') || !cols[3].contains('[') {
        return None;
    }
    let level = match cols[2] {
        "E" => "Error",
        "F" => "Fault",
        "Db" => "Debug",
        "I" => "Info",
        _ => "Log",
    };
    Some(format!("{} [{level}] {rest}", cols[1]))
}

/// Simulator.app inside the active developer dir (`xcode-select -p`).
async fn simulator_app() -> Option<String> {
    let out = env::command("xcode-select").arg("-p").output().await.ok()?;
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let app = format!("{dir}/Applications/Simulator.app");
    std::path::Path::new(&app).is_dir().then_some(app)
}

/// Shows devicectl output and turns known failures (locked device, untrusted developer…) into
/// diagnostics with advice.
#[derive(Default)]
struct DeviceHooks {
    diagnostics: Vec<build::Diagnostic>,
}

impl process::JobHooks for DeviceHooks {
    fn line(&mut self, line: &str) -> Option<String> {
        if let Some(hint) = signing::explain(line) {
            if !self.diagnostics.iter().any(|d| d.hint.as_deref() == Some(hint)) {
                self.diagnostics.push(build::Diagnostic {
                    file: None,
                    line: None,
                    column: None,
                    severity: "error".into(),
                    message: line.trim().trim_start_matches("ERROR:").trim().to_owned(),
                    hint: Some(hint.to_owned()),
                });
            }
        }
        Some(line.to_owned())
    }
}

async fn run_on_device(ctx: &JobCtx, device: &devices::Device, app: &AppProduct) -> JobExit {
    let id = device.id.as_str();
    ctx.emit("phase", "installing");
    ctx.log(format!("▸ Installing on {}", device.name));
    let install = xcrun(&["devicectl", "device", "install", "app", "--device", id, &app.path]);
    let hooks = Arc::new(Mutex::new(DeviceHooks::default()));
    let exit = ctx.run(install, "log", hooks.clone()).await;
    let found = process::lock(&hooks).diagnostics.clone();
    if !found.is_empty() {
        ctx.emit("diagnostics", found);
    }
    if !exit.success() {
        return exit;
    }

    ctx.emit("phase", "running");
    ctx.log(format!("▸ Launching {}", app.bundle_id));
    let launch = xcrun(&[
        "devicectl", "device", "process", "launch", "--device", id, "--console", "--terminate-existing", &app.bundle_id,
    ]);
    // Cancelling kills devicectl, which ends the --console session and the app with it.
    ctx.run(launch, "console", Arc::new(Mutex::new(Passthrough))).await
}

#[tauri::command]
pub async fn ios_run(
    app: AppHandle,
    root: String,
    scheme: String,
    configuration: String,
    device_id: String,
    signing: Option<signing::SigningOptions>,
    debug: bool,
    job_id: String,
) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Xcode project found in this folder")?;
    if project.kind == project::ProjectKind::Package {
        process::spawn_task(&app, job_id, move |ctx| async move {
            run_package(&ctx, &project.dir(), &scheme, &configuration, debug).await
        });
        return Ok(());
    }
    let device = devices::list()
        .await
        .into_iter()
        .find(|d| d.id == device_id)
        .ok_or("That device is no longer available. Pick another one.")?;
    if debug && device.kind == devices::DeviceKind::Device {
        return Err("Debugging on a physical iPhone isn't supported yet. Debug on a Simulator instead.".into());
    }

    process::spawn_task(&app, job_id, move |ctx| async move {
        let destination = device.destination();
        let make = || build::xcodebuild_command(&project, &scheme, &configuration, &destination);

        ctx.emit("phase", "building");
        let mut build_cmd = make();
        if device.kind == devices::DeviceKind::Device {
            build_cmd.args(signing.unwrap_or_default().xcodebuild_args());
        }
        let built = build::build_step(&ctx, build_cmd).await;
        if !built.success() {
            return built;
        }

        let product = match app_product(&ctx, make()).await {
            Ok(p) => p,
            Err(e) => {
                ctx.log(format!("error: {e}"));
                return JobExit::failed();
            }
        };
        match device.kind {
            devices::DeviceKind::Simulator => run_on_simulator(&ctx, &project.dir(), &device, &product, debug).await,
            devices::DeviceKind::Device => run_on_device(&ctx, &device, &product).await,
        }
    });
    Ok(())
}

/// Swift package executables: `swift build`, then run on this Mac (or hand to the debugger).
async fn run_package(ctx: &JobCtx, dir: &str, product: &str, configuration: &str, debug: bool) -> JobExit {
    ctx.emit("phase", "building");
    let built = build::package_build_step(ctx, dir, product, configuration).await;
    if !built.success() {
        return built;
    }
    let program = match package::executable_path(dir, product, configuration).await {
        Ok(p) => p,
        Err(e) => {
            ctx.log(format!("error: {e}"));
            return JobExit::failed();
        }
    };
    if debug {
        // The UI launches it through lldb-dap; this job is done once the build is.
        ctx.emit("debug-target", DebugTarget::Launch { program, cwd: dir.to_owned() });
        return JobExit { code: Some(0), cancelled: false };
    }
    ctx.emit("phase", "running");
    ctx.log(format!("▸ Running {product}"));
    let mut cmd = tokio::process::Command::new(&program);
    cmd.current_dir(dir);
    ctx.run(cmd, "console", Arc::new(Mutex::new(Passthrough))).await
}
