//! Simulator crash reports: after the app exits on its own, finds the `.ips` report macOS writes
//! to ~/Library/Logs/DiagnosticReports and shows the exception and the crashing thread's top
//! frames in the Console and Problems.

use super::build::Diagnostic;
use crate::process::JobCtx;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const TOP_FRAMES: usize = 12;

fn reports_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Logs/DiagnosticReports"))
}

/// `.ips` files are a one-line JSON header followed by the JSON report.
fn parse(text: &str) -> Option<(Value, Value)> {
    let (header, body) = text.split_once('\n')?;
    Some((serde_json::from_str(header).ok()?, serde_json::from_str(body).ok()?))
}

/// Reports for `executable` modified at or after `since`, newest first.
fn find(executable: &str, since: SystemTime) -> Option<(PathBuf, Value)> {
    let mut found: Vec<(SystemTime, PathBuf, Value)> = std::fs::read_dir(reports_dir()?)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_string_lossy().into_owned();
            // Files are named `<process>-<date>.ips`; skip other processes without reading them.
            if !name.ends_with(".ips") || !name.starts_with(executable) {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            if modified < since {
                return None;
            }
            let (header, body) = parse(&std::fs::read_to_string(&path).ok()?)?;
            let proc_name = body["procName"].as_str().or(header["app_name"].as_str()).or(header["name"].as_str())?;
            (proc_name == executable).then_some((modified, path, body))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().next().map(|(_, p, b)| (p, b))
}

struct Frame {
    text: String,
    /// (file name, line) when the report is symbolicated with source locations.
    source: Option<(String, u32)>,
    in_app: bool,
}

fn frames(body: &Value) -> Vec<Frame> {
    let images = body["usedImages"].as_array().cloned().unwrap_or_default();
    let image_name = |i: &Value| i.as_u64().and_then(|i| images.get(i as usize)).and_then(|img| img["name"].as_str()).unwrap_or("???").to_owned();
    let main_image = body["procName"].as_str().unwrap_or_default().to_owned();
    let threads = body["threads"].as_array().cloned().unwrap_or_default();
    let thread = threads
        .iter()
        .find(|t| t["triggered"].as_bool() == Some(true))
        .or_else(|| body["faultingThread"].as_u64().and_then(|i| threads.get(i as usize)))
        .cloned()
        .unwrap_or_default();
    thread["frames"]
        .as_array()
        .map(|fs| {
            fs.iter()
                .take(TOP_FRAMES)
                .enumerate()
                .map(|(n, f)| {
                    let image = image_name(&f["imageIndex"]);
                    let symbol = f["symbol"].as_str().map(str::to_owned).unwrap_or_else(|| format!("0x{:x}", f["imageOffset"].as_u64().unwrap_or(0)));
                    let source = f["sourceFile"].as_str().zip(f["sourceLine"].as_u64()).map(|(file, line)| (file.to_owned(), line as u32));
                    let location = source.as_ref().map(|(file, line)| format!(" ({file}:{line})")).unwrap_or_default();
                    Frame { text: format!("{n:<3}{image:<28} {symbol}{location}"), source, in_app: image == main_image }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `EXC_BAD_ACCESS (SIGSEGV) · KERN_INVALID_ADDRESS at 0x0` plus any "Fatal error: …" message.
fn summary(body: &Value) -> String {
    let e = &body["exception"];
    let mut s = e["type"].as_str().unwrap_or("Crash").to_owned();
    if let Some(signal) = e["signal"].as_str() {
        s.push_str(&format!(" ({signal})"));
    }
    if let Some(sub) = e["subtype"].as_str() {
        s.push_str(&format!(" · {sub}"));
    }
    // Swift runtime errors ("Fatal error: Index out of range") are in the application-specific info.
    if let Some(asi) = body["asi"].as_object() {
        if let Some(msg) = asi.values().flat_map(|v| v.as_array().cloned().unwrap_or_default()).filter_map(|m| m.as_str().map(str::to_owned)).find(|m| !m.trim().is_empty()) {
            s.push_str(&format!("\n{}", msg.trim()));
        }
    } else if let Some(indicator) = body["termination"]["indicator"].as_str() {
        s.push_str(&format!("\n{indicator}"));
    }
    s
}

/// Waits briefly for a crash report from `executable` (written a moment after the crash) and
/// reports it. Returns true when one was found.
pub async fn report(ctx: &JobCtx, root: &str, executable: &str, launched: SystemTime) -> bool {
    if executable.is_empty() {
        return false;
    }
    let mut found = None;
    for _ in 0..8 {
        let (exe, since) = (executable.to_owned(), launched);
        if let Ok(Some(r)) = tokio::task::spawn_blocking(move || find(&exe, since)).await {
            found = Some(r);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let Some((path, body)) = found else { return false };

    let summary = summary(&body);
    let frames = frames(&body);
    ctx.emit("console", format!("💥 {executable} crashed: {summary}"));
    for f in &frames {
        ctx.emit("console", format!("    {}", f.text));
    }
    ctx.emit("console", format!("    Full report: {}", path.display()));

    // Point Problems at the first frame in the app's own code that has a source location.
    let location = frames.iter().filter(|f| f.in_app).find_map(|f| f.source.clone());
    let file = location.as_ref().and_then(|(name, _)| crate::toolchains::tests::find_file(Path::new(root), name));
    let trace: Vec<String> = frames.iter().map(|f| f.text.clone()).collect();
    ctx.emit(
        "diagnostics",
        vec![Diagnostic {
            file: file.map(|p| p.to_string_lossy().into_owned()),
            line: location.map(|(_, l)| l),
            column: None,
            severity: "error".into(),
            message: format!("{executable} crashed: {summary}\n\n{}", trace.join("\n")),
            hint: Some(format!("Crash report: {}", path.display())),
        }],
    );
    true
}
