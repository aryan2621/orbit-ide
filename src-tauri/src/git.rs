//! Source control via the git CLI (status, stage, commit, branches, diff base, push/pull).

use crate::{env, process};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize, Debug, PartialEq)]
pub struct FileChange {
    /// Path relative to the repo root.
    path: String,
    /// One letter: M modified, A added, D deleted, R renamed, ? untracked, U conflict (shown as "C").
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
    inside_repo(&repo, &path)?;
    if untracked {
        return trash::delete(std::path::Path::new(&repo).join(&path)).map_err(|e| e.to_string());
    }
    git(&repo, &["restore", "--", &path]).await.map(|_| ())
}

/// Refuses repo-relative paths that point outside the repo (absolute, `..`, or through a symlink).
fn inside_repo(repo: &str, path: &str) -> Result<(), String> {
    use std::path::{Component, Path};
    let rel = Path::new(path);
    let escapes = rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir));
    let outside = || format!("{path} is outside the repository");
    if path.is_empty() || escapes {
        return Err(outside());
    }
    let repo = std::fs::canonicalize(repo).map_err(|e| e.to_string())?;
    // The file itself may be gone (a deleted file being restored); check its nearest existing parent.
    let mut probe = repo.join(rel);
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p.to_path_buf(),
            None => return Err(outside()),
        }
    }
    let real = std::fs::canonicalize(&probe).map_err(|e| e.to_string())?;
    if real.starts_with(&repo) { Ok(()) } else { Err(outside()) }
}

#[tauri::command]
pub async fn git_commit(repo: String, message: String, all: bool, amend: Option<bool>) -> Result<String, String> {
    let mut args = vec!["commit", "-m", message.as_str()];
    if all {
        args.push("-a");
    }
    if amend == Some(true) {
        args.push("--amend");
    }
    git(&repo, &args).await
}

/// Contents of `path` at HEAD (empty for new files), for the diff view.
#[tauri::command]
pub async fn git_head_content(repo: String, path: String) -> String {
    git(&repo, &["show", &format!("HEAD:{path}")]).await.unwrap_or_default()
}

/// Contents of `path` at `rev`: a commit, `HEAD`, or `:` for the staged version (empty if absent).
#[tauri::command]
pub async fn git_file_at(repo: String, rev: String, path: String) -> Result<String, String> {
    inside_repo(&repo, &path)?;
    if rev.starts_with('-') {
        return Err("Invalid revision".into());
    }
    let spec = if rev == ":" { format!(":{path}") } else { format!("{rev}:{path}") };
    Ok(git(&repo, &["show", &spec]).await.unwrap_or_default())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Commit {
    hash: String,
    short: String,
    author: String,
    /// Relative, e.g. "3 days ago".
    date: String,
    subject: String,
}

/// Recent commits (of `path` when given, following renames).
#[tauri::command]
pub async fn git_log(repo: String, path: Option<String>, limit: Option<u32>) -> Result<Vec<Commit>, String> {
    let n = format!("-n{}", limit.unwrap_or(200));
    let mut args = vec!["log", "--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e", n.as_str()];
    if let Some(p) = path.as_deref() {
        inside_repo(&repo, p)?;
        args.extend(["--follow", "--", p]);
    }
    let out = git(&repo, &args).await?;
    Ok(parse_log(&out))
}

pub fn parse_log(out: &str) -> Vec<Commit> {
    out.split('\x1e')
        .filter_map(|record| {
            let mut f = record.trim_start_matches('\n').split('\x1f');
            Some(Commit {
                hash: f.next().filter(|h| !h.is_empty())?.to_owned(),
                short: f.next()?.to_owned(),
                author: f.next()?.to_owned(),
                date: f.next()?.to_owned(),
                subject: f.next().unwrap_or_default().trim_end().to_owned(),
            })
        })
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CommitFile {
    status: char,
    path: String,
}

/// Files a commit changed (`git show --name-status`).
#[tauri::command]
pub async fn git_commit_files(repo: String, hash: String) -> Result<Vec<CommitFile>, String> {
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid commit".into());
    }
    let out = git(&repo, &["show", "--name-status", "--format=", "-M", &hash]).await?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let status = parts.next()?.chars().next()?;
            // Renames list old then new; show the new path.
            let path = parts.last()?.to_owned();
            Some(CommitFile { status, path })
        })
        .collect())
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct BlameLine {
    short: String,
    author: String,
    /// Unix seconds.
    time: i64,
    summary: String,
    /// Not committed yet.
    uncommitted: bool,
}

/// Who last changed each line of `path` (index 0 = line 1), from `git blame --porcelain`.
#[tauri::command]
pub async fn git_blame(repo: String, path: String) -> Result<Vec<BlameLine>, String> {
    inside_repo(&repo, &path)?;
    let out = git(&repo, &["blame", "--porcelain", "--", &path]).await?;
    Ok(parse_blame(&out))
}

