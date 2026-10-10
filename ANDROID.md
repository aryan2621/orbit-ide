# Orbit for Android — plan

Orbit's goal on Android is the same as on iOS: everything Android Studio does for day-to-day app work — set up the SDK, edit Kotlin with real code intelligence, build, run on an emulator or phone, debug, sign and ship — in one lightweight app, without opening Android Studio.

Android is easier than iOS in one big way: **the whole toolchain is freely redistributable and scriptable** (JDK, Android SDK command-line tools, Gradle, emulator). Nothing is locked behind a GUI app the way Xcode is, and it all runs on macOS, Windows and Linux.

## How it fits into Orbit

Android is a second toolchain next to iOS, reusing everything that's already platform-neutral:

| Already built (shared) | Android adds |
|---|---|
| Job runner with streaming logs and cancel (`process.rs`) | `toolchains/android/*` |
| LSP/DAP stdio bridge (`lsp.rs`) | Kotlin language server + JVM debug adapter |
| Build log, Problems (with hints), Console, Debug panels | Logcat panel |
| Toolbar: Run/Stop/Build, scheme + device pickers | Variants instead of schemes; emulators + phones |
| Setup wizard (instructions + copyable commands) | Android checks and commands |
| Signing panel | Keystores instead of teams/profiles |
| New Project wizard | Jetpack Compose template |

Project detection picks the toolchain: `settings.gradle(.kts)` / `gradlew` → Android; `.xcodeproj` / `.xcworkspace` / `Package.swift` → iOS. A Flutter or KMP repo with both shows both toolchains.

```
src-tauri/src/toolchains/android/
  setup.rs      checks + install commands
  sdk.rs        locate SDK/JDK, sdkmanager/avdmanager wrappers
  project.rs    detect Gradle project, modules, variants
  build.rs      gradlew tasks, diagnostic parsing, hints
  devices.rs    adb devices + AVDs, start emulator
  run.rs        build → install → launch → logcat; debug attach
  signing.rs    keystores, injected signing properties
  bundle.rs     .aab/.apk release builds, Play upload
  templates.rs  new Compose app
```

## Milestones

### A1 — Setup wizard (instructions, like iOS)
Checks, each with a command to copy:

| Check | Detected by | Command shown |
|---|---|---|
| JDK 17+ | `java -version`, `/usr/libexec/java_home -v 17` | `brew install --cask zulu@17` |
| Android command-line tools | `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager` | download link + unzip into `~/Library/Android/sdk/cmdline-tools/latest` |
| `ANDROID_HOME` | env / default `~/Library/Android/sdk` | `export ANDROID_HOME=…` line for `~/.zshrc` |
| SDK packages | `sdkmanager --list_installed` | `sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"` |
| Licenses | `$ANDROID_HOME/licenses/*` | `yes \| sdkmanager --licenses` |
| Emulator + system image | `emulator -version`, installed `system-images;…` | `sdkmanager "emulator" "system-images;android-35;google_apis;arm64-v8a"` |
| A virtual device | `avdmanager list avd` | `avdmanager create avd -n Pixel_8 -k "system-images;…" -d pixel_8` |

Same UI as iOS setup: progress bar, numbered steps, auto re-check every 5 s.

### A2 — Kotlin & Java code intelligence
- **Kotlin:** JetBrains' official `kotlin-lsp` (Gradle-aware, the same engine as IntelliJ), falling back to `fwcd/kotlin-language-server`. Started lazily like sourcekit-lsp, through the existing bridge.
- **Java:** Eclipse `jdtls`.
- **XML** (manifest, resources): LemMinX for completion/validation.
- Gradle files (`.gradle.kts`) get Kotlin support for free.

### A3 — Project model + Build
- Read modules and variants (`debug`/`release` × flavors) from `./gradlew -q projects` and a small init script that prints `applicationVariants` as JSON (faster and more reliable than parsing `tasks`).
- Toolbar: **module › variant** picker in place of scheme; Build = `./gradlew :app:assembleDebug`.
- Diagnostics: Kotlin `e: file:///path/File.kt:12:5 message`, `w: …`; javac `File.java:12: error: …`; AAPT/resource errors; manifest merger errors → Problems panel, click to jump.
- Condensed log like iOS: `> Task :app:compileDebugKotlin` → `▸ Compiling Kotlin (app)`.
- Hints for common failures: SDK license not accepted, wrong JDK (`Unsupported class file major version`), AGP/Gradle version mismatch, missing `ANDROID_HOME`, `minSdk` too low for a dependency.
- Gradle daemon kept warm between builds; `--offline` toggle; Cancel = `./gradlew --stop`-safe interrupt.

