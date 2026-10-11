//! Runs XCTest / Swift Testing tests: `xcodebuild test` with a result bundle, read back with
//! `xcresulttool get test-results tests` (Xcode 16+), or `swift test --xunit-output` for packages.

use super::{build, devices, project, signing};
use crate::process::{self, JobCtx, JobExit};
use crate::toolchains::tests::{self, TestCase, TestFilter};
use crate::env;
use regex::Regex;
use serde_json::Value;
use std::path::Path;
use tauri::AppHandle;

#[tauri::command]
pub async fn ios_test(
    app: AppHandle,
    root: String,
    scheme: String,
    configuration: String,
    device_id: Option<String>,
    signing: Option<signing::SigningOptions>,
    only: Option<TestFilter>,
    job_id: String,
) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Xcode project or Swift package found in this folder")?;
    if project.kind == project::ProjectKind::Package {
        let dir = project.dir();
        process::spawn_task(&app, job_id, move |ctx| async move { package_test(&ctx, &dir, only).await });
        return Ok(());
    }
    // Tests need a concrete destination: the selected device, else the first available Simulator.
    let all = devices::list().await;
    let device = device_id
        .and_then(|id| all.iter().find(|d| d.id == id).cloned())
        .or_else(|| all.iter().find(|d| d.kind == devices::DeviceKind::Simulator && d.booted).cloned())
        .or_else(|| all.iter().find(|d| d.kind == devices::DeviceKind::Simulator).cloned())
        .ok_or("No Simulator found to run tests on. Create one in Devices: Manage Simulators & Emulators.")?;
    let bundle = std::env::temp_dir().join(format!("orbit-tests-{job_id}.xcresult"));
    let mut cmd = build::xcodebuild_command(&project, &scheme, &configuration, &device.destination());
    cmd.arg("test").arg("-resultBundlePath").arg(&bundle);
    if device.kind == devices::DeviceKind::Device {
        cmd.args(signing.unwrap_or_default().xcodebuild_args());
    }
    if let Some(only) = &only {
        let id = match &only.name {
            Some(name) => format!("{}/{name}", only.suite),
            None => only.suite.clone(),
        };
        cmd.arg(format!("-only-testing:{id}"));
    }
    process::spawn_task(&app, job_id, move |ctx| async move {
        let _ = std::fs::remove_dir_all(&bundle);
        ctx.log(format!("Testing {scheme} on {}", device.name));
        let exit = build::run_build(&ctx, cmd, false).await;
        if !exit.cancelled {
            let mut get = env::command("xcrun");
            get.args(["xcresulttool", "get", "test-results", "tests", "--path"]).arg(&bundle);
            let (ok, out, err) = ctx.output(get).await;
            if ok {
                let json: Value = serde_json::from_str(&out).unwrap_or_default();
                let mut cases = Vec::new();
                collect(&json["testNodes"], None, None, &mut cases);
                locate(Path::new(&root), &mut cases);
                ctx.emit("tests", cases);
            } else if bundle.exists() {
                ctx.log(format!("Couldn't read the test results (Xcode 16 or later is needed): {}", err.trim()));
            }
        }
        let _ = std::fs::remove_dir_all(&bundle);
        exit
    });
    Ok(())
}

/// Walks the xcresult test tree: bundles (targets) → suites (classes) → test cases.
fn collect(nodes: &Value, target: Option<&str>, suite: Option<&str>, out: &mut Vec<TestCase>) {
    for node in nodes.as_array().into_iter().flatten() {
        let name = node["name"].as_str().unwrap_or_default();
        match node["nodeType"].as_str().unwrap_or_default() {
            "Unit test bundle" | "UI test bundle" => collect(&node["children"], Some(name), None, out),
            "Test Suite" => collect(&node["children"], target, Some(name), out),
            "Test Case" => {
                let suite = suite.unwrap_or_default();
                let status = match node["result"].as_str().unwrap_or_default() {
                    "Passed" | "Expected Failure" => "passed",
                    "Failed" => "failed",
                    _ => "skipped",
                };
                let failures: Vec<&str> = node["children"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| c["nodeType"] == "Failure Message")
                    .filter_map(|c| c["name"].as_str())
                    .collect();
                out.push(TestCase {
                    suite_id: target.map_or_else(|| suite.to_owned(), |t| format!("{t}/{suite}")),
                    suite: suite.to_owned(),
                    name: name.trim_end_matches("()").to_owned(),
                    status,
                    duration: duration(node),
                    message: (!failures.is_empty()).then(|| failures.join("\n")),
                    ..Default::default()
                });
            }
            _ => collect(&node["children"], target, suite, out),
        }
    }
}

/// `durationInSeconds`, or the `duration` text ("0.0012s", "1,5s").
fn duration(node: &Value) -> f64 {
    node["durationInSeconds"].as_f64().unwrap_or_else(|| {
        node["duration"].as_str().unwrap_or_default().trim_end_matches('s').replace(',', ".").parse().unwrap_or(0.0)
    })
}

/// Points each case at its source: the failure's `File.swift:12:` when there is one, else the
/// test method in `<Suite>.swift`.
fn locate(root: &Path, cases: &mut [TestCase]) {
    let Ok(at) = Regex::new(r"^([\w+\-. ]+\.swift):(\d+):") else { return };
    for case in cases {
        if let Some(c) = case.message.as_deref().and_then(|m| at.captures(m)) {
            if let Some(path) = tests::find_file(root, &c[1]) {
                case.file = Some(path.to_string_lossy().into_owned());
                case.line = c[2].parse().ok();
                continue;
            }
        }
        if let Some(path) = tests::find_file(root, &format!("{}.swift", case.suite)) {
            case.line = tests::method_line(&path, &case.name);
            case.file = Some(path.to_string_lossy().into_owned());
        }
    }
}

/// `swift test` for a package, results from its xUnit (JUnit) output.
async fn package_test(ctx: &JobCtx, dir: &str, only: Option<TestFilter>) -> JobExit {
    let xml = std::env::temp_dir().join(format!("orbit-tests-{}.xml", ctx.id));
    let mut cmd = env::command("swift");
    cmd.args(["test", "--xunit-output"]).arg(&xml).current_dir(dir);
    if let Some(only) = &only {
        // XCTest ids in packages are `Module.Class/method`; --filter takes a regex over them.
        let id = only.name.as_ref().map_or_else(|| only.suite.clone(), |n| format!("{}/{n}", only.suite));
        cmd.args(["--filter", &regex::escape(&id)]);
    }
    let exit = build::run_build(ctx, cmd, true).await;
    if let Ok(text) = std::fs::read_to_string(&xml) {
        let mut cases = tests::parse_junit(&text);
        locate(Path::new(dir), &mut cases);
        ctx.emit("tests", cases);
    }
    let _ = std::fs::remove_file(&xml);
    exit
}
