use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::process::lock;

const IGNORED: &[&str] = &[
    ".git", "node_modules", ".build", "DerivedData", ".DS_Store", "xcuserdata", ".gradle", ".idea", ".cxx",
];

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// The open folder, set by `watch_root`. File-changing commands refuse paths outside it, which
/// guards against bugs (bad names, stray edits) writing somewhere unexpected.
fn root_slot() -> &'static Mutex<Option<PathBuf>> {
    static ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    ROOT.get_or_init(Default::default)
}

pub fn set_root(root: Option<&str>) {
    *lock(root_slot()) = root.map(|r| normalize(Path::new(r)));
}

/// Resolves `.` and `..` lexically (the path may not exist yet).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// Errors unless `path` is absolute and inside the open folder (when one is open).
fn check_inside(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{path}: not an absolute path"));
    }
    let p = normalize(p);
    if let Some(root) = lock(root_slot()).as_ref() {
        if !p.starts_with(root) {
            return Err(format!("{path} is outside the open folder"));
        }
    }
    Ok(p)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Lists one directory level (lazy-loaded by the file tree), folders first.
#[tauri::command]
pub async fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || {
        let mut entries: Vec<DirEntry> = fs::read_dir(&path)
            .map_err(|e| format!("{path}: {e}"))?
            .filter_map(Result::ok)
            .filter(|e| !IGNORED.contains(&e.file_name().to_string_lossy().as_ref()))
            .map(|e| DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                // .xcodeproj / .xcassets etc. are bundles; still browsable as folders.
                is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
            })
            .collect();
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(entries)
    })
    .await
}

/// Files bigger than this aren't opened in the editor (Monaco and the IPC bridge choke on them).
const MAX_OPEN_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    blocking(move || {
        let size = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?.len();
        if size > MAX_OPEN_BYTES {
            return Err(format!("{path}: file is too large to open ({} MB)", size / (1024 * 1024)));
        }
        let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
        String::from_utf8(bytes).map_err(|_| format!("{path}: binary file not supported"))
    })
    .await
}

#[tauri::command]
pub async fn write_file(path: String, contents: String) -> Result<(), String> {
    let p = check_inside(&path)?;
    blocking(move || atomic_write(&p, contents.as_bytes()).map_err(|e| format!("{path}: {e}"))).await
}

/// Writes via a temporary file in the same folder and renames it into place, so a crash or full
/// disk never leaves a half-written file. Keeps the original file's permissions.
pub fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("/"));
    fs::create_dir_all(parent)?;
    // Write through symlinks to the real file rather than replacing the link.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target.parent().unwrap_or(parent);
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.orbit-{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Creates an empty file (or a folder when `dir`), failing if it already exists.
#[tauri::command]
pub async fn create_path(path: String, dir: bool) -> Result<(), String> {
    let p = check_inside(&path)?;
    blocking(move || {
        if p.exists() {
            return Err(format!("{} already exists", p.file_name().unwrap_or_default().to_string_lossy()));
        }
        if dir {
            fs::create_dir_all(&p).map_err(|e| e.to_string())
        } else {
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&p, "").map_err(|e| e.to_string())
        }
    })
    .await
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    let from = check_inside(&from)?;
    let to_path = check_inside(&to)?;
    blocking(move || {
        if to_path.exists() {
            return Err(format!("{to} already exists"));
        }
        fs::rename(&from, &to_path).map_err(|e| e.to_string())
    })
    .await
}

/// Moves to the Trash rather than deleting, so mistakes can be undone in Finder.
#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), String> {
    let p = check_inside(&path)?;
    if lock(root_slot()).as_deref() == Some(p.as_path()) {
        return Err("Can't move the open folder itself to the Trash".into());
    }
    blocking(move || trash::delete(&p).map_err(|e| e.to_string())).await
}

/// Text files in the folder (respecting .gitignore), relative to `root`, for quick open.
#[tauri::command]
pub async fn list_files(root: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        for entry in walker(&root).build().flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if let Ok(rel) = entry.path().strip_prefix(&root) {
                    files.push(rel.to_string_lossy().into_owned());
                }
            }
            if files.len() >= 20_000 {
                break;
            }
        }
        files
    })
    .await
    .unwrap_or_default()
}

fn walker(root: &str) -> ignore::WalkBuilder {
    let mut b = ignore::WalkBuilder::new(root);
    b.hidden(true).git_ignore(true).require_git(false).filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !IGNORED.contains(&name.as_ref()) && !name.ends_with(".xcassets") && !name.ends_with(".xcodeproj") && name != "Pods" && name != "build"
    });
    b
}

