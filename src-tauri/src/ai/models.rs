//! The model catalog, downloads (resumable, checksummed) and installed models.
//!
//! Models live in ~/Library/Application Support/com.orbit.ide/models as `<id>.gguf`; a download in
//! progress is `<id>.gguf.part`. Custom GGUF files can be imported and are stored the same way.

use super::{data_dir, AiError};
use crate::process::lock;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const GB: u64 = 1 << 30;

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Pinned to a repository revision so the checksum always matches.
    pub url: &'static str,
    pub size: u64,
    /// From the Hugging Face API (the file's LFS oid).
    pub sha256: &'static str,
    pub license: &'static str,
    pub license_url: &'static str,
    pub min_memory_gb: u64,
    /// Supports fill-in-the-middle, for inline completions.
    pub infill: bool,
}

pub const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "qwen2.5-coder-7b-instruct-q4_k_m",
        name: "Qwen2.5 Coder 7B",
        description: "The best balance of quality and speed for coding on 16 GB Macs.",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/13fb94bfda8c8cf22497dc57b78f391a9acb426a/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        size: 4_683_073_536,
        sha256: "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c",
        license: "Apache 2.0",
        license_url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/blob/main/LICENSE",
        min_memory_gb: 16,
        infill: true,
    },
    CatalogModel {
        id: "qwen2.5-coder-3b-instruct-q4_k_m",
        name: "Qwen2.5 Coder 3B",
        description: "Smaller and faster; for 8 GB Macs. Research license: non-commercial use only.",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/f74adce6aa16316c625447af059dbebe4983757c/qwen2.5-coder-3b-instruct-q4_k_m.gguf",
        size: 2_104_932_800,
        sha256: "724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7",
        license: "Qwen Research License (non-commercial)",
        license_url: "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/blob/main/LICENSE",
        min_memory_gb: 8,
        infill: true,
    },
    CatalogModel {
        id: "qwen3-8b-q4_k_m",
        name: "Qwen3 8B",
        description: "Stronger reasoning for multi-step agent runs; slower. No inline completions.",
        url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf",
        size: 5_027_783_488,
        sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
        license: "Apache 2.0",
        license_url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/main/LICENSE",
        min_memory_gb: 16,
        infill: false,
    },
];

/// 7B with 16 GB or more, 3B with 8 GB, nothing below.
pub fn recommended(memory: u64) -> Option<&'static CatalogModel> {
    if memory >= 15 * GB {
        CATALOG.first()
    } else if memory >= 7 * GB {
        CATALOG.get(1)
    } else {
        None
    }
}

pub fn models_dir() -> PathBuf {
    data_dir("models")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 120 && id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && !id.starts_with('.')
}

/// The installed model file for `id`, if present.
pub fn model_path(id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    Some(models_dir().join(format!("{id}.gguf"))).filter(|p| p.is_file())
}

pub fn catalog_entry(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|m| m.id == id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub custom: bool,
    pub infill: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsInfo {
    pub catalog: Vec<CatalogModel>,
    pub installed: Vec<InstalledModel>,
    /// Bytes already downloaded of interrupted downloads, by id (they resume).
    pub partial: HashMap<String, u64>,
    pub downloading: Vec<String>,
    pub dir: String,
}

#[tauri::command]
pub fn ai_models() -> ModelsInfo {
    let dir = models_dir();
    let (mut installed, mut partial) = (Vec::new(), HashMap::new());
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        if let Some(id) = name.strip_suffix(".gguf.part") {
            partial.insert(id.to_owned(), size);
        } else if let Some(id) = name.strip_suffix(".gguf") {
            let entry = catalog_entry(id);
            installed.push(InstalledModel {
                id: id.to_owned(),
                name: entry.map(|m| m.name.to_owned()).unwrap_or_else(|| id.to_owned()),
                size,
                custom: entry.is_none(),
                infill: entry.map(|m| m.infill).unwrap_or(false),
            });
        }
    }
    installed.sort_by(|a, b| a.name.cmp(&b.name));
    let downloading = lock(downloads()).keys().cloned().collect();
    ModelsInfo { catalog: CATALOG.to_vec(), installed, partial, downloading, dir: dir.to_string_lossy().into_owned() }
}

