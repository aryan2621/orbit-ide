//! Finds the Gradle project in a folder and lists its Android modules and build variants.
//!
//! Modules and the standard `debug`/`release` variants are read straight from the build scripts,
//! which is instant. Only projects with product flavors or custom build types ask Gradle itself
//! (through a small init script), and that answer is cached until a build script changes.

use super::sdk;
use crate::env;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Serialize, Clone, Debug)]
pub struct Project {
    /// Always "gradle"; mirrors the iOS project kinds so the UI can tell them apart.
    pub kind: &'static str,
    /// Folder containing settings.gradle(.kts) and gradlew.
    pub path: String,
    pub name: String,
}

impl Project {
    pub fn dir(&self) -> &Path {
        Path::new(&self.path)
    }
}

const SETTINGS: &[&str] = &["settings.gradle.kts", "settings.gradle"];
const BUILD_FILES: &[&str] = &["build.gradle.kts", "build.gradle"];

fn settings_file(dir: &Path) -> Option<PathBuf> {
    SETTINGS.iter().map(|f| dir.join(f)).find(|p| p.is_file())
}

fn build_file(dir: &Path) -> Option<PathBuf> {
    BUILD_FILES.iter().map(|f| dir.join(f)).find(|p| p.is_file())
}

/// The Gradle project at `root`, or in `root/android` (Flutter and React Native keep it there).
pub fn detect(root: &str) -> Option<Project> {
    let root = Path::new(root);
    let dir = [root.to_path_buf(), root.join("android")].into_iter().find(|d| settings_file(d).is_some())?;
    let settings = std::fs::read_to_string(settings_file(&dir)?).unwrap_or_default();
    let name = root_project_name(&settings)
        .unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    Some(Project { kind: "gradle", path: dir.to_string_lossy().into_owned(), name })
}

/// Which toolchain a folder needs: "android", "ios", or `None` when it's neither.
#[tauri::command]
pub fn project_platform(root: String) -> Option<&'static str> {
    if detect(&root).is_some() {
        Some("android")
    } else if crate::toolchains::ios::project::detect(&root).is_some() {
        Some("ios")
    } else {
        None
    }
}

fn root_project_name(settings: &str) -> Option<String> {
    settings.lines().find_map(|l| {
        let rest = l.trim().strip_prefix("rootProject.name")?;
        quoted(rest).into_iter().next()
    })
}

/// Every string literal in a line, single- or double-quoted.
fn quoted(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let s: String = chars.by_ref().take_while(|&d| d != c).collect();
            out.push(s);
        }
    }
    out
}

/// Gradle paths of the included modules (`:app`, `:feature:home`).
fn included_modules(settings: &str) -> Vec<String> {
    let mut modules = Vec::new();
    for line in settings.lines().map(str::trim).filter(|l| !l.starts_with("//")) {
        if line.starts_with("include(") || line.starts_with("include ") {
            for m in quoted(line) {
                let path = if m.starts_with(':') { m } else { format!(":{m}") };
                if !modules.contains(&path) {
                    modules.push(path);
                }
            }
        }
    }
    modules
}

