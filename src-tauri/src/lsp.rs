//! Bridges a language server's or debug adapter's stdio to the UI. LSP and DAP share the same
//! `Content-Length` framing; the UI speaks the protocol, this side only adds/strips headers.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use crate::env;

struct Server {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct LanguageServers {
    next_id: AtomicU32,
    servers: Mutex<HashMap<u32, Server>>,
}

/// Starts sourcekit-lsp for `root`. Messages arrive as `lsp://<id>/message` events (JSON text);
/// `lsp://<id>/exit` fires if the server dies.
#[tauri::command]
pub async fn lsp_start(app: AppHandle, state: State<'_, LanguageServers>, root: String) -> Result<u32, String> {
    start(app, state, "sourcekit-lsp", root).await
}

/// Starts lldb-dap (the LLDB debug adapter); same events and commands as a language server.
#[tauri::command]
pub async fn dap_start(app: AppHandle, state: State<'_, LanguageServers>, root: String) -> Result<u32, String> {
    start(app, state, "lldb-dap", root).await
}

async fn start(app: AppHandle, state: State<'_, LanguageServers>, tool: &str, root: String) -> Result<u32, String> {
    let mut cmd = env::command("xcrun");
    cmd.arg(tool)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {tool}: {e}"))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let name = tool.to_owned();

    let app_out = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut reader).await {
            let _ = app_out.emit(&format!("lsp://{id}/message"), msg);
        }
        let _ = app_out.emit(&format!("lsp://{id}/exit"), ());
    });

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[{name} {id}] {line}");
        }
    });

    state.servers.lock().await.insert(id, Server { child, stdin });
    Ok(id)
}

async fn read_message(reader: &mut BufReader<tokio::process::ChildStdout>) -> Option<String> {
    let mut length = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await.ok()? == 0 {
            return None;
        }
        let header = header.trim();
        if header.is_empty() {
            break;
        }
        if let Some(v) = header.strip_prefix("Content-Length:") {
            length = v.trim().parse::<usize>().ok();
        }
    }
    let mut body = vec![0u8; length?];
    reader.read_exact(&mut body).await.ok()?;
    String::from_utf8(body).ok()
}

#[tauri::command]
pub async fn lsp_send(state: State<'_, LanguageServers>, id: u32, message: String) -> Result<(), String> {
    let mut servers = state.servers.lock().await;
    let server = servers.get_mut(&id).ok_or("Language server is not running")?;
    let framed = format!("Content-Length: {}\r\n\r\n{message}", message.len());
    server.stdin.write_all(framed.as_bytes()).await.map_err(|e| e.to_string())?;
    server.stdin.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LanguageServers>, id: u32) -> Result<(), String> {
    if let Some(mut server) = state.servers.lock().await.remove(&id) {
        let _ = server.child.kill().await;
    }
    Ok(())
}
