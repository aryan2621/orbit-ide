//! Release signing. Debug builds use the auto-generated `~/.android/debug.keystore`, so only
//! release builds need this. The keystore path and alias are saved per project in Orbit's app
//! data; passwords live in the macOS Keychain. They reach Gradle as `android.injected.signing.*`
//! project properties via environment variables, so neither build.gradle(.kts) nor any process's
//! arguments ever contain a secret.

use super::project;
use super::sdk;
use crate::env;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

const KEYCHAIN_SERVICE: &str = "Orbit Android keystore";

/// Non-secret signing settings for one project.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SigningConfig {
    pub keystore: String,
    pub alias: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningInfo {
    config: Option<SigningConfig>,
    /// Whether both passwords are in the Keychain.
    has_passwords: bool,
    /// Whether the project's build script already declares its own release signingConfig.
    project_signing: bool,
    /// Suggested location for a new keystore (outside the project, so it isn't committed).
    suggested_keystore: String,
    error: Option<String>,
}

fn store_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Application Support/Orbit/android-signing.json")
}

fn load_all() -> HashMap<String, SigningConfig> {
    std::fs::read_to_string(store_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_all(all: &HashMap<String, SigningConfig>) -> Result<(), String> {
    let path = store_path();
    std::fs::create_dir_all(path.parent().ok_or("Invalid settings path")?).map_err(|e| e.to_string())?;
    std::fs::write(path, serde_json::to_string_pretty(all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn load_config(project_dir: &str) -> Option<SigningConfig> {
    load_all().remove(project_dir)
}

// ---------------------------------------------------------------- Keychain (via /usr/bin/security)

fn account(keystore: &str, which: &str) -> String {
    format!("{which}:{keystore}")
}

/// Stores a password; it's written to `security -i` on stdin so it never appears in `ps`.
async fn keychain_set(account: &str, password: &str) -> Result<(), String> {
    let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    let line = format!("add-generic-password -U -a {} -s {} -w {}\n", quote(account), quote(KEYCHAIN_SERVICE), quote(password));
    let mut child = env::command("/usr/bin/security")
        .arg("-i")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Could not open the keychain")?;
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    let err = String::from_utf8_lossy(&out.stderr);
    if out.status.success() && err.trim().is_empty() {
        Ok(())
    } else {
        Err(format!("Couldn't save the password to the Keychain: {}", err.trim()))
    }
}

async fn keychain_get(account: &str) -> Option<String> {
    let out = env::command("/usr/bin/security")
        .args(["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .await
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_owned())
}

// ---------------------------------------------------------------- keytool

/// `keytool` from the JDK Gradle uses.
async fn keytool() -> Result<String, String> {
    let shell = sdk::shell_env().await;
    let jdk = sdk::find_jdk(&shell).await.ok_or("No JDK found (Setup → Android)")?;
    Ok(match jdk.home {
        Some(h) => format!("{h}/bin/keytool"),
        None => env::which("keytool").ok_or("keytool not found")?,
    })
}

/// Plain-English help for keytool and Gradle signing errors.
pub fn explain(message: &str) -> Option<&'static str> {
    let m = message.to_lowercase();
    if m.contains("password was incorrect") || m.contains("keystore was tampered with") || m.contains("get key failed") {
        Some("The keystore password is wrong. Re-enter it in Android Signing.")
    } else if m.contains("cannot recover key") {
        Some("The key password is wrong (it can differ from the keystore password). Re-enter it in Android Signing.")
    } else if m.contains("does not exist") && m.contains("alias") || m.contains("no key with alias") {
        Some("That alias isn't in this keystore. Check the alias name (keytool -list shows them).")
    } else if m.contains("keystore file") && m.contains("not found") {
        Some("The keystore file has moved or been deleted. Pick it again in Android Signing.")
    } else if m.contains("upload certificate") || m.contains("signed with the wrong key") {
        Some("Play expects the upload key you registered. Sign with that keystore, or reset the upload key in Play Console (App integrity).")
    } else {
        None
    }
}

/// Checks that `alias` exists in `keystore` and that both passwords open it.
async fn verify(keystore: &str, alias: &str, store_password: &str, key_password: &str) -> Result<(), String> {
    let keytool = keytool().await?;
    // Exporting the certificate needs the store password; a key-entry check needs the key password.
    let out = env::command(&keytool)
        .args(["-list", "-keystore", keystore, "-alias", alias, "-storepass:env", "ORBIT_STOREPASS"])
        .env("ORBIT_STOREPASS", store_password)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        let line = text.lines().find(|l| l.contains("error")).unwrap_or(text.trim()).trim().to_owned();
        return Err(explain(&line).map(str::to_owned).unwrap_or(line));
    }
    // keytool can't test a key password directly; changing it to itself does, without modifying anything else.
    let out = env::command(&keytool)
        .args(["-keypasswd", "-keystore", keystore, "-alias", alias, "-storepass:env", "ORBIT_STOREPASS", "-keypass:env", "ORBIT_KEYPASS", "-new:env", "ORBIT_KEYPASS"])
        .env("ORBIT_STOREPASS", store_password)
        .env("ORBIT_KEYPASS", key_password)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    // PKCS12 keystores (the default since JDK 9) share one password and reject -keypasswd; that's fine.
    if !out.status.success() && !text.contains("PKCS12") {
        let line = text.lines().find(|l| l.contains("error")).unwrap_or(text.trim()).trim().to_owned();
        return Err(explain(&line).map(str::to_owned).unwrap_or(line));
    }
    Ok(())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn android_signing_info(root: String) -> SigningInfo {
    let Some(project) = project::detect(&root) else {
        return SigningInfo { config: None, has_passwords: false, project_signing: false, suggested_keystore: String::new(), error: Some("No Gradle project found".into()) };
    };
    let config = load_config(&project.path);
    let has_passwords = match &config {
        Some(c) => keychain_get(&account(&c.keystore, "store")).await.is_some() && keychain_get(&account(&c.keystore, "key")).await.is_some(),
        None => false,
    };
    let script = module_scripts(&project.path).into_iter().find(|s| s.contains("com.android.application") || s.contains("android.application")).unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    SigningInfo {
        error: config.as_ref().filter(|c| !Path::new(&c.keystore).is_file()).map(|c| format!("Keystore not found: {}", c.keystore)),
        config,
        has_passwords,
        project_signing: project_signs_release(&script),
        suggested_keystore: format!("{home}/Keystores/{}-upload.jks", project.name.to_lowercase()),
    }
}

/// Distinguished-name fields for a new key's certificate.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateName {
    pub name: String,
    pub organization: Option<String>,
    pub country: Option<String>,
}

fn dname(c: &CertificateName) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace(',', "\\,");
    let mut parts = vec![format!("CN={}", esc(&c.name))];
    if let Some(o) = c.organization.as_deref().filter(|o| !o.is_empty()) {
        parts.push(format!("O={}", esc(o)));
    }
    if let Some(cc) = c.country.as_deref().filter(|c| !c.is_empty()) {
        parts.push(format!("C={}", esc(cc)));
    }
    parts.join(", ")
}

/// Creates a new upload keystore (PKCS12, RSA 2048, valid 30 years) and saves it for the project.
#[tauri::command]
pub async fn android_create_keystore(root: String, keystore: String, alias: String, password: String, certificate: CertificateName) -> Result<(), String> {
    if password.len() < 6 {
        return Err("Use a password of at least 6 characters".into());
    }
    if Path::new(&keystore).exists() {
        return Err(format!("{keystore} already exists; pick it instead of creating a new one"));
    }
    if let Some(dir) = Path::new(&keystore).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let out = env::command(&keytool().await?)
        .args(["-genkeypair", "-keystore", &keystore, "-storetype", "PKCS12", "-alias", &alias, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950"])
        .args(["-dname", &dname(&certificate), "-storepass:env", "ORBIT_STOREPASS", "-keypass:env", "ORBIT_STOREPASS"])
        .env("ORBIT_STOREPASS", &password)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    android_save_signing(root, keystore, alias, password.clone(), password).await
}

/// Saves an existing keystore for the project after checking the alias and passwords.
#[tauri::command]
pub async fn android_save_signing(root: String, keystore: String, alias: String, store_password: String, key_password: String) -> Result<(), String> {
    let project = project::detect(&root).ok_or("No Gradle project found")?;
    if !Path::new(&keystore).is_file() {
        return Err(format!("Keystore not found: {keystore}"));
    }
    verify(&keystore, &alias, &store_password, &key_password).await?;
    keychain_set(&account(&keystore, "store"), &store_password).await?;
    keychain_set(&account(&keystore, "key"), &key_password).await?;
    let mut all = load_all();
    all.insert(project.path, SigningConfig { keystore, alias });
    save_all(&all)
}

/// Build scripts of the project's top-level modules (`*/build.gradle(.kts)`), so a project whose
/// app module isn't called `app` is still found.
fn module_scripts(project_dir: &str) -> Vec<String> {
    let mut dirs: Vec<_> = std::fs::read_dir(project_dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    // `app` first, it's the usual name.
    dirs.sort_by_key(|d| d.file_name().map(|n| n != "app").unwrap_or(true));
    dirs.iter()
        .filter_map(|d| ["build.gradle.kts", "build.gradle"].iter().find_map(|f| std::fs::read_to_string(d.join(f)).ok()))
        .collect()
}

/// Whether a module's build script assigns a non-debug signing config (e.g.
/// `signingConfig = signingConfigs.getByName("release")`). Using the debug key doesn't count.
pub fn project_signs_release(script: &str) -> bool {
    script.lines().filter(|l| l.contains("signingConfig") && !l.trim_start().starts_with("//")).any(|l| {
        let Some((_, after)) = l.split_once("signingConfigs.") else { return false };
        let name: String = match after.find('"').or_else(|| after.find('\'')) {
            Some(q) if after[..q].ends_with('(') || after[..q].ends_with('[') => {
                after[q + 1..].chars().take_while(|c| *c != '"' && *c != '\'').collect()
            }
            _ => after.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect(),
        };
        !name.is_empty() && name != "debug"
    })
}

/// Environment variables that make Gradle sign release builds with the saved keystore.
/// Gradle turns `ORG_GRADLE_PROJECT_<name>` into the project property `<name>`.
pub async fn gradle_signing_env(project_dir: &str) -> Result<Vec<(String, String)>, String> {
    let config = load_config(project_dir).ok_or("No release keystore set up for this project. Open Android Signing first.")?;
    let store = keychain_get(&account(&config.keystore, "store")).await.ok_or("The keystore password isn't in the Keychain. Re-enter it in Android Signing.")?;
    let key = keychain_get(&account(&config.keystore, "key")).await.ok_or("The key password isn't in the Keychain. Re-enter it in Android Signing.")?;
    let p = |name: &str| format!("ORG_GRADLE_PROJECT_android.injected.signing.{name}");
    Ok(vec![
        (p("store.file"), config.keystore),
        (p("store.password"), store),
        (p("key.alias"), config.alias),
        (p("key.password"), key),
    ])
}