fn module_dir(project: &Path, module: &str) -> PathBuf {
    module.trim_start_matches(':').split(':').fold(project.to_path_buf(), |p, part| p.join(part))
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum ModuleKind {
    App,
    Library,
}

fn module_kind(script: &str) -> Option<ModuleKind> {
    // Matches both `id("com.android.application")` and version-catalog aliases like `libs.plugins.android.application`.
    if script.contains("android.application") || script.contains("com.android.application") {
        Some(ModuleKind::App)
    } else if script.contains("android.library") {
        Some(ModuleKind::Library)
    } else {
        None
    }
}

/// Build scripts that declare variants beyond plain `debug`/`release`.
fn has_custom_variants(script: &str) -> bool {
    script.contains("productFlavors") || script.contains("flavorDimensions") || script.contains("create(\"") || script.contains("initWith")
}

#[derive(Serialize)]
pub struct ProjectInfo {
    project: Option<Project>,
    /// Android modules (apps and libraries), as Gradle paths without the leading colon.
    schemes: Vec<String>,
    /// Modules that produce an installable app.
    runnable: Vec<String>,
    platform: &'static str,
    /// Build variants of the first app module, e.g. `debug`, `release`, `freeDebug`.
    configurations: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn android_project_info(root: String) -> ProjectInfo {
    let empty = |project, error| ProjectInfo { project, schemes: vec![], runnable: vec![], platform: "android", configurations: vec![], error };
    let Some(project) = detect(&root) else {
        return empty(None, None);
    };
    if !project.dir().join("gradlew").is_file() {
        return empty(Some(project), Some("This project has no Gradle wrapper (gradlew). Run `gradle wrapper` in it once.".into()));
    }
    let settings = settings_file(project.dir()).and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    let mut modules = included_modules(&settings);
    if modules.is_empty() {
        // A single-module build: the root project itself is the app.
        modules.push(":".into());
    }

    let mut schemes = Vec::new();
    let mut runnable = Vec::new();
    let mut custom = false;
    for m in &modules {
        let script = build_file(&module_dir(project.dir(), m)).and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
        let Some(kind) = module_kind(&script) else { continue };
        let name = m.trim_start_matches(':').to_owned();
        if kind == ModuleKind::App {
            custom |= has_custom_variants(&script);
            runnable.push(name.clone());
        }
        schemes.push(name);
    }
    if schemes.is_empty() {
        return empty(Some(project), Some("No Android modules found (no module applies the Android Gradle plugin)".into()));
    }

    let mut configurations = vec!["debug".to_owned(), "release".to_owned()];
    let mut error = None;
    if custom {
        match gradle_variants(&project).await {
            Ok(variants) => {
                if let Some(v) = runnable.first().and_then(|m| variants.get(m)).filter(|v| !v.is_empty()) {
                    configurations = v.clone();
                }
            }
            Err(e) => error = Some(format!("Couldn't read build variants from Gradle: {e}")),
        }
    }
    ProjectInfo { project: Some(project), schemes, runnable, platform: "android", configurations, error }
}

/// Prints each Android module's variants as `ORBIT_VARIANTS <path> <a,b,c>` once Gradle has
/// configured the build. Uses the public `androidComponents` API (AGP 7+).
const VARIANTS_INIT_SCRIPT: &str = r#"
def orbitVariants = [:]
gradle.beforeProject { p ->
    ['com.android.application', 'com.android.library'].each { id ->
        p.plugins.withId(id) {
            def names = []
            orbitVariants[p.path] = names
            def components = p.extensions.getByName('androidComponents')
            components.onVariants(components.selector().all()) { v -> names << v.name }
        }
    }
}
gradle.projectsEvaluated {
    orbitVariants.each { path, names -> println "ORBIT_VARIANTS ${path} ${names.join(',')}" }
}
"#;

type Variants = HashMap<String, Vec<String>>;

/// Results per project folder, valid while no build script has changed.
static VARIANT_CACHE: Mutex<Option<HashMap<String, (Vec<SystemTime>, Variants)>>> = Mutex::new(None);

/// Modification times of the scripts that can change the variant list.
fn script_stamps(project: &Project) -> Vec<SystemTime> {
    let dir = project.dir();
    let settings = settings_file(dir).and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    let mut files: Vec<PathBuf> = SETTINGS.iter().chain(BUILD_FILES).map(|f| dir.join(f)).collect();
    files.push(dir.join("gradle/libs.versions.toml"));
    for m in included_modules(&settings) {
        files.extend(BUILD_FILES.iter().map(|f| module_dir(dir, &m).join(f)));
    }
    files.iter().map(|f| std::fs::metadata(f).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)).collect()
}

async fn gradle_variants(project: &Project) -> Result<Variants, String> {
    let stamps = script_stamps(project);
    if let Some((s, v)) = VARIANT_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&project.path) {
        if *s == stamps {
            return Ok(v.clone());
        }
    }
    let script = std::env::temp_dir().join("orbit-android-variants.gradle");
    std::fs::write(&script, VARIANTS_INIT_SCRIPT).map_err(|e| e.to_string())?;
    let mut cmd = gradlew(project, &sdk::shell_env().await).await;
    cmd.args(["-q", "--init-script"]).arg(&script).arg("help");
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| !l.trim().is_empty() && !l.starts_with("FAILURE")).unwrap_or("Gradle failed").trim().to_owned());
    }
    let variants = parse_variants(&stdout);
    VARIANT_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(project.path.clone(), (stamps, variants.clone()));
    Ok(variants)
}

