//! Generates every app icon size from one square image, using macOS's built-in `sips`.
//!
//! iOS: a single 1024×1024 icon in AppIcon.appiconset (Xcode 14+ derives the other sizes),
//! flattened because the App Store rejects icons with transparency.
//! Android: legacy launcher PNGs for each density and, when the project uses adaptive icons,
//! a foreground layer plus a background color.

use super::{android, ios};
use crate::{env, workspace::atomic_write};
use std::path::{Path, PathBuf};

/// (density folder, legacy icon px, adaptive layer px)
const DENSITIES: &[(&str, u32, u32)] = &[
    ("mipmap-mdpi", 48, 108),
    ("mipmap-hdpi", 72, 162),
    ("mipmap-xhdpi", 96, 216),
    ("mipmap-xxhdpi", 144, 324),
    ("mipmap-xxxhdpi", 192, 432),
];

/// Share of the adaptive layer the artwork fills, so launcher masks (circle, squircle) don't clip it.
const ADAPTIVE_CONTENT: f32 = 0.62;

async fn sips(args: &[&str]) -> Result<String, String> {
    let out = env::command("sips").args(args).output().await.map_err(|e| format!("sips: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!("sips: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

async fn size_of(image: &str) -> Result<(u32, u32), String> {
    let out = sips(&["-g", "pixelWidth", "-g", "pixelHeight", image]).await?;
    let value = |key: &str| out.lines().find_map(|l| l.trim().strip_prefix(key)?.trim().parse::<u32>().ok());
    Ok((value("pixelWidth:").ok_or("Couldn't read the image")?, value("pixelHeight:").ok_or("Couldn't read the image")?))
}

async fn resize(source: &str, px: u32, out: &Path) -> Result<(), String> {
    std::fs::create_dir_all(out.parent().ok_or("Invalid icon path")?).map_err(|e| e.to_string())?;
    let px = px.to_string();
    sips(&["-s", "format", "png", "-z", &px, &px, source, "--out", &out.to_string_lossy()]).await.map(|_| ())
}

/// Moves earlier icon files that would clash with the new ones (e.g. ic_launcher.webp) to the Trash.
fn trash_others(dir: &Path, stem: &str, keep: &Path) {
    for ext in ["png", "webp", "jpg"] {
        let p = dir.join(format!("{stem}.{ext}"));
        if p != keep && p.is_file() {
            let _ = trash::delete(&p);
        }
    }
}

/// Folders worth searching for an asset catalog (skips dependencies and build output).
fn find_dir(dir: &Path, depth: usize, pred: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let skip = ["Pods", "build", "DerivedData", "node_modules", "Carthage", ".build"];
    let entries: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    if let Some(p) = entries.iter().find(|p| pred(p)) {
        return Some(p.clone());
    }
    if depth == 0 {
        return None;
    }
    entries.iter().filter(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        !name.starts_with('.') && !skip.contains(&name.as_ref())
    }).find_map(|p| find_dir(p, depth - 1, pred))
}

async fn ios_icons(root: &str, source: &str, tmp: &Path) -> Result<Vec<PathBuf>, String> {
    let project = ios::project::detect(root).ok_or("No Xcode project found")?;
    let dir = PathBuf::from(project.dir());
    let set = match find_dir(&dir, 5, &|p| p.file_name().is_some_and(|n| n == "AppIcon.appiconset")) {
        Some(set) => set,
        None => find_dir(&dir, 5, &|p| p.extension().is_some_and(|x| x == "xcassets"))
            .ok_or("No asset catalog (.xcassets) in this project to put the icon in")?
            .join("AppIcon.appiconset"),
    };
    std::fs::create_dir_all(&set).map_err(|e| e.to_string())?;
    // Flatten through JPEG: transparent areas become white.
    let jpg = tmp.join("icon.jpg");
    sips(&["-s", "format", "jpeg", "-z", "1024", "1024", source, "--out", &jpg.to_string_lossy()]).await?;
    let icon = set.join("AppIcon.png");
    sips(&["-s", "format", "png", &jpg.to_string_lossy(), "--out", &icon.to_string_lossy()]).await?;
    // Old per-size images would be left unassigned; the catalog now lists only the one icon.
    for e in std::fs::read_dir(&set).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p != icon && p.extension().is_some_and(|x| x == "png" || x == "jpg") {
            let _ = trash::delete(&p);
        }
    }
    let contents = set.join("Contents.json");
    let json = r#"{
  "images" : [
    {
      "filename" : "AppIcon.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
"#;
    atomic_write(&contents, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(vec![icon, contents])
}

async fn android_icons(root: &str, source: &str, background: &str, tmp: &Path) -> Result<Vec<PathBuf>, String> {
    let project = android::project::detect(root).ok_or("No Gradle project found")?;
    let script = android::project::app_build_script(&project).ok_or("No application module found")?;
    let res = script.parent().ok_or("No application module found")?.join("src/main/res");
    let mut written = Vec::new();

    for &(folder, px, _) in DENSITIES {
        for name in ["ic_launcher", "ic_launcher_round"] {
            let out = res.join(folder).join(format!("{name}.png"));
            resize(source, px, &out).await?;
            trash_others(&res.join(folder), name, &out);
            written.push(out);
        }
    }

    let anydpi = res.join("mipmap-anydpi-v26");
    if anydpi.join("ic_launcher.xml").is_file() || anydpi.join("ic_launcher_round.xml").is_file() {
        for &(folder, _, layer) in DENSITIES {
            let content = tmp.join(format!("fg-{layer}.png"));
            resize(source, (layer as f32 * ADAPTIVE_CONTENT).round() as u32, &content).await?;
            let out = res.join(folder).join("ic_launcher_foreground.png");
            let layer = layer.to_string();
            sips(&["--padToHeightWidth", &layer, &layer, "--padColor", background, &content.to_string_lossy(), "--out", &out.to_string_lossy()]).await?;
            trash_others(&res.join(folder), "ic_launcher_foreground", &out);
            written.push(out);
        }
        let color = res.join("values/orbit_icon_background.xml");
        let xml = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<resources>\n    <color name=\"orbit_icon_background\">#{background}</color>\n</resources>\n");
        atomic_write(&color, xml.as_bytes()).map_err(|e| e.to_string())?;
        written.push(color);
        let adaptive = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<adaptive-icon xmlns:android=\"http://schemas.android.com/apk/res/android\">\n    <background android:drawable=\"@color/orbit_icon_background\" />\n    <foreground android:drawable=\"@mipmap/ic_launcher_foreground\" />\n</adaptive-icon>\n";
        for name in ["ic_launcher.xml", "ic_launcher_round.xml"] {
            let p = anydpi.join(name);
            atomic_write(&p, adaptive.as_bytes()).map_err(|e| e.to_string())?;
            written.push(p);
        }
    }
    Ok(written)
}

/// Writes the app icons for the project's platform(s) and returns the files written.
/// `background` is the adaptive-icon background as RRGGBB.
#[tauri::command]
pub async fn generate_app_icons(root: String, source: String, background: String) -> Result<Vec<String>, String> {
    let background = background.trim_start_matches('#').to_uppercase();
    if background.len() != 6 || !background.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The background color must be like #FFFFFF".into());
    }
    let (w, h) = size_of(&source).await?;
    if w != h {
        return Err(format!("The image must be square (it's {w}×{h})"));
    }
    if w < 512 {
        return Err(format!("The image should be at least 1024×1024 (it's {w}×{h})"));
    }
    let has_android = android::project::detect(&root).is_some();
    let has_ios = ios::project::detect(&root).is_some();
    if !has_android && !has_ios {
        return Err("No iOS or Android project in this folder".into());
    }

    let tmp = std::env::temp_dir().join(format!("orbit-icons-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = async {
        let mut written = Vec::new();
        if has_ios {
            written.extend(ios_icons(&root, &source, &tmp).await?);
        }
        if has_android {
            written.extend(android_icons(&root, &source, &background, &tmp).await?);
        }
        Ok::<_, String>(written)
    }
    .await;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(result?.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}
