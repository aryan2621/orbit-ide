//! "Invisible Xcode": detects everything iOS development needs and explains how to install
//! what's missing. Nothing is installed automatically — each step comes with a command to copy.

use crate::env;
use crate::toolchains::checks::{sh_quote, step, Check, Status};
use std::path::Path;

/// (binary, Homebrew formula)
const HELPER_TOOLS: &[(&str, &str)] = &[
    ("xcbeautify", "xcbeautify"),
    ("xcodegen", "xcodegen"),
    ("xcode-build-server", "xcode-build-server"),
];

/// Official xcodes release. Its Homebrew formula has no bottle for current macOS and building it
/// from source needs full Xcode, so the instructions download the signed binary instead.
const XCODES_URL: &str = "https://github.com/XcodesOrg/xcodes/releases/download/2.1.0/xcodes.zip";

async fn run(program: &str, args: &[&str], developer_dir: Option<&str>) -> Option<(bool, String)> {
    let mut cmd = env::command(program);
    cmd.args(args);
    if let Some(dir) = developer_dir {
        cmd.env("DEVELOPER_DIR", dir);
    }
    let out = cmd.output().await.ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text.trim().to_owned()))
}

/// Installed Xcode apps, newest-looking first. Prefers Spotlight, falls back to /Applications.
async fn find_xcodes() -> Vec<String> {
    let mut apps: Vec<String> = run("mdfind", &["kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'"], None)
        .await
        .map(|(_, out)| out.lines().map(str::to_owned).collect())
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir("/Applications") {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path().to_string_lossy().into_owned();
            if name.starts_with("Xcode") && name.ends_with(".app") && !apps.contains(&path) {
                apps.push(path);
            }
        }
    }
    apps.retain(|a| Path::new(a).join("Contents/Developer").is_dir());
    apps.sort();
    apps.reverse();
    apps
}

async fn xcode_version(app: &str) -> String {
    let plist = format!("{app}/Contents/Info.plist");
    run("/usr/libexec/PlistBuddy", &["-c", "Print :CFBundleShortVersionString", &plist], None)
        .await
        .map(|(_, v)| v)
        .unwrap_or_default()
}

/// The Xcode developer dir to use: the selected one if it's a full Xcode, else the first installed.
async fn developer_dir() -> (Option<String>, Option<String>) {
    let selected = run("xcode-select", &["-p"], None).await.map(|(_, p)| p).filter(|p| p.contains(".app/"));
    let chosen = match &selected {
        Some(dir) => Some(dir.clone()),
        None => find_xcodes().await.first().map(|a| format!("{a}/Contents/Developer")),
    };
    (selected, chosen)
}

