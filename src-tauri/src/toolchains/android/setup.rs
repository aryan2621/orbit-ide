//! Detects everything Android development needs and explains how to install what's missing.
//! Like the iOS setup, nothing is installed automatically — each step comes with a command to copy.

use super::sdk::{self, MIN_JDK};
use crate::toolchains::checks::{sh_quote, step, Check, Item, Status};
use std::path::Path;

/// System image suggested when none is installed. Platforms and build tools aren't suggested:
/// once the licenses are accepted, Gradle installs whichever ones a project asks for.
const API: &str = "android-37.0";

/// JDK suggested for new installs: the newest LTS the Android Gradle plugin and Gradle 8.x/9.x all
/// support. Anything from MIN_JDK up passes the check.
const SUGGESTED_JDK: u32 = 21;

/// Command-line tools 23.0. Google links the newest build from the Android Studio download page.
const CMDLINE_TOOLS_URL: &str = if cfg!(target_os = "macos") {
    "https://dl.google.com/android/repository/commandlinetools-mac-15641748_latest.zip"
} else {
    "https://dl.google.com/android/repository/commandlinetools-linux-15641748_latest.zip"
};

/// Checks that make Orbit nicer but aren't needed to build and run: they don't block "ready".
const OPTIONAL: &[&str] = &["android-home", "language-servers", "debugger"];

/// fwcd's kotlin-debug-adapter. Its last release is from 2023, but JDWP is stable and it attaches to
/// current Android versions fine.
const DEBUG_ADAPTER_URL: &str = "https://github.com/fwcd/kotlin-debug-adapter/releases/download/0.4.4/adapter.zip";

/// The startup file the user's shell reads for new Terminal windows.
fn shell_rc() -> &'static str {
    match std::env::var("SHELL").unwrap_or_default().rsplit('/').next() {
        Some("bash") => "~/.bash_profile",
        Some("zsh") | None | Some("") => "~/.zshrc",
        _ => "~/.profile",
    }
}

/// A path for a shell command, written relative to `$HOME` when possible so it reads cleanly.
fn sh_path(path: &Path) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    match path.to_str().and_then(|p| p.strip_prefix(&home)).filter(|_| !home.is_empty()) {
        Some(rest) if rest.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) => format!("\"$HOME{rest}\""),
        _ => sh_quote(&path.to_string_lossy()),
    }
}

fn status(ok: bool) -> Status {
    if ok {
        Status::Ok
    } else {
        Status::Missing
    }
}

