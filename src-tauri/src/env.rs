use std::sync::OnceLock;

/// Apps launched from Finder/Dock get a minimal PATH (/usr/bin:/bin:...), which hides Homebrew tools.
/// Resolve the user's login-shell PATH once and use it for every spawned tool.
pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = std::process::Command::new(shell)
            .args(["-l", "-c", "printf '__PATH__%s__PATH__' \"$PATH\""])
            .output()
            .ok()
            .and_then(|o| {
                let out = String::from_utf8_lossy(&o.stdout).into_owned();
                out.split("__PATH__").nth(1).map(str::to_owned)
            })
            .filter(|p| !p.is_empty());
        let base = from_shell.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        // Homebrew locations, in case the shell profile doesn't add them.
        let mut parts: Vec<&str> = base.split(':').filter(|p| !p.is_empty()).collect();
        for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            if !parts.contains(&extra) {
                parts.push(extra);
            }
        }
        parts.join(":")
    })
}

/// Finds an executable on the resolved PATH.
pub fn which(name: &str) -> Option<String> {
    path()
        .split(':')
        .map(|dir| format!("{dir}/{name}"))
        .find(|p| std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
}

/// A command with the resolved PATH applied.
pub fn command(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.env("PATH", path());
    cmd
}

/// Reads variables from a fresh interactive login shell, so lines just added to ~/.zshrc are seen
/// without restarting Orbit. Unset or empty variables are left out.
pub async fn shell_vars(names: &[&str]) -> std::collections::HashMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script: String = names.iter().map(|n| format!("printf '__VAR__{n}=%s\\n' \"${n}\";")).collect();
    let mut cmd = tokio::process::Command::new(shell);
    cmd.args(["-i", "-l", "-c", &script]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = match tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    };
    out.lines()
        .filter_map(|l| l.split_once("__VAR__")?.1.split_once('='))
        .filter(|(n, v)| names.contains(n) && !v.is_empty())
        .map(|(n, v)| (n.to_owned(), v.to_owned()))
        .collect()
}
