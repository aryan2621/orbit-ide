//! What this Mac can run: Apple Silicon is required (the bundled server is arm64 + Metal), and the
//! amount of memory decides the recommended model.

use serde::Serialize;

fn sysctl_u64(name: &str) -> Option<u64> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: `value` is a valid buffer of `size` bytes for the duration of the call.
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), &mut value as *mut u64 as *mut libc::c_void, &mut size, std::ptr::null_mut(), 0) };
    (rc == 0).then_some(value)
}

/// True on Apple Silicon, even when Orbit itself runs under Rosetta.
pub fn apple_silicon() -> bool {
    cfg!(target_os = "macos") && (cfg!(target_arch = "aarch64") || sysctl_u64("hw.optional.arm64").unwrap_or(0) == 1)
}

pub fn memory_bytes() -> u64 {
    sysctl_u64("hw.memsize").unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub supported: bool,
    /// Why the AI isn't available, when it isn't.
    pub reason: Option<String>,
    pub memory_gb: f64,
    pub recommended_model: Option<String>,
}

#[tauri::command]
pub fn ai_hardware() -> Hardware {
    let memory_gb = memory_bytes() as f64 / (1u64 << 30) as f64;
    if !apple_silicon() {
        return Hardware {
            supported: false,
            reason: Some("Orbit's built-in AI runs models on the Mac's GPU through Metal, which needs an Apple Silicon (M-series) Mac. Everything else in Orbit works the same on this Mac.".into()),
            memory_gb,
            recommended_model: None,
        };
    }
    let recommended = super::models::recommended(memory_bytes()).map(|m| m.id.to_owned());
    let reason = recommended.is_none().then(|| format!("This Mac has {memory_gb:.0} GB of memory; the smallest model needs 8 GB."));
    Hardware { supported: recommended.is_some(), reason, memory_gb, recommended_model: recommended }
}
