//! Quitting goes through the UI first so it can offer to save unsaved files. A broken or busy UI
//! must never trap the user, though: a second ⌘Q while a quit is pending, or a UI that doesn't
//! acknowledge the request within [`ACK_TIMEOUT`], exits right away.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::{children, process::Jobs};

const ACK_TIMEOUT: Duration = Duration::from_secs(3);

static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// A quit request is waiting for the UI (cleared when the user cancels).
static QUIT_PENDING: AtomicBool = AtomicBool::new(false);
/// Bumped per request; the UI's ack stores the request it answered.
static QUIT_REQUEST: AtomicU64 = AtomicU64::new(0);
static QUIT_ACKED: AtomicU64 = AtomicU64::new(0);

/// Handles app run events: a user-initiated quit (⌘Q, closing the window) is held back and
/// handed to the UI as `app://quit-requested`; the UI calls `app_quit` once it's safe.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, code: None, .. } if !QUIT_CONFIRMED.load(Ordering::SeqCst) => {
            api.prevent_exit();
            request_quit(app);
        }
        RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { api, .. }, .. }
            if !QUIT_CONFIRMED.load(Ordering::SeqCst) =>
        {
            api.prevent_close();
            request_quit(app);
        }
        // Builds, runs, language servers, terminals and emulators must not outlive Orbit.
        RunEvent::Exit => shutdown(app),
        _ => {}
    }
}

fn request_quit(app: &AppHandle) {
    if QUIT_PENDING.swap(true, Ordering::SeqCst) {
        crate::logging::write("quit: second request while pending, exiting");
        force_quit(app);
        return;
    }
    let request = QUIT_REQUEST.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("app://quit-requested", request);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ACK_TIMEOUT).await;
        if QUIT_PENDING.load(Ordering::SeqCst) && QUIT_ACKED.load(Ordering::SeqCst) < request {
            crate::logging::write("quit: UI did not acknowledge, exiting");
            force_quit(&app);
        }
    });
}

fn force_quit(app: &AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    shutdown(app);
    app.exit(0);
}

/// The UI received quit request `request` and is handling it (e.g. showing the unsaved dialog).
#[tauri::command]
pub fn app_quit_ack(request: u64) {
    QUIT_ACKED.fetch_max(request, Ordering::SeqCst);
}

/// The user cancelled the quit.
#[tauri::command]
pub fn app_quit_cancel() {
    QUIT_PENDING.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    force_quit(&app);
}

/// Cancels every job and kills every child process group. Safe to call more than once.
fn shutdown(app: &AppHandle) {
    app.state::<Jobs>().cancel_all();
    children::kill_all();
}