pub fn parse_blame(out: &str) -> Vec<BlameLine> {
    let mut commits: std::collections::HashMap<String, BlameLine> = Default::default();
    let mut lines = Vec::new();
    let mut current: Option<String> = None;
    for l in out.lines() {
        if l.starts_with('\t') {
            if let Some(hash) = current.take() {
                lines.push(commits.get(&hash).cloned().unwrap_or_default());
            }
            continue;
        }
        let mut words = l.split(' ');
        let first = words.next().unwrap_or_default();
        if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            commits.entry(first.to_owned()).or_insert_with(|| BlameLine {
                short: first[..8].to_owned(),
                uncommitted: first.chars().all(|c| c == '0'),
                ..Default::default()
            });
            current = Some(first.to_owned());
        } else if let Some(hash) = current.as_ref() {
            let rest = l.split_once(' ').map_or("", |(_, r)| r);
            if let Some(entry) = commits.get_mut(hash) {
                match first {
                    "author" => entry.author = rest.to_owned(),
                    "author-time" => entry.time = rest.parse().unwrap_or(0),
                    "summary" => entry.summary = rest.to_owned(),
                    _ => {}
                }
            }
        }
    }
    lines
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Stash {
    index: u32,
    message: String,
}

/// `save` (with an optional message, including untracked files), `pop`/`drop` (by index), or `list`.
#[tauri::command]
pub async fn git_stash(repo: String, action: String, index: Option<u32>, message: Option<String>) -> Result<Vec<Stash>, String> {
    let entry = format!("stash@{{{}}}", index.unwrap_or(0));
    match action.as_str() {
        "save" => {
            let mut args = vec!["stash", "push", "--include-untracked"];
            if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
                args.extend(["-m", m]);
            }
            git(&repo, &args).await?;
        }
        "pop" => {
            git(&repo, &["stash", "pop", &entry]).await?;
        }
        "drop" => {
            git(&repo, &["stash", "drop", &entry]).await?;
        }
        "list" => {}
        _ => return Err(format!("Unknown stash action {action}")),
    }
    let out = git(&repo, &["stash", "list", "--format=%gs"]).await.unwrap_or_default();
    Ok(out.lines().enumerate().map(|(i, m)| Stash { index: i as u32, message: m.to_owned() }).collect())
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
    if branch.starts_with('-') || branch.trim().is_empty() {
        return Err(format!("\"{branch}\" is not a valid branch name"));
    }
    let args: Vec<&str> = if create { vec!["switch", "-c", &branch] } else { vec!["switch", &branch] };
    git(&repo, &args).await.map(|_| ())
}

/// push / pull / fetch as a job so progress streams and it can be cancelled. Push and pull use the
/// branch's tracking remote; without one, push sets it (to `origin`, or the only remote).
#[tauri::command]
pub async fn git_sync(app: AppHandle, repo: String, action: String, job_id: String) -> Result<(), String> {
    let has_upstream = git(&repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.is_ok();
    let remote = if has_upstream || action == "fetch" { None } else { Some(default_remote(&repo).await?) };
    let branch = git(&repo, &["branch", "--show-current"]).await.unwrap_or_default().trim().to_owned();
    let args: Vec<&str> = match (action.as_str(), remote.as_deref()) {
        ("push", None) => vec!["push", "--progress"],
        ("push", Some(remote)) => vec!["push", "--progress", "--set-upstream", remote, "HEAD"],
        ("pull", None) => vec!["pull", "--progress", "--ff-only"],
        ("pull", Some(_)) if branch.is_empty() => return Err("Check out a branch before pulling.".into()),
        ("pull", Some(remote)) => vec!["pull", "--progress", "--ff-only", remote, &branch],
        ("fetch", _) => vec!["fetch", "--progress", "--all", "--prune"],
        _ => return Err(format!("Unknown git action {action}")),
    };
    let mut cmd = env::command("git");
    cmd.args(args).current_dir(&repo).env("GIT_TERMINAL_PROMPT", "0");
    process::spawn_job(&app, job_id, cmd);
    Ok(())
}

/// `origin` if it exists, else the only remote.
async fn default_remote(repo: &str) -> Result<String, String> {
    let remotes: Vec<String> = git(repo, &["remote"]).await?.lines().map(str::to_owned).collect();
    if remotes.iter().any(|r| r == "origin") {
        return Ok("origin".into());
    }
    match remotes.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err("This repository has no remote. Add one with `git remote add origin <url>` in the Terminal.".into()),
        _ => Err("This branch has no upstream and there's no `origin` remote. Set one with `git push -u <remote> HEAD` in the Terminal.".into()),
    }
}
