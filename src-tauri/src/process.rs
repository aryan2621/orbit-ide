use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;

use crate::children;

/// How long a cancelled process gets to exit after SIGTERM before it's force-killed.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Long-running background jobs (builds, runs, downloads) whose output streams to the UI.
#[derive(Default)]
pub struct Jobs {
    /// job id → (generation, cancel sender). The generation stops a finished job from removing a
    /// newer job that reused its id.
    cancel: Mutex<HashMap<String, (u64, watch::Sender<bool>)>>,
    next: AtomicU64,
}

#[derive(Clone, Serialize)]
pub struct JobExit {
    pub code: Option<i32>,
    pub cancelled: bool,
}

impl JobExit {
    pub fn failed() -> Self {
        JobExit { code: Some(1), cancelled: false }
    }
    pub fn success(&self) -> bool {
        self.code == Some(0) && !self.cancelled
    }
}

/// Customizes how a process's output is shown: rewrite/hide lines.
pub trait JobHooks: Send + 'static {
    /// Called for every output line; returns the text to show, or `None` to hide it.
    fn line(&mut self, line: &str) -> Option<String> {
        Some(line.to_owned())
    }

    /// Called for every output line before `line`; returns build progress when it advanced.
    fn progress(&mut self, _line: &str) -> Option<Progress> {
        None
    }
}

/// Build steps done so far (and the total when the tool reports one), sent on `job://<id>/progress`.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Progress {
    pub done: u32,
    pub total: Option<u32>,
}

pub struct Passthrough;
impl JobHooks for Passthrough {}

/// Handle given to a job's task: emits events and runs cancellable child processes.
#[derive(Clone)]
pub struct JobCtx {
    pub app: AppHandle,
    pub id: String,
    cancel: watch::Receiver<bool>,
}

impl JobCtx {
    pub fn emit<T: Serialize + Clone>(&self, channel: &str, payload: T) {
        let _ = self.app.emit(&format!("job://{}/{channel}", self.id), payload);
    }

    /// Adds a line to the job's main log.
    pub fn log(&self, line: impl Into<String>) {
        self.emit("log", line.into());
    }

    pub fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    /// Runs `cmd` to completion, streaming its output lines on `job://<id>/<channel>`.
    /// Kills it if the job is cancelled.
    pub async fn run<H: JobHooks>(&self, mut cmd: tokio::process::Command, channel: &str, hooks: Arc<Mutex<H>>) -> JobExit {
        if self.cancelled() {
            return JobExit { code: None, cancelled: true };
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
        children::own_group(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.log(format!("error: {e}"));
                return JobExit::failed();
            }
        };
        let pid = child.id();
        children::track(pid);
        let event = format!("job://{}/{channel}", self.id);
        // Both pipes were requested above, so they're always present.
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            stop_group(&mut child, pid).await;
            children::untrack(pid);
            return JobExit::failed();
        };
        let out = tokio::spawn(stream_lines(self.app.clone(), event.clone(), stdout, hooks.clone()));
        let err = tokio::spawn(stream_lines(self.app.clone(), event, stderr, hooks));

        let mut cancel = self.cancel.clone();
        let exit = tokio::select! {
            status = child.wait() => JobExit { code: status.ok().and_then(|s| s.code()), cancelled: false },
            // (The returned watch::Ref isn't Send, so drop it inside the block.)
            _ = async { cancel.wait_for(|c| *c).await.is_ok() } => {
                stop_group(&mut child, pid).await;
                JobExit { code: None, cancelled: true }
            }
        };
        children::untrack(pid);
        if exit.cancelled {
            // Grandchildren may still hold the pipes open; don't wait for them.
            out.abort();
            err.abort();
        }
        let _ = out.await;
        let _ = err.await;
        exit
    }

    /// Runs a quick command quietly and returns (success, stdout, stderr). Stops early (and kills
    /// the command) if the job is cancelled.
    pub async fn output(&self, cmd: tokio::process::Command) -> (bool, String, String) {
        self.output_timeout(cmd, None).await
    }

    /// [`output`](Self::output) that also gives up after `timeout`.
    pub async fn output_timeout(&self, mut cmd: tokio::process::Command, timeout: Option<Duration>) -> (bool, String, String) {
        if self.cancelled() {
            return (false, String::new(), "Cancelled".into());
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
        children::own_group(&mut cmd);
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return (false, String::new(), e.to_string()),
        };
        let pid = child.id();
        children::track(pid);
        let mut cancel = self.cancel.clone();
        let limit = async {
            match timeout {
                Some(t) => tokio::time::sleep(t).await,
                None => std::future::pending().await,
            }
        };
        let (finished, result) = tokio::select! {
            out = child.wait_with_output() => (true, match out {
                Ok(o) => (
                    o.status.success(),
                    String::from_utf8_lossy(&o.stdout).into_owned(),
                    String::from_utf8_lossy(&o.stderr).into_owned(),
                ),
                Err(e) => (false, String::new(), e.to_string()),
            }),
            _ = async { cancel.wait_for(|c| *c).await.is_ok() } => (false, (false, String::new(), "Cancelled".into())),
            _ = limit => (false, (false, String::new(), format!("Timed out after {}s", timeout.unwrap_or_default().as_secs()))),
        };
        if !finished {
            // Cancelled or timed out: the child was dropped (kill_on_drop); take its group too.
            if let Some(pid) = pid {
                children::signal_group(pid, libc::SIGKILL);
            }
        }
        children::untrack(pid);
        result
    }
}

