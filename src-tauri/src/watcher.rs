//! Watches the open folder so the UI notices changes made outside Orbit (terminal, git, other
//! editors). Emits `fs://changed` with the changed paths, debounced.

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

type FsDebouncer = Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>;

#[derive(Default)]
pub struct Watcher(Mutex<Option<FsDebouncer>>);

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct FsChange {
    /// Changed files and folders outside ignored/build directories.
    paths: Vec<String>,
    /// Git's index or HEAD changed (staging, commits, branch switches from the terminal).
    git: bool,
}

/// Build output and caches change constantly during builds; they never matter to the UI.
const NOISY: &[&str] = &["/.build/", "/DerivedData/", "/node_modules/", "/.gradle/", "/build/", "/.cxx/", "/xcuserdata/", "/.idea/"];

pub fn classify(root: &str, paths: impl IntoIterator<Item = String>) -> FsChange {
    let mut change = FsChange::default();
    for p in paths {
        let rel = format!("/{}", p.strip_prefix(root).unwrap_or(&p).trim_start_matches('/'));
        if let Some(git_rel) = rel.strip_prefix("/.git/") {
            if git_rel == "index" || git_rel == "HEAD" || git_rel.starts_with("refs/") {
                change.git = true;
            }
            continue;
        }
        if NOISY.iter().any(|n| rel.contains(n)) || rel.ends_with(".DS_Store") {
            continue;
        }
        if !change.paths.contains(&p) {
            change.paths.push(p);
        }
    }
    change
}

/// Starts watching `root` (replacing any previous watch). Pass `None` to stop.
#[tauri::command]
pub fn watch_root(app: AppHandle, state: State<'_, Watcher>, root: Option<String>) -> Result<(), String> {
    let mut slot = crate::process::lock(&state.0);
    *slot = None; // drops the old watcher
    crate::workspace::set_root(root.as_deref());
    let Some(root) = root else { return Ok(()) };

    let root_for_events = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let change = classify(&root_for_events, events.into_iter().map(|e| e.path.to_string_lossy().into_owned()));
        if !change.paths.is_empty() || change.git {
            let _ = app.emit("fs://changed", change);
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer.watcher().watch(Path::new(&root), RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *slot = Some(debouncer);
    Ok(())
}