#[tauri::command]
pub async fn ios_health() -> Vec<Check> {
    let mut checks = Vec::new();

    let brew = env::which("brew");
    checks.push(Check {
        id: "homebrew",
        label: "Homebrew",
        status: if brew.is_some() { Status::Ok } else { Status::Missing },
        detail: brew.clone().unwrap_or_else(|| "Package manager used to install the helper tools".into()),
        steps: vec![
            step(
                "Run the official installer in Terminal. It asks for your Mac password.",
                Some(r#"/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#.into()),
            ),
            step("Follow the \"Next steps\" it prints to add brew to your PATH, then click Re-check.", None),
        ],
    });

    let missing: Vec<&str> =
        HELPER_TOOLS.iter().filter(|(bin, _)| env::which(bin).is_none()).map(|(_, formula)| *formula).collect();
    checks.push(Check {
        id: "tools",
        label: "Helper tools",
        status: if missing.is_empty() {
            Status::Ok
        } else if brew.is_none() {
            Status::Blocked
        } else {
            Status::Missing
        },
        detail: if missing.is_empty() {
            HELPER_TOOLS.iter().map(|(b, _)| *b).collect::<Vec<_>>().join(", ")
        } else if brew.is_none() {
            "Install Homebrew first".into()
        } else {
            format!("Missing: {}", missing.join(", "))
        },
        steps: vec![step("Install them with Homebrew:", Some(format!("brew install {}", missing.join(" "))))],
    });

    let installed = find_xcodes().await;
    checks.push(Check {
        id: "xcode",
        label: "Xcode",
        status: if installed.is_empty() { Status::Missing } else { Status::Ok },
        detail: match installed.first() {
            Some(app) => format!("{} ({app})", xcode_version(app).await),
            None => "Needed for the iOS SDK and Simulator (about 40 GB with the iOS runtime)".into(),
        },
        steps: vec![
            step("Easiest: install Xcode from the Mac App Store, then click Re-check.", Some("open \"macappstore://apps.apple.com/app/id497799835\"".into())),
            step("Or download a specific version from Apple (sign in, get the .xip, double-click it, move Xcode to Applications):", Some("open https://developer.apple.com/download/all/?q=xcode".into())),
            step(
                "Or from the command line with xcodes (asks for your Apple ID and 2FA code):",
                Some(format!(
                    "mkdir -p ~/.local/bin && curl -fL {XCODES_URL} -o /tmp/xcodes.zip && ditto -x -k /tmp/xcodes.zip ~/.local/bin && ~/.local/bin/xcodes install --latest --experimental-unxip"
                )),
            ),
        ],
    });

    let (selected, dev_dir) = developer_dir().await;
    let requires_xcode = |c: &mut Check| {
        if dev_dir.is_none() {
            c.status = Status::Blocked;
            c.detail = "Install Xcode first".into();
        }
    };

    let xcode_dev_dir = installed.first().map(|a| format!("{a}/Contents/Developer"));
    let mut c = Check {
        id: "select",
        label: "Active developer directory",
        status: if selected.is_some() { Status::Ok } else { Status::Missing },
        detail: selected.clone().unwrap_or_else(|| "Command Line Tools are active instead of Xcode".into()),
        steps: vec![step(
            "Point the command line tools at Xcode (asks for your Mac password):",
            Some(format!("sudo xcode-select -s {}", sh_quote(xcode_dev_dir.as_deref().unwrap_or("/Applications/Xcode.app/Contents/Developer")))),
        )],
    };
    requires_xcode(&mut c);
    checks.push(c);

    // The commands below run against the selected Xcode, so they wait for the step above.
    let requires_selection = |c: &mut Check| {
        if c.status == Status::Missing && selected.is_none() {
            c.status = Status::Blocked;
            c.detail = "Select Xcode first".into();
        }
    };

    let dir = dev_dir.as_deref();
    let license = match dir {
        Some(d) => run("xcodebuild", &["-license", "check"], Some(d)).await.map(|(ok, _)| ok).unwrap_or(false),
        None => false,
    };
    let mut c = Check {
        id: "license",
        label: "Xcode license",
        status: if license { Status::Ok } else { Status::Missing },
        detail: if license { "Accepted".into() } else { "Not accepted yet".into() },
        steps: vec![step("Accept the license (asks for your Mac password):", Some("sudo xcodebuild -license accept".into()))],
    };
    requires_xcode(&mut c);
    requires_selection(&mut c);
    checks.push(c);

    let first_launch = match dir {
        Some(d) => run("xcodebuild", &["-checkFirstLaunchStatus"], Some(d)).await.map(|(ok, _)| ok).unwrap_or(false),
        None => false,
    };
    let mut c = Check {
        id: "firstlaunch",
        label: "Xcode components",
        status: if first_launch { Status::Ok } else { Status::Missing },
        detail: if first_launch { "Installed".into() } else { "First-launch packages not installed".into() },
        steps: vec![step("Install the packages Xcode normally installs on first launch:", Some("sudo xcodebuild -runFirstLaunch".into()))],
    };
    requires_xcode(&mut c);
    requires_selection(&mut c);
    checks.push(c);

    let runtimes = match dir {
        Some(d) => ios_runtimes(d).await,
        None => Vec::new(),
    };
    let mut c = Check {
        id: "simulator",
        label: "iOS Simulator runtime",
        status: if runtimes.is_empty() { Status::Missing } else { Status::Ok },
        detail: if runtimes.is_empty() { "No iOS runtime installed (about 8 GB)".into() } else { runtimes.join(", ") },
        steps: vec![step("Download the iOS Simulator runtime:", Some("xcodebuild -downloadPlatform iOS".into()))],
    };
    requires_xcode(&mut c);
    requires_selection(&mut c);
    checks.push(c);

    checks
}

async fn ios_runtimes(developer_dir: &str) -> Vec<String> {
    let Some((true, out)) = run("xcrun", &["simctl", "list", "runtimes", "-j"], Some(developer_dir)).await else {
        return Vec::new();
    };
    let json: serde_json::Value = serde_json::from_str(&out).unwrap_or_default();
    json["runtimes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["isAvailable"].as_bool() == Some(true))
        .filter_map(|r| r["name"].as_str())
        .filter(|n| n.starts_with("iOS"))
        .map(str::to_owned)
        .collect()
}