### A4 — Run on emulator & device
- Device picker: `adb devices -l` (phones, with model names) + `emulator -list-avds` (offline AVDs, started on demand with `emulator -avd NAME -no-snapshot-save`, waiting on `adb wait-for-device` + `sys.boot_completed`).
- Run: `assembleDebug` → `adb install -r -t app-debug.apk` → read launch activity from the merged manifest (`aapt2 dump badging` / `apkanalyzer manifest application-id`) → `adb shell am start -n pkg/.MainActivity`.
- **Logcat panel**: `adb logcat --pid=$(adb shell pidof -s pkg) -v color`, with level filter (V/D/I/W/E), tag search, and crash stack traces linked to source lines.
- Stop = `adb shell am force-stop pkg`.
- Wireless debugging: `adb pair` / `adb connect` helper with the pairing-code flow.

### A5 — Signing
- Debug builds use the auto-generated `~/.android/debug.keystore` — nothing to set up.
- Release: Signing panel to create a keystore (`keytool -genkeypair …`) or pick one; passwords stored in the macOS Keychain (`keyring` crate), passed to Gradle as `-Pandroid.injected.signing.store.file=…` etc. so the project's `build.gradle.kts` never needs secrets.
- Plain-English hints: wrong keystore password, alias not found, upload key vs app signing key on Play.

### A6 — Debugger
- JDWP: launch with `am start -D` (waits for debugger), `adb forward tcp:PORT jdwp:PID`, then attach.
- Debug adapter: Microsoft's `java-debug` (a jdtls plugin, DAP over the bridge) — handles Kotlin too, since both compile to JVM bytecode with line tables. Same Debug panel as iOS: breakpoints, step, call stack, variables, debug console.
- Native (NDK) code: `lldb-dap` + `lldb-server` pushed to the device (later).

### A7 — Release & Play Store
- `./gradlew :app:bundleRelease` → signed `.aab`; `assembleRelease` → `.apk`.
- Optional `bundletool build-apks --connected-device` to test the exact split APKs Play will serve.
- Upload: Google Play Developer API with a service-account JSON (internal / closed / production track, release notes), or fastlane `supply` if installed. Same "Archive" dialog as iOS with Play-specific choices.

### A8 — New project + quality of life
- **New Android App** wizard: Jetpack Compose + Material 3, Kotlin DSL, version catalog (`gradle/libs.versions.toml`), min SDK picker, package name. Ships the Gradle wrapper (`gradlew`, `gradle-wrapper.jar`, `gradle-wrapper.properties`) so no global Gradle install is needed.
- Dependencies panel: edit `libs.versions.toml` + module `dependencies {}`; check Maven Central/Google Maven for newer versions.
- Resource helpers: strings/colors/drawables browser, vector asset import from SVG (`vd-tool`), app icon generator (adaptive icon layers).
- Compose previews: no lightweight equivalent of Studio's preview renderer exists outside IntelliJ, so v1 relies on fast emulator reloads; later options are Compose hot reload (JetBrains) or a Paparazzi/Roborazzi-based snapshot runner that renders `@Preview` functions to images.

## What Android Studio has that Orbit won't (at first)
- Layout Editor / visual XML designer, Compose interactive preview.
- Profilers (CPU, memory, network, energy) — later via Perfetto traces opened in ui.perfetto.dev.
- Database/App Inspector, Layout Inspector.
- Lint UI (Gradle `lint` task results can still be shown in Problems).

## Effort estimate
| Milestone | Size |
|---|---|
| A1 Setup | 1 wk |
| A2 Code intelligence | 1–2 wk |
| A3 Build | 2 wk |
| A4 Run + Logcat | 2 wk |
| A5 Signing | 1 wk |
| A6 Debugger | 2 wk |
| A7 Release/Play | 1–2 wk |
| A8 Templates & QoL | 2 wk |

**About 3 months for one developer**, faster than iOS because the toolchain is open and every step is scriptable — and it's testable on any Mac today, with no Xcode-style blocker.

## Verification
- A1: fresh Mac user account → follow the wizard → all green.
- A3/A4: New Android App → ⌘R on a Pixel emulator → "Hello" screen, logs in Logcat; same on a USB phone.
- A6: breakpoint in `MainActivity.onCreate` hits; variables visible.
- A7: signed `.aab` passes `bundletool validate` and uploads to an internal testing track.
- Rust unit tests for every parser (adb, avdmanager, Gradle diagnostics, manifest output) using recorded fixtures.
