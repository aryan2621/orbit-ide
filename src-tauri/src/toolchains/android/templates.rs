//! "New Android App": a Jetpack Compose + Material 3 app with Kotlin DSL build scripts, a version
//! catalog and the Gradle wrapper, so nothing beyond the SDK and a JDK needs to be installed.

use super::build::run_gradle;
use super::project;
use super::sdk;
use crate::process;
use std::fs;
use std::path::Path;
use tauri::AppHandle;

/// Versions that work together and run on JDK 17–25. Compose BOM 2026.09 needs compileSdk 37.
const GRADLE_WRAPPER_PROPERTIES: &str = "distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.0-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
";
const COMPILE_SDK: u32 = 37;
const TARGET_SDK: u32 = 36;

const GRADLEW: &[u8] = include_bytes!("template/gradlew");
const GRADLE_WRAPPER_JAR: &[u8] = include_bytes!("template/gradle-wrapper.jar");

fn validate_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric()) => Ok(()),
        _ => Err("Use letters and digits only, starting with a letter (e.g. MyApp)".into()),
    }
}

/// `com.example.myapp`: at least two dot-separated parts, each a Java identifier that isn't a keyword.
fn validate_package(package: &str) -> Result<(), String> {
    const KEYWORDS: &[&str] = &["package", "class", "import", "public", "private", "new", "int", "default", "native", "static", "this", "true", "false", "null", "is", "in", "object", "fun", "val", "var", "when"];
    let parts: Vec<&str> = package.split('.').collect();
    let ok = parts.len() >= 2
        && parts.iter().all(|p| {
            let mut c = p.chars();
            c.next().is_some_and(|f| f.is_ascii_lowercase()) && c.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_') && !KEYWORDS.contains(p)
        });
    if ok {
        Ok(())
    } else {
        Err("Use a lowercase reverse-domain package name, e.g. com.example.myapp".into())
    }
}

fn write(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)
}

