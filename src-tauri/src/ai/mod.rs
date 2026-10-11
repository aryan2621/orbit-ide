//! The built-in AI: a bundled llama.cpp `llama-server` running models on-device (Apple Silicon only).
//! Nothing leaves the Mac except the model downloads from Hugging Face.

pub mod chat;
pub mod hardware;
pub mod history;
pub mod models;
pub mod server;

use serde::Serialize;
use std::path::PathBuf;

/// Errors the UI maps to an action (use a smaller model, reduce context, retry, …).
#[derive(Serialize, Clone, Debug)]
pub struct AiError {
    /// NO_MODEL | OUT_OF_MEMORY | CONTEXT_TOO_SMALL | DOWNLOAD_FAILED | CHECKSUM_MISMATCH | CRASHED |
    /// UNSUPPORTED | SERVER
    pub code: &'static str,
    pub message: String,
}

impl AiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        AiError { code, message: message.into() }
    }
}

impl From<AiError> for String {
    fn from(e: AiError) -> String {
        format!("{}: {}", e.code, e.message)
    }
}

/// ~/Library/Application Support/com.orbit.ide/<sub>
pub fn data_dir(sub: &str) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library/Application Support/com.orbit.ide").join(sub)
}