fn parse_variants(stdout: &str) -> Variants {
    stdout
        .lines()
        .filter_map(|l| l.strip_prefix("ORBIT_VARIANTS "))
        .filter_map(|l| {
            let (path, names) = l.split_once(' ').unwrap_or((l, ""));
            let names = names.split(',').filter(|n| !n.is_empty()).map(str::to_owned).collect();
            Some((path.trim_start_matches(':').to_owned(), names))
        })
        .collect()
}

/// `./gradlew` in the project folder, with the SDK and a suitable JDK in its environment.
pub async fn gradlew(project: &Project, shell: &sdk::ShellEnv) -> tokio::process::Command {
    // Run through sh so a gradlew that lost its executable bit (e.g. from a zip) still works.
    let mut cmd = env::command("/bin/sh");
    cmd.arg(project.dir().join("gradlew")).arg("--console=plain").current_dir(project.dir());
    cmd.env("ANDROID_HOME", sdk::sdk_root(shell));
    if let Some(home) = sdk::find_jdk(shell).await.filter(|j| j.major >= sdk::MIN_JDK).and_then(|j| j.home) {
        cmd.env("JAVA_HOME", home);
    }
    cmd
}

/// Gradle task name for a module task, e.g. (`app`, `assemble`, `freeDebug`) → `:app:assembleFreeDebug`.
pub fn task(module: &str, verb: &str, variant: &str) -> String {
    let mut chars = variant.chars();
    let variant = chars.next().map(|c| c.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default();
    match module.trim_start_matches(':') {
        "" => format!("{verb}{variant}"),
        m => format!(":{m}:{verb}{variant}"),
    }
}

/// Finds the source file for a stack frame like `at com.example.app.MainActivity.onCreate(MainActivity.kt:14)`:
/// a file named `file` under some module's source folder whose path matches the class's package.
#[tauri::command]
pub fn android_find_source(root: String, class: String, file: String) -> Option<String> {
    let project = detect(&root)?;
    let package: Vec<&str> = class.split('.').filter(|p| p.chars().next().is_some_and(char::is_lowercase)).collect();
    let suffix: PathBuf = package.iter().collect::<PathBuf>().join(&file);
    let mut stack = vec![(project.dir().to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if path.is_dir() {
                let skip = matches!(name.to_str(), Some("build" | ".gradle" | ".idea" | ".git" | "node_modules"));
                if !skip && depth < 12 {
                    stack.push((path, depth + 1));
                }
            } else if name == file.as_str() && path.ends_with(&suffix) {
                return Some(path.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_settings() {
        let kts = "pluginManagement { }\nrootProject.name = \"Hello\"\ninclude(\":app\")\ninclude(\":core:data\", \":feature\")\n// include(\":old\")";
        assert_eq!(root_project_name(kts).as_deref(), Some("Hello"));
        assert_eq!(included_modules(kts), [":app", ":core:data", ":feature"]);
        let groovy = "rootProject.name = 'Legacy'\ninclude ':app', 'lib'";
        assert_eq!(root_project_name(groovy).as_deref(), Some("Legacy"));
        assert_eq!(included_modules(groovy), [":app", ":lib"]);
    }

    #[test]
    fn module_kinds() {
        assert_eq!(module_kind("plugins {\n  alias(libs.plugins.android.application)\n}"), Some(ModuleKind::App));
        assert_eq!(module_kind("plugins { id(\"com.android.application\") }"), Some(ModuleKind::App));
        assert_eq!(module_kind("apply plugin: 'com.android.library'"), Some(ModuleKind::Library));
        assert_eq!(module_kind("plugins { kotlin(\"jvm\") }"), None);
        assert_eq!(module_dir(Path::new("/p"), ":core:data"), Path::new("/p/core/data"));
    }

    #[test]
    fn variants_and_tasks() {
        let out = "ORBIT_VARIANTS :app freeDebug,freeRelease,paidDebug,paidRelease\nORBIT_VARIANTS :lib \nnoise";
        let v = parse_variants(out);
        assert_eq!(v["app"], ["freeDebug", "freeRelease", "paidDebug", "paidRelease"]);
        assert!(v["lib"].is_empty());
        assert_eq!(task("app", "assemble", "freeDebug"), ":app:assembleFreeDebug");
        assert_eq!(task(":", "install", "debug"), "installDebug");
    }
}

