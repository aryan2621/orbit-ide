//! Chat history per project, in ~/Library/Application Support/com.orbit.ide/chats/<hash>.json.

use super::data_dir;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn file(root: &str) -> PathBuf {
    let hash: String = Sha256::digest(root.as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
    data_dir("chats").join(format!("{hash}.json"))
}

#[tauri::command]
pub fn ai_history_load(root: String) -> Option<String> {
    std::fs::read_to_string(file(&root)).ok()
}

#[tauri::command]
pub fn ai_history_save(root: String, json: String) -> Result<(), String> {
    let path = file(&root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::workspace::atomic_write(&path, json.as_bytes()).map_err(|e| e.to_string())
}
