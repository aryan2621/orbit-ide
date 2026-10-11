//! Runs the bundled `llama-server` on demand: one model at a time on a free 127.0.0.1 port with a
//! random API key (so other local apps can't use it), unloaded after a few idle minutes, restarted
//! after a crash at most 3 times a minute.

use super::{models, AiError};
use crate::children;
use crate::process::lock;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

const MAX_RESTARTS_PER_MINUTE: usize = 3;
const LOAD_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone)]
pub struct Endpoint {
    pub base: String,
    pub key: String,
}

struct Running {
    pid: Option<u32>,
    model: String,
    ctx: u32,
    endpoint: Endpoint,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    /// "stopped" | "loading" | "ready" | "crashed"
    status: &'static str,
    last_used: Option<Instant>,
    idle_minutes: u64,
    crashes: VecDeque<Instant>,
    /// The last lines of the server's stderr, to explain failures.
    stderr: VecDeque<String>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State { status: "stopped", idle_minutes: 10, ..Default::default() }))
}

/// Serializes starts so two requests don't launch two servers.
fn start_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(Default::default)
}

pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().no_proxy().build().unwrap_or_default())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub status: &'static str,
    pub model: Option<String>,
    pub ctx: Option<u32>,
}

fn snapshot(s: &State) -> Status {
    Status { status: s.status, model: s.running.as_ref().map(|r| r.model.clone()), ctx: s.running.as_ref().map(|r| r.ctx) }
}

fn set_status(app: &AppHandle, status: &'static str) {
    let snap = {
        let mut s = lock(state());
        s.status = status;
        snapshot(&s)
    };
    let _ = app.emit("ai://status", snap);
}

#[tauri::command]
pub fn ai_status() -> Status {
    snapshot(&lock(state()))
}

/// The sidecar next to Orbit's executable (Tauri strips the target triple when bundling).
fn binary() -> Result<PathBuf, AiError> {
    let exe = std::env::current_exe().map_err(|e| AiError::new("SERVER", e.to_string()))?;
    let dir = exe.parent().ok_or_else(|| AiError::new("SERVER", "No executable folder"))?;
    [dir.join("llama-server"), dir.join("llama-server-aarch64-apple-darwin")]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| AiError::new("SERVER", "The AI engine (llama-server) is missing from this build of Orbit"))
}

fn free_port() -> Result<u16, AiError> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| AiError::new("SERVER", e.to_string()))?;
    l.local_addr().map(|a| a.port()).map_err(|e| AiError::new("SERVER", e.to_string()))
}

fn random_key() -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(format!("{:?}{}{:?}", Instant::now(), std::process::id(), std::time::SystemTime::now()));
    let mut buf = [0u8; 32];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    h.update(buf);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Maps the server's last stderr lines to a typed error.
fn classify(stderr: &VecDeque<String>, fallback: &str) -> AiError {
    let text = stderr.iter().cloned().collect::<Vec<_>>().join("\n");
    let lower = text.to_lowercase();
    let tail: String = stderr.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join("\n");
    if lower.contains("out of memory") || lower.contains("failed to allocate") || lower.contains("insufficient memory") || lower.contains("kiogpucommandbuffercallbackerroroutofmemory") {
        AiError::new("OUT_OF_MEMORY", "The model doesn't fit in memory. Choose a smaller model or a smaller context size.")
    } else if lower.contains("context") && (lower.contains("exceed") || lower.contains("too small") || lower.contains("too large")) {
        AiError::new("CONTEXT_TOO_SMALL", "The conversation doesn't fit in the context size. Start a new chat or raise the context size.")
    } else if tail.is_empty() {
        AiError::new("CRASHED", fallback.to_owned())
    } else {
        AiError::new("CRASHED", format!("{fallback}\n{tail}"))
    }
}