// ---- downloads ----

/// Running downloads → their stop flag (`true` also deletes the partial file).
struct Download {
    stop: Arc<AtomicBool>,
    discard: Arc<AtomicBool>,
}

fn downloads() -> &'static Mutex<HashMap<String, Download>> {
    static D: OnceLock<Mutex<HashMap<String, Download>>> = OnceLock::new();
    D.get_or_init(Default::default)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    received: u64,
    total: u64,
    /// downloading | verifying | done | paused | cancelled | error
    status: &'static str,
    error: Option<AiError>,
}

fn free_space(dir: &Path) -> Option<u64> {
    let path = std::ffi::CString::new(dir.to_string_lossy().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `stat` is a valid out-pointer.
    let rc = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
    (rc == 0).then(|| stat.f_bavail as u64 * stat.f_frsize as u64)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hashes what's already on disk so a resumed download keeps one running checksum.
fn hash_file(path: &Path, hasher: &mut Sha256) -> std::io::Result<u64> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(total);
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
}

async fn download(app: &AppHandle, model: &CatalogModel, stop: &AtomicBool) -> Result<bool, AiError> {
    let fail = |m: String| AiError::new("DOWNLOAD_FAILED", m);
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| fail(format!("Couldn't create {}: {e}", dir.display())))?;
    let part = dir.join(format!("{}.gguf.part", model.id));
    let done = dir.join(format!("{}.gguf", model.id));

    let mut hasher = Sha256::new();
    let mut received = if part.exists() {
        let p = part.clone();
        let (h, n) = tokio::task::spawn_blocking(move || {
            let mut h = Sha256::new();
            hash_file(&p, &mut h).map(|n| (h, n))
        })
        .await
        .map_err(|e| fail(e.to_string()))?
        .map_err(|e| fail(e.to_string()))?;
        hasher = h;
        n
    } else {
        0
    };
    if received > model.size {
        let _ = std::fs::remove_file(&part);
        received = 0;
        hasher = Sha256::new();
    }
    // Room for the rest plus a 1 GB margin.
    if let Some(free) = free_space(&dir) {
        let needed = model.size - received + GB;
        if free < needed {
            return Err(fail(format!("Not enough disk space: {:.1} GB free, {:.1} GB needed", free as f64 / GB as f64, needed as f64 / GB as f64)));
        }
    }

    let emit = |received: u64, status: &'static str| {
        let _ = app.emit("ai://download", Progress { id: model.id.into(), received, total: model.size, status, error: None });
    };
    emit(received, "downloading");

    if received < model.size {
        let client = reqwest::Client::builder().user_agent(concat!("Orbit/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| fail(e.to_string()))?;
        let mut req = client.get(model.url);
        if received > 0 {
            req = req.header("Range", format!("bytes={received}-"));
        }
        let mut resp = req.send().await.map_err(|e| fail(format!("Couldn't reach Hugging Face: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(fail(format!("Hugging Face returned {status}")));
        }
        // A server that ignores Range sends the whole file again.
        if received > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
            received = 0;
            hasher = Sha256::new();
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(received > 0)
            .truncate(received == 0)
            .open(&part)
            .map_err(|e| fail(e.to_string()))?;
        let mut last_emit = std::time::Instant::now();
        loop {
            if stop.load(Ordering::Relaxed) {
                file.flush().ok();
                return Ok(false);
            }
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    file.write_all(&bytes).map_err(|e| fail(format!("Couldn't write the model: {e}")))?;
                    hasher.update(&bytes);
                    received += bytes.len() as u64;
                    if last_emit.elapsed().as_millis() >= 250 {
                        emit(received, "downloading");
                        last_emit = std::time::Instant::now();
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    file.flush().ok();
                    return Err(fail(format!("The download was interrupted ({e}); it resumes where it stopped")));
                }
            }
        }
        file.flush().map_err(|e| fail(e.to_string()))?;
    }

    emit(received, "verifying");
    let digest = hex(&hasher.finalize());
    if received != model.size || digest != model.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(AiError::new(
            "CHECKSUM_MISMATCH",
            format!("The downloaded file doesn't match the published checksum ({} bytes, sha256 {digest}); it was deleted, so try again", received),
        ));
    }
    std::fs::rename(&part, &done).map_err(|e| fail(e.to_string()))?;
    Ok(true)
}

/// Starts (or resumes) downloading a catalog model; progress arrives as `ai://download` events.
#[tauri::command]
pub async fn ai_download(app: AppHandle, id: String) -> Result<(), String> {
    let model = catalog_entry(&id).ok_or_else(|| AiError::new("DOWNLOAD_FAILED", format!("Unknown model {id}")))?;
    let (stop, discard) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    {
        let mut running = lock(downloads());
        if running.contains_key(&id) {
            return Ok(());
        }
        running.insert(id.clone(), Download { stop: stop.clone(), discard: discard.clone() });
    }
    tauri::async_runtime::spawn(async move {
        let result = download(&app, model, &stop).await;
        lock(downloads()).remove(model.id);
        let part = models_dir().join(format!("{}.gguf.part", model.id));
        let (status, error) = match result {
            Ok(true) => ("done", None),
            Ok(false) if discard.load(Ordering::Relaxed) => {
                let _ = std::fs::remove_file(&part);
                ("cancelled", None)
            }
            Ok(false) => ("paused", None),
            Err(e) => {
                crate::logging::write(&format!("model download failed: {}: {}", e.code, e.message));
                ("error", Some(e))
            }
        };
        let received = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let _ = app.emit("ai://download", Progress { id: model.id.into(), received, total: model.size, status, error });
    });
    Ok(())
}

/// Pauses a download (keeping what's downloaded) or, with `discard`, cancels it and deletes the part.
#[tauri::command]
pub fn ai_download_stop(id: String, discard: bool) {
    match lock(downloads()).get(&id) {
        Some(d) => {
            d.discard.store(discard, Ordering::Relaxed);
            d.stop.store(true, Ordering::Relaxed);
        }
        None if discard => {
            if valid_id(&id) {
                let _ = std::fs::remove_file(models_dir().join(format!("{id}.gguf.part")));
            }
        }
        None => {}
    }
}

#[tauri::command]
pub async fn ai_delete_model(id: String) -> Result<(), String> {
    let path = model_path(&id).ok_or("Model not found")?;
    super::server::stop_if_using(&id).await;
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Copies a GGUF file into the models folder; returns its id.
#[tauri::command]
pub async fn ai_import_model(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let mut magic = [0u8; 4];
    std::fs::File::open(&src).and_then(|mut f| f.read_exact(&mut magic)).map_err(|e| format!("{path}: {e}"))?;
    if &magic != b"GGUF" {
        return Err("That isn't a GGUF model file".into());
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let id: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c.to_ascii_lowercase() } else { '-' }).collect();
    let id = id.trim_matches(|c| c == '-' || c == '.').to_owned();
    if !valid_id(&id) {
        return Err("Couldn't derive a name from the file name".into());
    }
    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{id}.gguf"));
    if dest.exists() {
        return Err(format!("A model named {id} is already installed"));
    }
    let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    if free_space(&dir).is_some_and(|free| free < size + GB) {
        return Err("Not enough disk space to import this model".into());
    }
    let tmp = dir.join(format!("{id}.gguf.import"));
    tokio::task::spawn_blocking(move || std::fs::copy(&src, &tmp).and_then(|_| std::fs::rename(&tmp, &dest)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(id)
}
