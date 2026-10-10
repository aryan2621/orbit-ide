use serde::Serialize;
use std::fs;
use std::path::Path;

const IGNORED: &[&str] = &[".git", "node_modules", ".build", "DerivedData", ".DS_Store", "xcuserdata"];

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Lists one directory level (lazy-loaded by the file tree), folders first.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
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
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{path}: binary file not supported"))
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// Creates an empty file (or a folder when `dir`), failing if it already exists.
#[tauri::command]
pub fn create_path(path: String, dir: bool) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("{} already exists", p.file_name().unwrap_or_default().to_string_lossy()));
    }
    if dir {
        fs::create_dir_all(p).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(p, "").map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("{to} already exists"));
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Moves to the Trash rather than deleting, so mistakes can be undone in Finder.
#[tauri::command]
pub fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
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

/// Searches file contents under `root`. Plain text unless `regex`; returns at most 2000 matches.
#[tauri::command]
pub async fn search_text(root: String, query: String, regex: bool, case_sensitive: bool) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let pattern = if regex { query } else { regex::escape(&query) };
    let re = regex::RegexBuilder::new(&pattern).case_insensitive(!case_sensitive).build().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || search(&root, &re, 2000)).await.map_err(|e| e.to_string())
}

pub fn search(root: &str, re: &regex::Regex, limit: usize) -> Vec<SearchMatch> {
    let mut out = Vec::new();
    for entry in walker(root).build().flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searches_and_respects_ignores() {
        let dir = std::env::temp_dir().join(format!("orbit-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".build")).unwrap();
        fs::write(dir.join("a.swift"), "let x = 1\n    print(Greeter())\n").unwrap();
        fs::write(dir.join(".build/b.swift"), "Greeter").unwrap();
        let re = regex::RegexBuilder::new("greeter").case_insensitive(true).build().unwrap();
        let found = search(dir.to_str().unwrap(), &re, 10);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].line, found[0].column, found[0].length), (2, 11, 7));
        assert_eq!(found[0].text, "print(Greeter())");
        let _ = fs::remove_dir_all(dir);
    }
}
