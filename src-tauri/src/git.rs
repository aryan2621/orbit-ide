//! Source control via the git CLI (status, stage, commit, branches, diff base, push/pull).

use crate::{env, process};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize, Debug, PartialEq)]
pub struct FileChange {
    /// Path relative to the repo root.
    path: String,
    /// One letter: M modified, A added, D deleted, R renamed, ? untracked, U conflict.
    status: char,
    staged: bool,
}

#[derive(Serialize, Debug, Default)]
pub struct GitStatus {
    /// None when the folder isn't a git repository.
    repo_root: Option<String>,
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    has_upstream: bool,
    changes: Vec<FileChange>,
}

async fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = env::command("git").args(args).current_dir(dir).output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
    }
}

/// Parses `git status --porcelain=v2 --branch -z`.
pub fn parse_status(out: &str) -> GitStatus {
    let mut s = GitStatus::default();
    let mut fields = out.split('\0').peekable();
    while let Some(entry) = fields.next() {
        if let Some(rest) = entry.strip_prefix("# branch.head ") {
            s.branch = (rest != "(detached)").then(|| rest.to_owned());
        } else if entry.starts_with("# branch.upstream ") {
            s.has_upstream = true;
        } else if let Some(rest) = entry.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    s.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    s.behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(path) = entry.strip_prefix("? ") {
            s.changes.push(FileChange { path: path.to_owned(), status: '?', staged: false });
        } else if entry.starts_with("1 ") || entry.starts_with("2 ") || entry.starts_with("u ") {
            let parts: Vec<&str> = entry.splitn(if entry.starts_with('2') { 10 } else if entry.starts_with('u') { 11 } else { 9 }, ' ').collect();
            let xy: Vec<char> = parts.get(1).map(|x| x.chars().collect()).unwrap_or_default();
            let path = parts.last().unwrap_or(&"").to_string();
            if entry.starts_with('2') {
                fields.next(); // original path of a rename
            }
            if entry.starts_with('u') {
                s.changes.push(FileChange { path, status: 'U', staged: false });
                continue;
            }
            let (x, y) = (xy.first().copied().unwrap_or('.'), xy.get(1).copied().unwrap_or('.'));
            if x != '.' {
                s.changes.push(FileChange { path: path.clone(), status: x, staged: true });
            }
            if y != '.' {
                s.changes.push(FileChange { path, status: y, staged: false });
            }
        }
    }
    s
}

#[tauri::command]
pub async fn git_status(root: String) -> GitStatus {
    let Ok(top) = git(&root, &["rev-parse", "--show-toplevel"]).await else {
        return GitStatus::default();
    };
    let top = top.trim().to_owned();
    let mut status = git(&top, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])
        .await
        .map(|o| parse_status(&o))
        .unwrap_or_default();
    status.repo_root = Some(top);
    status
}

#[tauri::command]
pub async fn git_init(root: String) -> Result<(), String> {
    git(&root, &["init"]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_stage(repo: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(&repo, &args).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(repo: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    // `restore --staged` fails before the first commit; fall back to removing from the index.
    match git(&repo, &args).await {
        Ok(_) => Ok(()),
        Err(_) => {
            let mut rm = vec!["rm", "--cached", "-r", "--quiet", "--"];
            rm.extend(paths.iter().map(String::as_str));
            git(&repo, &rm).await.map(|_| ())
        }
    }
}

/// Throws away working-tree changes (tracked files) or deletes untracked files (to the Trash).
#[tauri::command]
pub async fn git_discard(repo: String, path: String, untracked: bool) -> Result<(), String> {
    if untracked {
        return trash::delete(std::path::Path::new(&repo).join(&path)).map_err(|e| e.to_string());
    }
    git(&repo, &["restore", "--", &path]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_commit(repo: String, message: String, all: bool) -> Result<String, String> {
    let mut args = vec!["commit", "-m", message.as_str()];
    if all {
        args.push("-a");
    }
    git(&repo, &args).await
}

/// Contents of `path` at HEAD (empty for new files), for the diff view.
#[tauri::command]
pub async fn git_head_content(repo: String, path: String) -> String {
    git(&repo, &["show", &format!("HEAD:{path}")]).await.unwrap_or_default()
}

#[derive(Serialize)]
pub struct Branches {
    current: Option<String>,
    local: Vec<String>,
}

#[tauri::command]
pub async fn git_branches(repo: String) -> Result<Branches, String> {
    let out = git(&repo, &["branch", "--format=%(HEAD)%(refname:short)"]).await?;
    let mut current = None;
    let local = out
        .lines()
        .map(|l| {
            if let Some(name) = l.strip_prefix('*') {
                current = Some(name.to_owned());
                name.to_owned()
            } else {
                l.trim_start().to_owned()
            }
        })
        .collect();
    Ok(Branches { current, local })
}

#[tauri::command]
pub async fn git_checkout(repo: String, branch: String, create: bool) -> Result<(), String> {
    let args: Vec<&str> = if create { vec!["switch", "-c", &branch] } else { vec!["switch", &branch] };
    git(&repo, &args).await.map(|_| ())
}

/// push / pull / fetch as a job so progress streams and it can be cancelled.
#[tauri::command]
pub fn git_sync(app: AppHandle, repo: String, action: String, job_id: String) -> Result<(), String> {
    let args: &[&str] = match action.as_str() {
        "push" => &["push", "--progress", "--set-upstream", "origin", "HEAD"],
        "pull" => &["pull", "--progress", "--ff-only"],
        "fetch" => &["fetch", "--progress", "--all", "--prune"],
        _ => return Err(format!("Unknown git action {action}")),
    };
    let mut cmd = env::command("git");
    cmd.args(args).current_dir(&repo).env("GIT_TERMINAL_PROMPT", "0");
    process::spawn_job(&app, job_id, cmd);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let out = [
            "# branch.oid abc",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 M. N... 100644 100644 100644 a b Sources/App.swift",
            "1 .M N... 100644 100644 100644 a b README.md",
            "1 MM N... 100644 100644 100644 a b both.swift",
            "2 R. N... 100644 100644 100644 a b R100 new name.swift",
            "old name.swift",
            "? notes.txt",
            "",
        ]
        .join("\0");
        let s = parse_status(&out);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind, s.has_upstream), (2, 1, true));
        let summary: Vec<(String, char, bool)> = s.changes.iter().map(|c| (c.path.clone(), c.status, c.staged)).collect();
        assert_eq!(
            summary,
            vec![
                ("Sources/App.swift".into(), 'M', true),
                ("README.md".into(), 'M', false),
                ("both.swift".into(), 'M', true),
                ("both.swift".into(), 'M', false),
                ("new name.swift".into(), 'R', true),
                ("notes.txt".into(), '?', false),
            ]
        );
    }
}
