//! Uploads an App Bundle to a Google Play track through the Play Developer API.
//!
//! Uses the system `openssl` (to sign the service-account JWT) and `curl`, so no extra crates are
//! needed. Secrets (private key, JWT, access token) only go through files in a private temp
//! folder, never command-line arguments, and the folder is removed afterwards.

use crate::env;
use crate::process::JobCtx;
use serde_json::{json, Value};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const API: &str = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_API: &str = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";

fn base64url(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// A private (0700) temp folder, deleted on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let dir = std::env::temp_dir().join(format!("orbit-play-{}-{nanos}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|e| e.to_string())?;
        Ok(Scratch(dir))
    }

    fn write(&self, name: &str, contents: &[u8]) -> Result<PathBuf, String> {
        let path = self.0.join(name);
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e| e.to_string())?;
        f.write_all(contents).map_err(|e| e.to_string())?;
        Ok(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs curl and returns the JSON body of a 2xx response, or the API's error message.
async fn curl(ctx: &JobCtx, header: Option<&Path>, args: &[&str]) -> Result<Value, String> {
    let mut cmd = env::command("curl");
    cmd.args(["-sS", "-w", "\n%{http_code}"]);
    if let Some(h) = header {
        cmd.arg("-H").arg(format!("@{}", h.display()));
    }
    cmd.args(args);
    let (ok, out, err) = ctx.output(cmd).await;
    if !ok {
        return Err(if err.trim().is_empty() { "Network request failed".into() } else { err.trim().to_owned() });
    }
    let (body, status) = out.trim_end().rsplit_once('\n').unwrap_or(("", out.trim()));
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if status.starts_with('2') {
        Ok(value)
    } else {
        let message = value["error"]["message"].as_str().or(value["error_description"].as_str()).unwrap_or(body);
        Err(format!("HTTP {status}: {message}"))
    }
}

/// Exchanges the service account's signed JWT for an access token.
async fn access_token(ctx: &JobCtx, scratch: &Scratch, key_file: &str) -> Result<String, String> {
    let key: Value = serde_json::from_str(&std::fs::read_to_string(key_file).map_err(|e| format!("{key_file}: {e}"))?)
        .map_err(|_| "The service account key isn't valid JSON")?;
    let (Some(email), Some(private_key)) = (key["client_email"].as_str(), key["private_key"].as_str()) else {
        return Err("This JSON isn't a service account key (no client_email/private_key)".into());
    };
    let token_uri = key["token_uri"].as_str().unwrap_or("https://oauth2.googleapis.com/token");

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let header = base64url(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = json!({
        "iss": email,
        "scope": "https://www.googleapis.com/auth/androidpublisher",
        "aud": token_uri,
        "iat": now,
        "exp": now + 3600,
    });
    let signing_input = format!("{header}.{}", base64url(claims.to_string().as_bytes()));

    let pem = scratch.write("key.pem", private_key.as_bytes())?;
    let input = scratch.write("jwt-input", signing_input.as_bytes())?;
    let sig = scratch.0.join("jwt.sig");
    let mut cmd = env::command("openssl");
    cmd.args(["dgst", "-sha256", "-sign"]).arg(&pem).arg("-out").arg(&sig).arg(&input);
    let (ok, _, err) = ctx.output(cmd).await;
    if !ok {
        return Err(format!("Couldn't sign with the service account key: {}", err.trim()));
    }
    let signature = std::fs::read(&sig).map_err(|e| e.to_string())?;
    let jwt = format!("{signing_input}.{}", base64url(&signature));

    let form = scratch.write("token-form", format!("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={jwt}").as_bytes())?;
    let body = format!("@{}", form.display());
    let token = curl(ctx, None, &["-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "--data", &body, token_uri]).await?;
    token["access_token"].as_str().map(str::to_owned).ok_or_else(|| "Google didn't return an access token".into())
}

/// Uploads `aab` to `track` (internal, alpha, beta, production) as a new release and commits it.
pub async fn upload(ctx: &JobCtx, key_file: &str, package: &str, aab: &Path, track: &str, draft: bool) -> Result<String, String> {
    let scratch = Scratch::new()?;
    ctx.log("Signing in with the service account…");
    let token = access_token(ctx, &scratch, key_file).await?;
    let auth = scratch.write("auth-header", format!("Authorization: Bearer {token}").as_bytes())?;
    let auth = Some(auth.as_path());

    let edit = curl(ctx, auth, &["-X", "POST", "-H", "Content-Type: application/json", "--data", "{}", &format!("{API}/{package}/edits")]).await?;
    let edit_id = edit["id"].as_str().ok_or("Play didn't return an edit id")?.to_owned();

    ctx.log(format!("Uploading {}…", aab.file_name().unwrap_or_default().to_string_lossy()));
    let file = format!("@{}", aab.display());
    let bundle = curl(ctx, auth, &[
        "-X", "POST",
        "-H", "Content-Type: application/octet-stream",
        "--data-binary", &file,
        &format!("{UPLOAD_API}/{package}/edits/{edit_id}/bundles?uploadType=media"),
    ])
    .await?;
    let version_code = bundle["versionCode"].as_i64().ok_or("Play didn't return the bundle's version code")?;

    ctx.log(format!("Assigning version {version_code} to the {track} track…"));
    let release = json!({
        "track": track,
        "releases": [{ "versionCodes": [version_code.to_string()], "status": if draft { "draft" } else { "completed" } }],
    });
    let release = release.to_string();
    curl(ctx, auth, &["-X", "PUT", "-H", "Content-Type: application/json", "--data", &release, &format!("{API}/{package}/edits/{edit_id}/tracks/{track}")]).await?;

    curl(ctx, auth, &["-X", "POST", "-H", "Content-Type: application/json", "--data", "{}", &format!("{API}/{package}/edits/{edit_id}:commit")]).await?;
    Ok(format!("version {version_code}"))
}