pub fn write_template(dir: &Path, name: &str, package: &str, min_sdk: u32) -> std::io::Result<()> {
    let src = dir.join("app/src/main");
    let code = src.join("java").join(package.replace('.', "/"));

    write(&dir.join("settings.gradle.kts"), format!(r#"pluginManagement {{
    repositories {{
        google()
        mavenCentral()
        gradlePluginPortal()
    }}
}}
dependencyResolutionManagement {{
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {{
        google()
        mavenCentral()
    }}
}}

rootProject.name = "{name}"
include(":app")
"#))?;

    write(&dir.join("build.gradle.kts"), r#"plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
"#)?;

    write(&dir.join("gradle.properties"), "org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nkotlin.code.style=official\n")?;

    write(&dir.join("gradle/libs.versions.toml"), r#"[versions]
agp = "9.4.1"
kotlin = "2.4.21"
composeBom = "2026.09.00"
activityCompose = "1.13.0"
coreKtx = "1.19.1"
lifecycle = "2.11.0"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }
androidx-lifecycle-runtime-ktx = { group = "androidx.lifecycle", name = "lifecycle-runtime-ktx", version.ref = "lifecycle" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }
androidx-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
androidx-material3 = { group = "androidx.compose.material3", name = "material3" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
"#)?;

    write(&dir.join("gradle/wrapper/gradle-wrapper.properties"), GRADLE_WRAPPER_PROPERTIES)?;
    write(&dir.join("gradle/wrapper/gradle-wrapper.jar"), GRADLE_WRAPPER_JAR)?;
    write(&dir.join("gradlew"), GRADLEW)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.join("gradlew"), fs::Permissions::from_mode(0o755))?;
    }

    write(&dir.join(".gitignore"), "*.iml\n.gradle/\n/local.properties\n.idea/\n.DS_Store\nbuild/\n/captures\n.externalNativeBuild/\n.cxx/\n.kotlin/\n")?;

    write(&dir.join("app/build.gradle.kts"), format!(r#"plugins {{
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}}

android {{
    namespace = "{package}"
    compileSdk = {COMPILE_SDK}

    defaultConfig {{
        applicationId = "{package}"
        minSdk = {min_sdk}
        targetSdk = {TARGET_SDK}
        versionCode = 1
        versionName = "1.0"
    }}

    buildTypes {{
        release {{
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }}
    }}
    buildFeatures {{
        compose = true
    }}
}}

dependencies {{
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    debugImplementation(libs.androidx.ui.tooling)
}}
"#))?;
    write(&dir.join("app/proguard-rules.pro"), "# Project-specific R8 rules go here.\n")?;

    write(&src.join("AndroidManifest.xml"), r#"<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
"#)?;

    write(&src.join("res/values/strings.xml"), format!("<resources>\n    <string name=\"app_name\">{name}</string>\n</resources>\n"))?;
    write(&src.join("res/values/colors.xml"), "<resources>\n    <color name=\"ic_launcher_background\">#3D5AFE</color>\n</resources>\n")?;
    // Adaptive icon (API 26+): a white rounded "app" glyph on a solid background.
    write(&src.join("res/mipmap-anydpi/ic_launcher.xml"), r#"<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
"#)?;
    write(&src.join("res/drawable/ic_launcher_foreground.xml"), r##"<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M38,38h32a4,4 0,0 1,4 4v24a4,4 0,0 1,-4 4h-32a4,4 0,0 1,-4 -4v-24a4,4 0,0 1,4 -4zM40,46v18h28v-18z" />
</vector>
"##)?;

    write(&code.join("MainActivity.kt"), format!(r#"package {package}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import {package}.ui.theme.AppTheme

class MainActivity : ComponentActivity() {{
    override fun onCreate(savedInstanceState: Bundle?) {{
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {{
            AppTheme {{
                Scaffold(modifier = Modifier.fillMaxSize()) {{ innerPadding ->
                    Greeting(name = "Android", modifier = Modifier.padding(innerPadding))
                }}
            }}
        }}
    }}
}}

@Composable
fun Greeting(name: String, modifier: Modifier = Modifier) {{
    Text(text = "Hello, $name!", modifier = modifier)
}}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {{
    AppTheme {{
        Greeting("Android")
    }}
}}
"#))?;

    write(&code.join("ui/theme/Theme.kt"), format!(r#"package {package}.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/** Material 3 theme; uses the wallpaper-based dynamic colors on Android 12+. */
@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {{
    val colorScheme = when {{
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {{
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }}
        darkTheme -> darkColorScheme()
        else -> lightColorScheme()
    }}
    MaterialTheme(colorScheme = colorScheme, content = content)
}}
"#))?;
    Ok(())
}

/// Creates `parent/name`, then runs `./gradlew help` as job `job_id` so Gradle and the
/// dependencies are downloaded before the first build. Returns the new folder.
#[tauri::command]
pub async fn android_new_project(app: AppHandle, parent: String, name: String, package: String, min_sdk: u32, job_id: String) -> Result<String, String> {
    validate_name(&name)?;
    validate_package(&package)?;
    if !(21..=COMPILE_SDK).contains(&min_sdk) {
        return Err(format!("Minimum SDK must be between 21 and {COMPILE_SDK}"));
    }
    let dir = Path::new(&parent).join(&name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    write_template(&dir, &name, &package, min_sdk).map_err(|e| e.to_string())?;

    let path = dir.to_string_lossy().into_owned();
    let project = project::detect(&path).ok_or("Template is missing settings.gradle.kts")?;
    let shell = sdk::shell_env().await;
    let mut cmd = project::gradlew(&project, &shell).await;
    cmd.arg("help");
    process::spawn_task(&app, job_id, |ctx| async move {
        ctx.log("Preparing the project (the first time, Gradle downloads itself and the Android plugin)…");
        run_gradle(&ctx, cmd).await
    });
    Ok(path)
}