/// Returns the endpoint for `model` with `ctx`, starting or restarting the server as needed.
pub async fn ensure(app: &AppHandle, model: &str, ctx: u32) -> Result<Endpoint, AiError> {
    if !super::hardware::apple_silicon() {
        return Err(AiError::new("UNSUPPORTED", "The built-in AI needs an Apple Silicon Mac"));
    }
    let _guard = start_lock().lock().await;
    {
        let mut s = lock(state());
        s.last_used = Some(Instant::now());
        if let Some(r) = &s.running {
            if r.model == model && r.ctx == ctx {
                return Ok(r.endpoint.clone());
            }
        }
    }
    stop(app).await;

    let path = models::model_path(model).ok_or_else(|| AiError::new("NO_MODEL", "Download a model in Settings → AI first"))?;
    {
        let mut s = lock(state());
        let now = Instant::now();
        while s.crashes.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            s.crashes.pop_front();
        }
        if s.crashes.len() >= MAX_RESTARTS_PER_MINUTE {
            drop(s);
            set_status(app, "crashed");
            return Err(AiError::new("CRASHED", "The AI engine keeps crashing. Try a smaller model or context size, then try again in a minute."));
        }
        s.stderr.clear();
    }
    let port = free_port()?;
    let key = random_key();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let mut cmd = tokio::process::Command::new(binary()?);
    cmd.arg("--model")
        .arg(&path)
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .args(["-c", &ctx.to_string(), "-ngl", "99", "--jinja", "--threads", &threads.to_string()])
        .args(["--parallel", "1", "--no-webui"])
        .arg("--api-key")
        .arg(&key)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    children::own_group(&mut cmd);
    {
        let mut s = lock(state());
        s.running = Some(Running { pid: None, model: model.to_owned(), ctx, endpoint: Endpoint { base: format!("http://127.0.0.1:{port}"), key: key.clone() } });
    }
    set_status(app, "loading");
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            lock(state()).running = None;
            set_status(app, "stopped");
            return Err(AiError::new("SERVER", format!("Couldn't start the AI engine: {e}")));
        }
    };
    let pid = child.id();
    children::track(pid);
    if let Some(r) = lock(state()).running.as_mut() {
        r.pid = pid;
    }

    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut s = lock(state());
                s.stderr.push_back(line);
                if s.stderr.len() > 60 {
                    s.stderr.pop_front();
                }
            }
        });
    }
    // Watch for the process ending: expected (stop) or a crash.
    let watch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        children::untrack(pid);
        let crashed = {
            let mut s = lock(state());
            let ours = s.running.as_ref().is_some_and(|r| r.pid == pid);
            if ours {
                s.running = None;
                s.crashes.push_back(Instant::now());
                crate::logging::write(&format!("llama-server exited unexpectedly ({status:?}): {}", s.stderr.iter().rev().take(5).cloned().collect::<Vec<_>>().join(" | ")));
            }
            ours
        };
        if crashed {
            set_status(&watch_app, "crashed");
        }
    });

    // Wait until the model is loaded.
    let endpoint = Endpoint { base: format!("http://127.0.0.1:{port}"), key };
    let started = Instant::now();
    loop {
        if lock(state()).running.as_ref().map(|r| r.pid) != Some(pid) {
            let s = lock(state());
            return Err(classify(&s.stderr, "The AI engine stopped while loading the model."));
        }
        if let Ok(resp) = client().get(format!("{}/health", endpoint.base)).timeout(Duration::from_secs(2)).send().await {
            if resp.status().is_success() {
                break;
            }
        }
        if started.elapsed() > LOAD_TIMEOUT {
            stop(app).await;
            return Err(AiError::new("SERVER", "The model took too long to load"));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    lock(state()).last_used = Some(Instant::now());
    set_status(app, "ready");
    Ok(endpoint)
}

/// The last stderr lines classified, for errors that happen mid-request.
pub fn last_error(fallback: &str) -> AiError {
    classify(&lock(state()).stderr, fallback)
}

pub fn touch() {
    lock(state()).last_used = Some(Instant::now());
}

pub async fn stop(app: &AppHandle) {
    let running = lock(state()).running.take();
    if let Some(r) = running {
        if let Some(pid) = r.pid {
            children::signal_group(pid, libc::SIGTERM);
            tokio::time::sleep(Duration::from_millis(400)).await;
            children::signal_group(pid, libc::SIGKILL);
            children::untrack(Some(pid));
        }
        set_status(app, "stopped");
    }
}

/// Stops the server when it's serving `model` (before deleting the model file).
pub async fn stop_if_using(model: &str) {
    let pid = {
        let mut s = lock(state());
        if s.running.as_ref().is_some_and(|r| r.model == model) {
            s.status = "stopped";
            s.running.take().and_then(|r| r.pid)
        } else {
            None
        }
    };
    if let Some(pid) = pid {
        children::signal_group(pid, libc::SIGKILL);
        children::untrack(Some(pid));
    }
}

#[tauri::command]
pub async fn ai_unload(app: AppHandle) {
    stop(&app).await;
}

/// Sets the idle time after which the model is unloaded (0 = never).
#[tauri::command]
pub fn ai_configure(idle_minutes: u64) {
    lock(state()).idle_minutes = idle_minutes;
}

/// Unloads the model after the configured idle time. Started once at launch.
pub fn spawn_idle_unloader(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let idle = {
                let s = lock(state());
                s.running.is_some() && s.idle_minutes > 0 && s.last_used.is_some_and(|t| t.elapsed() > Duration::from_secs(s.idle_minutes * 60))
            };
            // Don't pull the model out from under a load in progress.
            if idle {
                if let Ok(_guard) = start_lock().try_lock() {
                    stop(&app).await;
                }
            }
        }
    });
}
