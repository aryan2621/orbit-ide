//! Code signing: teams from the Keychain, the app target's current signing settings, the xcodebuild
//! arguments that apply the user's choices, and plain-English explanations of signing failures.

use super::{build, project};
use crate::env;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Team {
    pub id: String,
    pub name: String,
}

/// The user's signing choices, sent with each device build.
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SigningOptions {
    pub team_id: Option<String>,
    pub api_key: Option<ApiKey>,
}

/// App Store Connect API key: lets xcodebuild create certificates and profiles without an
/// Apple account signed into Xcode.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub path: String,
    pub key_id: String,
    pub issuer_id: String,
}

impl SigningOptions {
    /// Arguments for a build that needs signing (device runs, archives).
    pub fn xcodebuild_args(&self) -> Vec<String> {
        let mut args = vec!["-allowProvisioningUpdates".to_owned()];
        if let Some(team) = self.team_id.as_deref().filter(|t| !t.is_empty()) {
            args.push(format!("DEVELOPMENT_TEAM={team}"));
            args.push("CODE_SIGN_STYLE=Automatic".into());
        }
        if let Some(key) = &self.api_key {
            args.extend([
                "-authenticationKeyPath".into(),
                key.path.clone(),
                "-authenticationKeyID".into(),
                key.key_id.clone(),
                "-authenticationKeyIssuerID".into(),
                key.issuer_id.clone(),
            ]);
        }
        args
    }
}

/// Splits an RFC 2253 subject (`UID=x,CN=Apple Development: A (B),OU=TEAM,O=Name\, Inc,C=US`)
/// into key/value pairs, honouring `\,` escapes.
fn subject_fields(subject: &str) -> Vec<(String, String)> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = subject.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ',' => fields.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    fields.push(current);
    fields
        .into_iter()
        .filter_map(|f| f.split_once('=').map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())))
        .collect()
}

/// A team from an Apple signing certificate's subject (OU = team id, O = team name).
pub fn team_from_subject(subject: &str) -> Option<Team> {
    let fields = subject_fields(subject.trim().trim_start_matches("subject=").trim());
    let get = |k: &str| fields.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    let cn = get("CN")?;
    let apple = ["Apple Development", "Apple Distribution", "iPhone Developer", "iPhone Distribution"];
    if !apple.iter().any(|p| cn.starts_with(p)) {
        return None;
    }
    Some(Team { id: get("OU")?, name: get("O").unwrap_or_else(|| cn.clone()) })
}

async fn keychain_teams() -> Vec<Team> {
    let Ok(out) = env::command("security").args(["find-identity", "-v", "-p", "codesigning"]).output().await else {
        return vec![];
    };
    let names: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split_once('"').and_then(|(_, rest)| rest.rsplit_once('"')).map(|(name, _)| name.to_owned()))
        .collect();

    let mut teams: Vec<Team> = Vec::new();
    for name in names {
        let Ok(pem) = env::command("security").args(["find-certificate", "-a", "-p", "-c", &name]).output().await else {
            continue;
        };
        let pem = String::from_utf8_lossy(&pem.stdout).into_owned();
        for cert in pem.split_inclusive("-----END CERTIFICATE-----").filter(|c| c.contains("BEGIN CERTIFICATE")) {
            let mut cmd = env::command("openssl");
            cmd.args(["x509", "-noout", "-subject", "-nameopt", "RFC2253"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped());
            let Ok(mut child) = cmd.spawn() else { continue };
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(cert.trim().as_bytes()).await;
            }
            let Ok(out) = child.wait_with_output().await else { continue };
            if let Some(team) = team_from_subject(&String::from_utf8_lossy(&out.stdout)) {
                if !teams.iter().any(|t| t.id == team.id) {
                    teams.push(team);
                }
            }
        }
    }
    teams
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningInfo {
    target: Option<String>,
    bundle_id: Option<String>,
    /// DEVELOPMENT_TEAM as configured in the project.
    project_team: Option<String>,
    sign_style: Option<String>,
    teams: Vec<Team>,
    /// project.yml exists, so settings can be saved into the project.
    xcodegen: bool,
    error: Option<String>,
}