/// Starts `task` as job `id`; emits `job://<id>/exit` with its result when it finishes. The id comes
/// from the caller so the UI can subscribe to the job's events before it starts.
pub fn spawn_task<F, Fut>(app: &AppHandle, id: String, task: F)
where
    F: FnOnce(JobCtx) -> Fut + Send + 'static,
    Fut: Future<Output = JobExit> + Send + 'static,
{
    let (tx, rx) = watch::channel(false);
    let jobs = app.state::<Jobs>();
    let generation = jobs.next.fetch_add(1, Ordering::Relaxed);
    // A job reusing a running job's id replaces it: cancel the old one rather than orphaning it.
    if let Some((_, old)) = lock(&jobs.cancel).insert(id.clone(), (generation, tx)) {
        let _ = old.send(true);
    }
    let ctx = JobCtx { app: app.clone(), id: id.clone(), cancel: rx };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let exit = task(ctx).await;
        {
            let jobs = app.state::<Jobs>();
            let mut map = lock(&jobs.cancel);
            if map.get(&id).is_some_and(|(g, _)| *g == generation) {
                map.remove(&id);
            }
        }
        let _ = app.emit(&format!("job://{id}/exit"), exit);
    });
}

/// Runs a single command as a job, streaming its output on `job://<id>/log`.
pub fn spawn_job(app: &AppHandle, id: String, cmd: tokio::process::Command) {
    spawn_task(app, id, |ctx| async move { ctx.run(cmd, "log", Arc::new(Mutex::new(Passthrough))).await });
}

async fn stream_lines<H: JobHooks>(app: AppHandle, event: String, mut reader: impl AsyncRead + Unpin, hooks: Arc<Mutex<H>>) {
    let progress_event = format!("{}/progress", event.rsplit_once('/').map_or(event.as_str(), |(job, _)| job));
    let emit = |bytes: &[u8]| {
        let line = String::from_utf8_lossy(bytes);
        let mut hooks = lock(&hooks);
        if let Some(p) = hooks.progress(&line) {
            let _ = app.emit(&progress_event, p);
        }
        if let Some(shown) = hooks.line(&line) {
            let _ = app.emit(&event, shown);
        }
    };
    let mut buf = [0u8; 8192];
    let mut pending = Vec::new();
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        // `\r` counts as a line break so progress updates stream instead of piling up.
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !pending.is_empty() {
                    emit(&pending);
                    pending.clear();
                }
            } else {
                pending.push(b);
            }
        }
    }
    if !pending.is_empty() {
        emit(&pending);
    }
}

#[tauri::command]
pub fn job_cancel(state: State<'_, Jobs>, id: String) {
    if let Some((_, tx)) = lock(&state.cancel).get(&id) {
        let _ = tx.send(true);
    }
}

impl Jobs {
    /// Cancels every running job (used on quit).
    pub fn cancel_all(&self) {
        for (_, tx) in lock(&self.cancel).values() {
            let _ = tx.send(true);
        }
    }
}

/// SIGTERM to the child's process group, then SIGKILL if it hasn't exited within [`KILL_GRACE`].
async fn stop_group(child: &mut tokio::process::Child, pid: Option<u32>) {
    let Some(pid) = pid else {
        let _ = child.kill().await;
        return;
    };
    children::signal_group(pid, libc::SIGTERM);
    if tokio::time::timeout(KILL_GRACE, child.wait()).await.is_err() {
        children::signal_group(pid, libc::SIGKILL);
        let _ = child.kill().await;
    } else {
        // The leader exited; make sure no stragglers in its group survive.
        children::signal_group(pid, libc::SIGKILL);
    }
}

/// Locks a mutex, recovering from poisoning instead of panicking (a panic aborts the whole app).
pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
