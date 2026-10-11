//! Test results shared by the iOS and Android test runners: one flat list of test cases, sent as
//! `job://<id>/tests` when the run ends. JUnit XML (Gradle, `swift test --xunit-output`) is parsed
//! here; xcresult JSON in `ios::test`.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TestCase {
    /// What to pass back to run just this test's class: `Target/Class` (iOS), `pkg.Class` (Android).
    pub suite_id: String,
    /// The class name as shown.
    pub suite: String,
    /// Method name, without `()`.
    pub name: String,
    /// "passed", "failed" or "skipped".
    pub status: &'static str,
    /// Seconds.
    pub duration: f64,
    pub message: Option<String>,
    pub file: Option<String>,
    pub line: Option<u32>,
}

/// A single class or test to run instead of everything.
#[derive(Deserialize, Clone, Debug)]
pub struct TestFilter {
    pub suite: String,
    pub name: Option<String>,
}

/// A lazily compiled constant pattern (`None` only if the pattern were invalid).
fn re(cell: &'static OnceLock<Option<Regex>>, pattern: &str) -> Option<&'static Regex> {
    cell.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

fn attrs(tag: &str) -> HashMap<String, String> {
    static ATTR: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(attr) = re(&ATTR, r#"([\w:-]+)\s*=\s*"([^"]*)""#) else { return HashMap::new() };
    attr.captures_iter(tag).map(|c| (c[1].to_owned(), unescape(&c[2]))).collect()
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#10;", "\n").replace("&amp;", "&")
}

/// `<testcase classname=".." name=".." time="..">` with optional `<failure>`/`<error>`/`<skipped>`.
pub fn parse_junit(xml: &str) -> Vec<TestCase> {
    static CASE: OnceLock<Option<Regex>> = OnceLock::new();
    static FAILURE: OnceLock<Option<Regex>> = OnceLock::new();
    let (Some(case_re), Some(failure_re)) = (
        re(&CASE, r"(?s)<testcase\b([^>]*?)(?:/>|>(.*?)</testcase>)"),
        re(&FAILURE, r"(?s)<(failure|error)\b([^>]*?)(?:/>|>(.*?)</(?:failure|error)>)"),
    ) else {
        return Vec::new();
    };
    case_re
        .captures_iter(xml)
        .map(|c| {
            let a = attrs(&c[1]);
            let body = c.get(2).map_or("", |m| m.as_str());
            let class = a.get("classname").cloned().unwrap_or_default();
            let failure = failure_re.captures(body);
            let status = if failure.is_some() {
                "failed"
            } else if body.contains("<skipped") {
                "skipped"
            } else {
                "passed"
            };
            let message = failure.map(|f| {
                let attr_message = attrs(&f[2]).remove("message").unwrap_or_default();
                let text = f.get(3).map(|m| unescape(m.as_str().trim())).unwrap_or_default();
                if text.is_empty() { attr_message } else { text }
            });
            TestCase {
                suite: class.rsplit(['.', '/']).next().unwrap_or(&class).to_owned(),
                suite_id: class,
                name: a.get("name").map(|n| n.trim_end_matches("()").to_owned()).unwrap_or_default(),
                status,
                duration: a.get("time").and_then(|t| t.parse().ok()).unwrap_or(0.0),
                message,
                ..Default::default()
            }
        })
        .collect()
}

/// The line declaring test `name` in `path` (`func name`, `fun name`, `void name`, or `` fun `name` ``).
pub fn method_line(path: &Path, name: &str) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    let escaped = regex::escape(name);
    let decl = Regex::new(&format!(r"\b(?:func|fun|void)\s+`?{escaped}`?\s*\(")).ok()?;
    text.lines().position(|l| decl.is_match(l)).map(|i| i as u32 + 1)
}

/// Finds a file named `file_name` under `root`, skipping build output and dependencies.
pub fn find_file(root: &Path, file_name: &str) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                let skip = name.starts_with('.') || matches!(name.as_ref(), "build" | "DerivedData" | "Pods" | "node_modules" | "Carthage");
                if !skip && depth < 10 {
                    stack.push((path, depth + 1));
                }
            } else if name == file_name {
                return Some(path);
            }
        }
    }
    None
}

/// XML files written by this run (`since`), under `dir`, recursively.
pub fn junit_files(dir: &Path, since: std::time::SystemTime) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "xml")
                && entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t >= since)
            {
                out.push(path);
            }
        }
    }
    out
}
