//! Language servers for Android projects: JetBrains' kotlin-lsp (or fwcd's kotlin-language-server),
//! Eclipse jdtls for Java, and LemMinX for XML. They're started through the generic LSP bridge.

use super::project;
use crate::env;
use serde::Serialize;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

#[derive(Serialize, Debug, PartialEq)]
pub struct ServerCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Folder the server should treat as the workspace (the Gradle project, e.g. `root/android`).
    pub root: String,
    /// Shown in logs, e.g. "kotlin-lsp".
    pub name: &'static str,
}

/// (binary, args) candidates per language, in order of preference.
fn candidates(language: &str) -> &'static [(&'static str, &'static [&'static str])] {
    match language {
        "kotlin" => &[("kotlin-lsp", &["--stdio"]), ("kotlin-ls", &["--stdio"]), ("kotlin-language-server", &[])],
        "java" => &[("jdtls", &[])],
        "xml" => &[("lemminx", &[])],
        _ => &[],
    }
}

/// The first installed server for `language`, if any.
pub fn find_server(language: &str) -> Option<(&'static str, String, Vec<String>)> {
    candidates(language)
        .iter()
        .find_map(|(bin, args)| env::which(bin).map(|path| (*bin, path, args.iter().map(|a| a.to_string()).collect())))
}

/// jdtls keeps its index in a per-project data folder outside the project.
fn jdtls_data_dir(project_dir: &str) -> PathBuf {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    project_dir.hash(&mut h);
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Caches/Orbit/jdtls").join(format!("{:016x}", h.finish()))
}

/// How to start the language server for `language` (kotlin, java, xml) in an Android project.
/// None when the folder isn't a Gradle project or no server is installed.
#[tauri::command]
pub fn android_language_server(root: String, language: String) -> Option<ServerCommand> {
    let project = project::detect(&root)?;
    let (name, program, mut args) = find_server(&language)?;
    if name == "jdtls" {
        args.push("-data".into());
        args.push(jdtls_data_dir(&project.path).to_string_lossy().into_owned());
    }
    Some(ServerCommand { program, args, root: project.path, name })
}

/// Where the setup step installs fwcd's kotlin-debug-adapter.
pub fn debug_adapter_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Application Support/Orbit/kotlin-debug-adapter")
}

/// The Kotlin/Java debug adapter (DAP over stdio; attaches to the app's JDWP port and maps
/// breakpoints in .kt and .java files). Installed by the setup wizard, or found on PATH.
pub fn debug_adapter() -> Option<(String, Vec<String>)> {
    let bundled = debug_adapter_dir().join("bin/kotlin-debug-adapter");
    let program = if bundled.is_file() { Some(bundled.to_string_lossy().into_owned()) } else { env::which("kotlin-debug-adapter") }?;
    Some((program, Vec::new()))
}
