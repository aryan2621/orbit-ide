use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;

/// Long-running background jobs (builds, runs, downloads) whose output streams to the UI.
#[derive(Default)]
pub struct Jobs {
    cancel: Mutex<HashMap<String, watch::Sender<bool>>>,
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
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.log(format!("error: {e}"));
                return JobExit::failed();
            }
        };
        let event = format!("job://{}/{channel}", self.id);
        let out = tokio::spawn(stream_lines(self.app.clone(), event.clone(), child.stdout.take().unwrap(), hooks.clone()));
        let err = tokio::spawn(stream_lines(self.app.clone(), event, child.stderr.take().unwrap(), hooks));

        let mut cancel = self.cancel.clone();
        let exit = tokio::select! {
            status = child.wait() => JobExit { code: status.ok().and_then(|s| s.code()), cancelled: false },
            // (The returned watch::Ref isn't Send, so drop it inside the block.)
            _ = async { cancel.wait_for(|c| *c).await.is_ok() } => {
                let _ = child.kill().await;
                JobExit { code: None, cancelled: true }
            }
        };
        if exit.cancelled {
            // Grandchildren may still hold the pipes open; don't wait for them.
            out.abort();
            err.abort();
        }
        let _ = out.await;
        let _ = err.await;
        exit
    }

    /// Runs a quick command quietly and returns (success, stdout, stderr). Not cancellable.
    pub async fn output(&self, mut cmd: tokio::process::Command) -> (bool, String, String) {
        match cmd.output().await {
            Ok(o) => (
                o.status.success(),
                String::from_utf8_lossy(&o.stdout).into_owned(),
                String::from_utf8_lossy(&o.stderr).into_owned(),
            ),
            Err(e) => (false, String::new(), e.to_string()),
        }
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
    app.state::<Jobs>().cancel.lock().unwrap().insert(id.clone(), tx);
    let ctx = JobCtx { app: app.clone(), id: id.clone(), cancel: rx };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let exit = task(ctx).await;
        app.state::<Jobs>().cancel.lock().unwrap().remove(&id);
        let _ = app.emit(&format!("job://{id}/exit"), exit);
    });
}

/// Runs a single command as a job, streaming its output on `job://<id>/log`.
pub fn spawn_job(app: &AppHandle, id: String, cmd: tokio::process::Command) {
    spawn_task(app, id, |ctx| async move { ctx.run(cmd, "log", Arc::new(Mutex::new(Passthrough))).await });
}

async fn stream_lines<H: JobHooks>(app: AppHandle, event: String, mut reader: impl AsyncRead + Unpin, hooks: Arc<Mutex<H>>) {
    let emit = |bytes: &[u8]| {
        let line = String::from_utf8_lossy(bytes);
        if let Some(shown) = hooks.lock().unwrap().line(&line) {
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
    if let Some(tx) = state.cancel.lock().unwrap().get(&id) {
        let _ = tx.send(true);
    }
}
