//! Runs JVM unit tests (`test<Variant>UnitTest`) or instrumented tests on a device
//! (`connected<Variant>AndroidTest`), then reads Gradle's JUnit XML results.

use super::build::run_gradle;
use super::project::{self, android_find_source};
use super::sdk;
use crate::process;
use crate::toolchains::tests::{self, TestCase, TestFilter};
use regex::Regex;
use std::path::Path;
use tauri::AppHandle;

#[tauri::command]
pub fn android_test(
    app: AppHandle,
    root: String,
    scheme: String,
    configuration: String,
    instrumented: bool,
    device_id: Option<String>,
    only: Option<TestFilter>,
    job_id: String,
) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Gradle project found in this folder")?;
    let variant = project::variant_name(&configuration);
    if instrumented && device_id.is_none() {
        return Err("Instrumented tests run on a device: choose an emulator or phone first.".into());
    }
    process::spawn_task(&app, job_id, move |ctx| async move {
        let started = std::time::SystemTime::now();
        let shell = sdk::shell_env().await;
        let mut cmd = project::gradlew(&project, &shell).await;
        let task = if instrumented {
            project::task(&scheme, "connected", &format!("{variant}AndroidTest"))
        } else {
            project::task(&scheme, "test", &format!("{variant}UnitTest"))
        };
        cmd.arg(&task);
        if let Some(only) = &only {
            if instrumented {
                let target = only.name.as_ref().map_or_else(|| only.suite.clone(), |n| format!("{}#{n}", only.suite));
                cmd.arg(format!("-Pandroid.testInstrumentationRunnerArguments.class={target}"));
            } else {
                let target = only.name.as_ref().map_or_else(|| only.suite.clone(), |n| format!("{}.{n}", only.suite));
                cmd.args(["--tests", &target]);
            }
        }
        if let Some(serial) = device_id.as_deref().filter(|_| instrumented) {
            cmd.env("ANDROID_SERIAL", serial);
        }
        ctx.log(format!("$ ./gradlew {task}"));
        let exit = run_gradle(&ctx, cmd).await;
        if exit.cancelled {
            return exit;
        }
        let module = project.dir().join(scheme.trim_start_matches(':').replace(':', "/"));
        let results = if instrumented { module.join("build/outputs/androidTest-results") } else { module.join("build/test-results") };
        let mut cases: Vec<TestCase> = tests::junit_files(&results, started)
            .iter()
            .filter_map(|f| std::fs::read_to_string(f).ok())
            .flat_map(|xml| tests::parse_junit(&xml))
            .collect();
        locate(&root, &mut cases);
        if cases.is_empty() && exit.success() {
            ctx.log("No tests ran. Add tests under src/test (unit) or src/androidTest (instrumented).");
        }
        ctx.emit("tests", cases);
        exit
    });
    Ok(())
}

/// Points each case at its source: the first stack frame in the test class for failures, else the
/// test method in the class's file.
fn locate(root: &str, cases: &mut [TestCase]) {
    let Ok(frame) = Regex::new(r"at ([\w$.]+)\.[\w$<>]+\(([\w$]+\.(?:kt|java)):(\d+)\)") else { return };
    for case in cases {
        let outer = case.suite_id.split('$').next().unwrap_or(&case.suite_id).to_owned();
        let in_test = case.message.as_deref().and_then(|m| frame.captures_iter(m).find(|c| c[1].starts_with(&outer)));
        if let Some(c) = in_test {
            if let Some(path) = android_find_source(root.to_owned(), c[1].split('$').next().unwrap_or(&c[1]).to_owned(), c[2].to_owned()) {
                case.file = Some(path);
                case.line = c[3].parse().ok();
                continue;
            }
        }
        let simple = outer.rsplit('.').next().unwrap_or(&outer).to_owned();
        let found = ["kt", "java"].iter().find_map(|ext| android_find_source(root.to_owned(), outer.clone(), format!("{simple}.{ext}")));
        if let Some(path) = found {
            case.line = tests::method_line(Path::new(&path), &case.name);
            case.file = Some(path);
        }
    }
}