fn app_settings(settings: &Value) -> Option<&Value> {
    settings.as_array()?.iter().find(|t| t["buildSettings"]["WRAPPER_EXTENSION"].as_str() == Some("app"))
}

#[tauri::command]
pub async fn ios_signing_info(root: String, scheme: String, configuration: String) -> SigningInfo {
    let teams = keychain_teams().await;
    let project = project::detect(&root);
    let xcodegen = project.as_ref().map(|p| Path::new(&p.dir()).join("project.yml").exists()).unwrap_or(false);
    let mut info = SigningInfo { target: None, bundle_id: None, project_team: None, sign_style: None, teams, xcodegen, error: None };
    let Some(project) = project else {
        info.error = Some("No Xcode project found".into());
        return info;
    };

    let mut cmd = build::xcodebuild_command(&project, &scheme, &configuration, "generic/platform=iOS");
    cmd.args(["-showBuildSettings", "-json"]);
    let out = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            info.error = Some(e.to_string());
            return info;
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let json: Value = stdout.find('[').and_then(|i| serde_json::from_str(&stdout[i..]).ok()).unwrap_or_default();
    match app_settings(&json) {
        Some(t) => {
            let s = &t["buildSettings"];
            let get = |k: &str| s[k].as_str().filter(|v| !v.is_empty()).map(str::to_owned);
            info.target = t["target"].as_str().map(str::to_owned);
            info.bundle_id = get("PRODUCT_BUNDLE_IDENTIFIER");
            info.project_team = get("DEVELOPMENT_TEAM");
            info.sign_style = get("CODE_SIGN_STYLE");
        }
        None => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            info.error = Some(if stderr.contains("requires Xcode") {
                "Xcode is required to read signing settings.".into()
            } else {
                "This scheme doesn't build an iOS app.".into()
            });
        }
    }
    info
}

/// Rewrites the `PRODUCT_BUNDLE_IDENTIFIER` and `DEVELOPMENT_TEAM` of an XcodeGen target and
/// regenerates the project.
#[tauri::command]
pub async fn ios_save_signing(root: String, target: String, bundle_id: String, team_id: String) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Xcode project found")?;
    let yml_path = Path::new(&project.dir()).join("project.yml");
    let yml = std::fs::read_to_string(&yml_path).map_err(|e| e.to_string())?;
    let updated = set_target_settings(&yml, &target, &[("PRODUCT_BUNDLE_IDENTIFIER", &bundle_id), ("DEVELOPMENT_TEAM", &team_id)])
        .ok_or("Couldn't find this target's settings in project.yml; edit it by hand.")?;
    std::fs::write(&yml_path, updated).map_err(|e| e.to_string())?;

    let xcodegen = env::which("xcodegen").ok_or("XcodeGen is not installed")?;
    let out = env::command(&xcodegen).arg("generate").current_dir(project.dir()).output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(())
}

/// Sets keys under `targets.<target>.settings.base` in a project.yml written in the layout Orbit
/// generates (and XcodeGen's docs use). Returns None if that block isn't found.
pub fn set_target_settings(yml: &str, target: &str, values: &[(&str, &str)]) -> Option<String> {
    let lines: Vec<&str> = yml.lines().collect();
    let target_line = lines.iter().position(|l| l.trim_end() == format!("  {target}:"))?;
    let indent = |l: &str| l.len() - l.trim_start().len();
    // The target block ends at the next line indented 2 or less.
    let end = (target_line + 1..lines.len())
        .find(|&i| !lines[i].trim().is_empty() && indent(lines[i]) <= 2)
        .unwrap_or(lines.len());
    let base = (target_line..end).find(|&i| lines[i].trim() == "base:")?;
    let key_indent = " ".repeat(indent(lines[base]) + 2);

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let mut insert_at = base + 1;
    for (key, value) in values {
        let existing = (base + 1..end).find(|&i| out[i].trim_start().starts_with(&format!("{key}:")));
        let line = format!("{key_indent}{key}: {value}");
        match existing {
            Some(i) => out[i] = line,
            None if value.is_empty() => {}
            None => {
                out.insert(insert_at, line);
                insert_at += 1;
            }
        }
    }
    let mut s = out.join("\n");
    if yml.ends_with('\n') {
        s.push('\n');
    }
    Some(s)
}

