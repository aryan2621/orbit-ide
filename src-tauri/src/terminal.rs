use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::children;
use crate::process::lock;

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Signalled by `terminal_attach` once the UI listens, so the first prompt isn't lost.
    attach: Mutex<Option<mpsc::Sender<()>>>,
}

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU32,
    // Each session has its own locks so a shell with a full input buffer can't stall the others.
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
}

/// Spawns the user's login shell in a PTY. Output is streamed as `terminal://<id>/data` events.
#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, Terminals>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.or_else(|| std::env::var("HOME").ok()) {
        cmd.cwd(dir);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    // The shell leads its own session/process group (PTY setsid), so killing the group on quit
    // takes anything started from it too.
    children::track(child.process_id());

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Register before the reader starts so a quick exit still finds the session.
    let (attach_tx, attach_rx) = mpsc::channel();
    let session = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        attach: Mutex::new(Some(attach_tx)),
    });
    lock(&state.sessions).insert(id, session);

    std::thread::spawn(move || {
        // Hold output until the UI is listening (or give up waiting after a few seconds).
        let _ = attach_rx.recv_timeout(Duration::from_secs(10));
        let mut buf = [0u8; 8192];
        // Bytes of a UTF-8 character split across reads, carried to the next chunk.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid = utf8_prefix_len(&carry);
                    if valid > 0 {
                        let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                        let _ = app.emit(&format!("terminal://{id}/data"), text);
                        carry.drain(..valid);
                    }
                }
            }
        }
        if !carry.is_empty() {
            let _ = app.emit(&format!("terminal://{id}/data"), String::from_utf8_lossy(&carry).into_owned());
        }
        let _ = app.emit(&format!("terminal://{id}/exit"), ());
    });

    Ok(id)
}

/// Length of `bytes` up to (not including) an incomplete UTF-8 sequence at the very end.
fn utf8_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        // `error_len() == None` means the input ended mid-character; keep those bytes for later.
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        // Genuinely invalid bytes: pass everything through (lossily) rather than stall.
        Err(_) => bytes.len(),
    }
}

fn session(state: &Terminals, id: u32) -> Result<Arc<Session>, String> {
    lock(&state.sessions).get(&id).cloned().ok_or_else(|| "no such terminal".into())
}

/// Called by the UI once it listens to `terminal://<id>/…`; starts delivering output.
#[tauri::command]
pub fn terminal_attach(state: State<'_, Terminals>, id: u32) {
    if let Ok(s) = session(&state, id) {
        if let Some(tx) = lock(&s.attach).take() {
            let _ = tx.send(());
        }
    }
}

#[tauri::command]
pub async fn terminal_write(state: State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let s = session(&state, id)?;
    // Writing can block while the shell isn't reading; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || lock(&s.writer).write_all(data.as_bytes()).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let s = session(&state, id)?;
    let master = lock(&s.master);
    master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, Terminals>, id: u32) {
    let Some(s) = lock(&state.sessions).remove(&id) else { return };
    // Closing the PTY sends SIGHUP; also kill and reap the shell in case it ignores that.
    let mut child = lock(&s.child);
    let pid = child.process_id();
    let _ = child.kill();
    let _ = child.wait();
    children::untrack(pid);
}