#[derive(Serialize)]
pub struct SearchMatch {
    path: String,
    line: u32,
    /// 1-based column of the match start (in characters).
    column: u32,
    length: u32,
    text: String,
}

fn search_regex(query: &str, regex: bool, case_sensitive: bool) -> Result<regex::Regex, String> {
    let pattern = if regex { query.to_owned() } else { regex::escape(query) };
    regex::RegexBuilder::new(&pattern).case_insensitive(!case_sensitive).build().map_err(|e| e.to_string())
}

/// Comma-separated globs (`*.swift, src/**`) as walker overrides: `include` limits the search to
/// matching files, `exclude` drops matches.
fn glob_overrides(root: &str, include: Option<&str>, exclude: Option<&str>) -> Result<ignore::overrides::Override, String> {
    let mut b = ignore::overrides::OverrideBuilder::new(root);
    let split = |s: Option<&str>| s.unwrap_or("").split(',').map(str::trim).filter(|g| !g.is_empty()).map(str::to_owned).collect::<Vec<_>>();
    for glob in split(include) {
        b.add(&glob).map_err(|e| e.to_string())?;
    }
    for glob in split(exclude) {
        b.add(&format!("!{glob}")).map_err(|e| e.to_string())?;
    }
    b.build().map_err(|e| e.to_string())
}

/// Searches file contents under `root`. Plain text unless `regex`; returns at most 2000 matches.
#[tauri::command]
pub async fn search_text(
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    include: Option<String>,
    exclude: Option<String>,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let re = search_regex(&query, regex, case_sensitive)?;
    let globs = glob_overrides(&root, include.as_deref(), exclude.as_deref())?;
    // Each new search supersedes the previous one (the UI searches as you type).
    let generation = SEARCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let stale = move || SEARCH_GENERATION.load(Ordering::SeqCst) != generation;
    tauri::async_runtime::spawn_blocking(move || search_until(&root, &re, Some(globs), 2000, stale)).await.map_err(|e| e.to_string())
}

/// Replaces every match in `paths` (files the user ticked in the preview), writing each file
/// atomically. Open files are replaced in the editor instead, so the UI leaves them out. Regex mode
/// expands `$1`/`${name}` in `replacement`. Returns the number of replacements made.
#[tauri::command]
pub async fn replace_in_files(paths: Vec<String>, query: String, regex: bool, case_sensitive: bool, replacement: String) -> Result<u32, String> {
    let re = search_regex(&query, regex, case_sensitive)?;
    let paths = paths.iter().map(|p| check_inside(p)).collect::<Result<Vec<_>, _>>()?;
    blocking(move || {
        let mut count = 0;
        for path in paths {
            let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            // Line by line, like the search, so `^`/`$` and the counts match what the preview showed.
            let mut changed = false;
            let replaced: Vec<String> = text
                .split_inclusive('\n')
                .map(|line| {
                    let (body, end) = line.strip_suffix('\n').map_or((line, ""), |b| (b, "\n"));
                    let n = re.find_iter(body).count() as u32;
                    if n == 0 {
                        return line.to_owned();
                    }
                    count += n;
                    changed = true;
                    let out = if regex { re.replace_all(body, replacement.as_str()) } else { re.replace_all(body, regex::NoExpand(&replacement)) };
                    format!("{out}{end}")
                })
                .collect();
            if changed {
                atomic_write(&path, replaced.concat().as_bytes()).map_err(|e| format!("{}: {e}", path.display()))?;
            }
        }
        Ok(count)
    })
    .await
}

static SEARCH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Files larger than this are skipped by search (logs, generated bundles).
const MAX_SEARCH_BYTES: u64 = 2 * 1024 * 1024;


/// Searches until `limit` matches are found or `stop()` returns true.
pub fn search_until(root: &str, re: &regex::Regex, globs: Option<ignore::overrides::Override>, limit: usize, stop: impl Fn() -> bool) -> Vec<SearchMatch> {
    let mut out = Vec::new();
    let mut walk = walker(root);
    if let Some(globs) = globs {
        walk.overrides(globs);
    }
    for entry in walk.build().flatten() {
        if stop() {
            return Vec::new();
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_SEARCH_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else { continue }; // skips binary files
        for (i, line) in text.lines().enumerate() {
            if let Some(m) = re.find(line) {
                let trimmed = line.trim_start();
                out.push(SearchMatch {
                    path: entry.path().to_string_lossy().into_owned(),
                    line: i as u32 + 1,
                    column: line[..m.start()].chars().count() as u32 + 1,
                    length: m.as_str().chars().count() as u32,
                    // Show the line without indentation, capped for very long lines.
                    text: trimmed.chars().take(300).collect(),
                });
                if out.len() >= limit {
                    return out;
                }
            }
        }
    }
    out
}