#[tauri::command]
pub async fn android_health() -> Vec<Item> {
    let env = sdk::shell_env().await;
    let root = sdk::sdk_root(&env);
    let path = |rel: &str| sh_path(&root.join(rel));
    let rc = shell_rc();
    let mut checks = Vec::new();

    let jdk = sdk::find_jdk(&env).await;
    let jdk_ok = jdk.as_ref().is_some_and(|j| j.major >= MIN_JDK);
    let mut steps = Vec::new();
    if let Some(java_home) = &env.java_home {
        if !jdk_ok {
            steps.push(step(
                format!("JAVA_HOME is set to {java_home}. Install JDK {SUGGESTED_JDK} below, then change the JAVA_HOME line in {rc} to:"),
                Some(format!("export JAVA_HOME=$(/usr/libexec/java_home -v {SUGGESTED_JDK})")),
            ));
        }
    }
    steps.push(step(format!("Install JDK {SUGGESTED_JDK} (Azul Zulu, free, long-term support) with Homebrew:"), Some(format!("brew install --cask zulu@{SUGGESTED_JDK}"))));
    steps.push(step(
        format!("No Homebrew? Download the JDK {SUGGESTED_JDK} installer (.dmg) from Azul, open it and follow the prompts:"),
        Some(format!("open 'https://www.azul.com/downloads/?version=java-{SUGGESTED_JDK}-lts&os=macos&package=jdk'")),
    ));
    checks.push(Check {
        id: "jdk",
        label: "Java (JDK 17+)",
        status: status(jdk_ok),
        detail: match (&jdk, &env.java_home) {
            (Some(j), _) if j.major >= 25 => format!("JDK {} — needs Gradle 9.1+; older projects may need JDK 17 or 21", j.version),
            (Some(j), _) if jdk_ok => format!("JDK {}{}", j.version, j.home.as_ref().map(|h| format!(" ({h})")).unwrap_or_default()),
            (Some(j), _) => format!("JDK {} is too old; Android builds need {MIN_JDK} or newer", j.version),
            (None, Some(h)) => format!("JAVA_HOME is set to {h}, which has no Java"),
            (None, None) => "Needed by Gradle and the Android SDK tools".into(),
        },
        steps,
    });

    let sdkmanager = sdk::cmdline_tool(&root, "sdkmanager");
    checks.push(Check {
        id: "cmdline-tools",
        label: "Android command-line tools",
        status: status(sdkmanager.is_some()),
        detail: match &sdkmanager {
            Some(p) => {
                let version = p.parent().and_then(Path::parent).and_then(sdk::revision).unwrap_or_default();
                format!("{version} ({})", root.display())
            }
            None => format!("sdkmanager and avdmanager, installed into {}", root.display()),
        },
        steps: vec![
            step(
                "Download Google's command-line tools and unzip them into the SDK folder:",
                Some(format!(
                    "mkdir -p {dir} && curl -fL {CMDLINE_TOOLS_URL} -o /tmp/cmdline-tools.zip && rm -rf /tmp/cmdline-tools && unzip -q /tmp/cmdline-tools.zip -d /tmp && rm -rf {latest} && mv /tmp/cmdline-tools {latest}",
                    dir = path("cmdline-tools"),
                    latest = path("cmdline-tools/latest"),
                )),
            ),
            step(
                format!("Or download \"Command line tools only\" yourself and unzip it so sdkmanager is at {}/cmdline-tools/latest/bin/sdkmanager:", root.display()),
                Some("open 'https://developer.android.com/studio#command-line-tools-only'".into()),
            ),
        ],
    });

    let home_ok = env.android_home.as_ref().is_some_and(|h| Path::new(h).is_dir());
    checks.push(Check {
        id: "android-home",
        label: "ANDROID_HOME",
        status: status(home_ok),
        detail: match &env.android_home {
            Some(h) if home_ok => h.clone(),
            Some(h) => format!("Set to {h}, which doesn't exist"),
            None => "Optional: Orbit finds the SDK itself; this lets gradle and adb in Terminal find it too".into(),
        },
        steps: vec![
            step(
                format!("Add the SDK and its tools to {rc}:"),
                Some(format!(
                    r#"printf '%s\n' 'export ANDROID_HOME={}' 'export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"' >> {rc}"#,
                    sh_path(&root)
                )),
            ),
            step("Open a new Terminal window so it takes effect. Orbit picks it up on the next re-check.", None),
        ],
    });

    // Everything below runs sdkmanager/avdmanager, which need the JDK and command-line tools.
    let tools_ready = jdk_ok && sdkmanager.is_some();
    let tools_reason = "Install the JDK and command-line tools first";
    let sdkmanager_sh = sdkmanager.as_deref().map(sh_path).unwrap_or_else(|| path("cmdline-tools/latest/bin/sdkmanager"));

    let licensed = root.join("licenses/android-sdk-license").is_file();
    let mut c = Check {
        id: "licenses",
        label: "SDK licenses",
        status: status(licensed),
        detail: if licensed { "Accepted".into() } else { "Not accepted yet".into() },
        steps: vec![step("Accept the Android SDK licenses:", Some(format!("yes | {sdkmanager_sh} --licenses")))],
    };
    c.block_unless(tools_ready, tools_reason);
    checks.push(c);

    // Only adb is needed up front; Gradle installs each project's platform and build tools itself.
    let adb = sdk::adb(&root);
    let platforms = sdk::packages(&root.join("platforms"));
    let mut c = Check {
        id: "packages",
        label: "SDK platform tools (adb)",
        status: status(adb.is_some()),
        detail: match &adb {
            Some(_) => {
                let version = sdk::revision(&root.join("platform-tools")).unwrap_or_default();
                match platforms.last() {
                    Some(p) => format!("Platform tools {version}; newest platform {p}"),
                    None => format!("Platform tools {version}; Gradle downloads platforms as projects need them"),
                }
            }
            None => "Installs and launches apps on emulators and phones".into(),
        },
        steps: vec![step("Install them with sdkmanager:", Some(format!("{sdkmanager_sh} \"platform-tools\"")))],
    };
    c.block_unless(tools_ready, tools_reason);
    checks.push(c);

    let emulator = sdk::emulator(&root);
    let abi = sdk::host_abi();
    let images: Vec<String> = sdk::system_images(&root).into_iter().filter(|id| id.ends_with(&format!(";{abi}"))).collect();
    let default_image = format!("system-images;{API};google_apis;{abi}");
    let mut missing = Vec::new();
    if emulator.is_none() {
        missing.push("\"emulator\"".to_owned());
    }
    if images.is_empty() {
        missing.push(format!("\"{default_image}\""));
    }
    let mut c = Check {
        id: "emulator",
        label: "Emulator and system image",
        status: status(missing.is_empty()),
        detail: if missing.is_empty() {
            format!(
                "Emulator {}, {}",
                sdk::revision(&root.join("emulator")).unwrap_or_default(),
                images.iter().map(|id| id.splitn(2, ';').nth(1).unwrap_or(id).replace(';', " ")).collect::<Vec<_>>().join(", ")
            )
        } else if emulator.is_none() {
            "Not installed (about 1 GB with a system image)".into()
        } else {
            format!("No {abi} system image installed")
        },
        steps: vec![step("Install the emulator and a system image:", Some(format!("{sdkmanager_sh} {}", missing.join(" "))))],
    };
    c.block_unless(tools_ready, tools_reason);
    checks.push(c);

    let avds = sdk::avds(&env);
    let avdmanager_sh = sdk::cmdline_tool(&root, "avdmanager")
        .as_deref()
        .map(sh_path)
        .unwrap_or_else(|| path("cmdline-tools/latest/bin/avdmanager"));
    let image = images.last().unwrap_or(&default_image);
    let mut c = Check {
        id: "avd",
        label: "Virtual device",
        status: status(!avds.is_empty()),
        detail: if avds.is_empty() { "No emulator created yet".into() } else { avds.join(", ").replace('_', " ") },
        steps: vec![step(
            "Create a Pixel 8 emulator (answer \"no\" if asked about a custom hardware profile):",
            Some(format!("{avdmanager_sh} create avd -n Pixel_8 -k \"{image}\" -d pixel_8")),
        )],
    };
    c.block_unless(tools_ready, tools_reason);
    c.block_unless(emulator.is_some() && !images.is_empty(), "Install the emulator and a system image first");
    checks.push(c);

    let kotlin = super::lsp::find_server("kotlin");
    let java = super::lsp::find_server("java");
    let mut formulas = Vec::new();
    if kotlin.is_none() {
        formulas.push("JetBrains/utils/kotlin-lsp");
    }
    if java.is_none() {
        formulas.push("jdtls");
    }
    let install = if kotlin.is_none() {
        format!("brew tap JetBrains/utils && brew install {}", formulas.join(" "))
    } else {
        format!("brew install {}", formulas.join(" "))
    };
    checks.push(Check {
        id: "language-servers",
        label: "Kotlin and Java code intelligence",
        status: status(formulas.is_empty()),
        detail: if formulas.is_empty() {
            [kotlin, java].into_iter().flatten().map(|(name, _, _)| name).collect::<Vec<_>>().join(", ")
        } else {
            "Completion, errors as you type and go to definition need kotlin-lsp and jdtls".into()
        },
        steps: vec![
            step("Install the language servers with Homebrew:", Some(install)),
            step(
                "No Homebrew? Download kotlin-lsp from its releases page, unzip it, and link kotlin-lsp.sh onto your PATH as kotlin-lsp:",
                Some("open https://github.com/Kotlin/kotlin-lsp/releases".into()),
            ),
        ],
    });

    let adapter = super::lsp::debug_adapter();
    let dir = sh_path(&super::lsp::debug_adapter_dir());
    checks.push(Check {
        id: "debugger",
        label: "Kotlin debugger",
        status: status(adapter.is_some()),
        detail: match &adapter {
            Some((program, _)) => program.clone(),
            None => "Breakpoints, stepping and variables need kotlin-debug-adapter".into(),
        },
        steps: vec![step(
            "Download the debug adapter (it works for Kotlin and Java):",
            Some(format!(
                "curl -fL {DEBUG_ADAPTER_URL} -o /tmp/kda.zip && rm -rf /tmp/kda && unzip -q /tmp/kda.zip -d /tmp/kda && mkdir -p {parent} && rm -rf {dir} && mv /tmp/kda/adapter {dir}",
                parent = sh_path(super::lsp::debug_adapter_dir().parent().unwrap_or(Path::new("/tmp"))),
            )),
        )],
    });

    checks.into_iter().map(|c| if OPTIONAL.contains(&c.id) { c.optional() } else { c.required() }).collect()
}


