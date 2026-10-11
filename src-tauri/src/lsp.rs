//! Bridges a language server's or debug adapter's stdio to the UI. LSP and DAP share the same
//! `Content-Length` framing; the UI speaks the protocol, this side only adds/strips headers.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

use crate::{children, env};

/// Programs the UI may start through the bridge (matched on the file name, and the path must be the
/// installed copy, see `trusted_program`). Anything else is refused: the bridge must not become a
/// way to run arbitrary commands.
const ALLOWED: &[&str] = &[
    "sourcekit-lsp",
    "lldb-dap",
    "kotlin-lsp",
    "kotlin-ls",
    "kotlin-language-server",
    "jdtls",
    "lemminx",
    "kotlin-debug-adapter",
];

struct Server {
    child: Child,
    /// Locked per server, so a slow write never holds up the whole table.
    stdin: Arc<Mutex<ChildStdin>>,
    /// Released by `lsp_attach` once the UI listens, so no early message or exit event is lost.
    gate: Arc<Notify>,
}

/// How long output waits for `lsp_attach` before flowing anyway.
const ATTACH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Default)]
pub struct LanguageServers {
    next_id: AtomicU32,
    servers: Mutex<HashMap<u32, Server>>,
}

/// Starts a language server for `root` (sourcekit-lsp unless `program`/`args` name another one,
/// e.g. a Kotlin or Java server). Messages arrive as `lsp://<id>/message` events (JSON text);
/// `lsp://<id>/exit` fires if the server dies.
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: State<'_, LanguageServers>,
    root: String,
    program: Option<String>,
    args: Option<Vec<String>>,
) -> Result<u32, String> {
    let (program, args) = resolve(program, args, "sourcekit-lsp");
    start(app, state, program, args, root).await
}

/// Starts a debug adapter (lldb-dap unless `program`/`args` say otherwise); same events and
/// commands as a language server.
#[tauri::command]
pub async fn dap_start(
    app: AppHandle,
    state: State<'_, LanguageServers>,
    root: String,
    program: Option<String>,
    args: Option<Vec<String>>,
) -> Result<u32, String> {
    let (program, args) = resolve(program, args, "lldb-dap");
    start(app, state, program, args, root).await
}

/// Defaults to Apple's tool via `xcrun <tool>`.
fn resolve(program: Option<String>, args: Option<Vec<String>>, xcrun_tool: &str) -> (String, Vec<String>) {
    match program {
        Some(p) => (p, args.unwrap_or_default()),
        None => ("xcrun".into(), vec![xcrun_tool.into()]),
    }
}

async fn start(
    app: AppHandle,
    state: State<'_, LanguageServers>,
    program: String,
    args: Vec<String>,
    root: String,
) -> Result<u32, String> {
    let tool = if program == "xcrun" { args.first().cloned().unwrap_or_default() } else { program.clone() };
    let tool = tool.rsplit('/').next().unwrap_or(&tool).to_owned();
    if !ALLOWED.contains(&tool.as_str()) || (program == "xcrun" && args.len() != 1) || !trusted_program(&program, &tool) {
        return Err(format!("{tool} is not a supported language server or debug adapter"));
    }
    let mut cmd = env::command(&program);
    cmd.args(&args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    children::own_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {tool}: {e}"))?;
    let pid = child.id();
    children::track(pid);
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill().await;
        children::untrack(pid);
        return Err(format!("Could not connect to {tool}"));
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let name = tool.clone();

    let gate = Arc::new(Notify::new());
    let app_out = app.clone();
    let wait = gate.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(ATTACH_TIMEOUT, wait.notified()).await;
        let mut reader = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut reader).await {
            if let Some(msg) = msg {
                let _ = app_out.emit(&format!("lsp://{id}/message"), msg);
            }
        }
        // The server died (or closed stdout): reap it and forget it so sends fail cleanly.
        let state = app_out.state::<LanguageServers>();
        let dead = state.servers.lock().await.remove(&id);
        if let Some(mut server) = dead {
            let _ = server.child.kill().await;
        }
        children::untrack(pid);
        let _ = app_out.emit(&format!("lsp://{id}/exit"), ());
    });

    let app_err = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            crate::logging::write(format!("[{name} {id}] {line}"));
            let _ = app_err.emit(&format!("lsp://{id}/stderr"), line);
        }
    });

    state.servers.lock().await.insert(id, Server { child, stdin: Arc::new(Mutex::new(stdin)), gate });
    Ok(id)
}

/// Reads one framed message. `None` means the stream ended; `Some(None)` means junk was skipped
/// (a header block without `Content-Length`, e.g. a stray log line on stdout), which isn't fatal.
/// The program must be the copy Orbit itself would pick: `xcrun`, the one found on Orbit's PATH, or
/// the debug adapter installed by Setup. A same-named binary elsewhere (e.g. inside a project) isn't.
fn trusted_program(program: &str, tool: &str) -> bool {
    if program == "xcrun" {
        return true;
    }
    let canon = |p: &str| std::fs::canonicalize(p).ok();
    let Some(actual) = canon(program) else { return false };
    let installed = crate::toolchains::android::lsp::debug_adapter_dir().join("bin").join(tool);
    [env::which(tool), Some(installed.to_string_lossy().into_owned())]
        .into_iter()
        .flatten()
        .any(|known| canon(&known).as_ref() == Some(&actual))
}

async fn read_message(reader: &mut BufReader<tokio::process::ChildStdout>) -> Option<Option<String>> {
    let mut length = None;
    loop {
        let mut header = Vec::new();
        if reader.read_until(b'\n', &mut header).await.ok()? == 0 {
            return None;
        }
        let header = String::from_utf8_lossy(&header);
        let header = header.trim();
        if header.is_empty() {
            break;
        }
        if let Some((key, value)) = header.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let Some(length) = length else { return Some(None) };
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await.ok()?;
    Some(Some(String::from_utf8(body).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())))
}

/// Called by the UI once it listens to `lsp://<id>/…`; starts delivering the server's output.
#[tauri::command]
pub async fn lsp_attach(state: State<'_, LanguageServers>, id: u32) -> Result<(), String> {
    if let Some(server) = state.servers.lock().await.get(&id) {
        server.gate.notify_one();
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_send(state: State<'_, LanguageServers>, id: u32, message: String) -> Result<(), String> {
    let stdin = state.servers.lock().await.get(&id).map(|s| s.stdin.clone()).ok_or("Language server is not running")?;
    let framed = format!("Content-Length: {}\r\n\r\n{message}", message.len());
    let mut stdin = stdin.lock().await;
    stdin.write_all(framed.as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LanguageServers>, id: u32) -> Result<(), String> {
    let removed = state.servers.lock().await.remove(&id);
    if let Some(mut server) = removed {
        let pid = server.child.id();
        let _ = server.child.kill().await;
        if let Some(pid) = pid {
            children::signal_group(pid, libc::SIGKILL);
        }
        children::untrack(pid);
    }
    Ok(())
}