/// Plain-English help for the signing and device errors people hit most.
pub fn explain(message: &str) -> Option<&'static str> {
    let m = message.to_lowercase();
    let rules: &[(&[&str], &str)] = &[
        (&["requires a development team"], "Choose your team in Signing (toolbar → key icon)."),
        (&["no account for team", "no accounts"], "xcodebuild has no Apple account for this team. Add an App Store Connect API key in Signing, or sign in once in Xcode → Settings → Accounts."),
        (&["no profiles for", "no provisioning profiles"], "No provisioning profile exists yet. Pick your team in Signing; Orbit lets xcodebuild create one automatically (needs an API key or an Apple account in Xcode)."),
        (&["failed registering bundle identifier", "is not available"], "That bundle ID is already taken by someone else. Change it to something unique, e.g. com.yourname.appname."),
        (&["has no devices", "no devices from which"], "Your team has no registered devices. Connect your iPhone with a cable, unlock it, tap Trust, then run again."),
        (&["developer mode"], "Turn on Developer Mode on the iPhone: Settings → Privacy & Security → Developer Mode, then restart it."),
        (&["device is locked", "passcode protected"], "Unlock the iPhone and try again."),
        (&["untrusted", "not been explicitly trusted", "invalid code signature"], "On the iPhone, go to Settings → General → VPN & Device Management and trust your developer certificate."),
        (&["certificate", "revoked"], "Your signing certificate is missing or revoked. Let xcodebuild create a new one by running again with your team selected (needs an API key or an Apple account in Xcode)."),
    ];
    rules.iter().find(|(needles, _)| needles.iter().any(|n| m.contains(n))).map(|(_, hint)| *hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_team_from_certificate_subject() {
        let t = team_from_subject(
            "subject=UID=ABC,CN=Apple Development: Jane Doe (Q1W2E3R4T5),OU=TEAM123456,O=Acme\\, Inc,C=US",
        )
        .unwrap();
        assert_eq!(t, Team { id: "TEAM123456".into(), name: "Acme, Inc".into() });
        assert!(team_from_subject("subject=CN=Local Dev Signing").is_none());
    }

    #[test]
    fn signing_args() {
        let o = SigningOptions {
            team_id: Some("T1".into()),
            api_key: Some(ApiKey { path: "/k.p8".into(), key_id: "K".into(), issuer_id: "I".into() }),
        };
        let a = o.xcodebuild_args();
        assert!(a.contains(&"DEVELOPMENT_TEAM=T1".to_owned()));
        assert!(a.windows(2).any(|w| w == ["-authenticationKeyID", "K"]));
        assert_eq!(SigningOptions::default().xcodebuild_args(), ["-allowProvisioningUpdates"]);
    }

    #[test]
    fn edits_xcodegen_target_settings() {
        let yml = "name: Demo\ntargets:\n  Demo:\n    type: application\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: com.example.demo\n        TARGETED_DEVICE_FAMILY: \"1,2\"\n    scheme: {}\n";
        let out = set_target_settings(yml, "Demo", &[("PRODUCT_BUNDLE_IDENTIFIER", "com.me.demo"), ("DEVELOPMENT_TEAM", "T1")]).unwrap();
        assert!(out.contains("        PRODUCT_BUNDLE_IDENTIFIER: com.me.demo\n"));
        assert!(out.contains("        DEVELOPMENT_TEAM: T1\n"));
        assert!(out.ends_with("    scheme: {}\n"));
        assert!(set_target_settings(yml, "Missing", &[]).is_none());
    }

    #[test]
    fn explains_common_errors() {
        assert!(explain("Signing for \"Demo\" requires a development team.").unwrap().contains("team"));
        assert!(explain("error: No Account for Team \"T1\"").unwrap().contains("API key"));
        assert!(explain("cannot find 'foo' in scope").is_none());
    }
}
