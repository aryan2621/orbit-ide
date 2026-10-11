# Orbit

Build, run and ship iOS and Android apps from one lightweight Mac app, without opening Xcode or
Android Studio. Orbit is a native-feeling IDE (Tauri 2 + Rust, React + Monaco) with an on-device
AI assistant.

## Features

- **Code intelligence**: Swift (sourcekit-lsp) and Kotlin (kotlin-lsp). Completion, diagnostics,
  hover, go to definition, references, rename, format, symbols.
- **Run and debug**: iOS Simulator, iPhone, Android emulator and phone, Swift packages on the Mac.
  Breakpoints, stepping, variables and a debug console (lldb-dap, kotlin-debug-adapter).
- **Tests**: run all tests or the current file, with per-test results.
- **Logs and crashes**: app console, Logcat with clickable stack frames, Simulator crash reports
  with stack traces in Problems.
- **Ship**: signing, version and build numbers, app icons, App Settings (name, permissions),
  localization (String Catalogs and `strings.xml`), a release checklist, Archive, `.ipa`/`.aab`
  export, and upload to TestFlight or Google Play.
- **Devices**: create and manage Simulators and emulators, pair Android phones over Wi-Fi, send
  test notifications, set permissions, clean status bars for screenshots.
- **Editor**: split editor, terminal tabs, Git (stage, commit, branches, diff, blame), search and
  replace across files, quick open (⌘P), command palette (⇧⌘P), auto save.
- **On-device AI** (Apple Silicon): chat about your project, Fix with AI on build errors and
  crashes, ⌘K to rewrite a selection, optional inline completions. The assistant reads code freely
  but asks before every file change, build or run, and can't run shell commands.
- **Guided setup**: Orbit checks Xcode, the Android SDK and JDK, and walks you through installing
  what's missing.

## Download

Get the latest DMG from [GitHub Releases](https://github.com/aryan2621/orbit-ide/releases/latest),
which is the only place Orbit is published. Orbit isn't notarized by Apple, so the first time you
open it, macOS blocks it: go to **System Settings → Privacy & Security** and click **Open Anyway**.
After that, Orbit updates itself.

## Requirements

- macOS 13 Ventura or later, on Apple Silicon or Intel.
- iOS: Xcode (Swift packages work with just the Command Line Tools).
- Android: a JDK and the Android SDK command-line tools. Orbit's setup can install them.
- AI: Apple Silicon. 8 GB of memory runs the small model; 16 GB or more is recommended. Models are
  2–5 GB downloads. On Intel Macs the AI features are hidden.

## Privacy

- **No telemetry, analytics or accounts.**
- **The AI runs entirely on your Mac** (llama.cpp, bundled). Your code and chats never leave it.
  Chats are stored per project in `~/Library/Application Support/com.orbit.ide/chats`.
- Orbit connects to the internet only to:
  - check GitHub Releases for updates (once a day);
  - download an AI model from Hugging Face, when you choose one;
  - download toolchains you install from Setup;
  - talk to Apple and Google when you upload a build.
- Logs stay on your Mac (`Help: Open Logs`). "Report a Problem" opens a pre-filled GitHub issue
  that you review before sending.

## Development

```sh
npm install
scripts/build-llama-server.sh   # once: builds the bundled AI server (needs cmake)
npm run tauri dev               # run with hot reload
```

Needs Node 20+, stable Rust and macOS. Check changes with:

```sh
cd src-tauri && cargo check && cd ..
npx tsc --noEmit
npm run build
```

Releases and auto-update are described in [RELEASING.md](RELEASING.md).

## Layout

```
src/                 React UI
  app/               shell: layout, activity bar, status bar, welcome, tour
  editor/            Monaco setup, editor groups, tabs, unsaved changes
  ai/                AI panel, agent loop and tools, setup, inline completions
  lsp/, debug/       language server and debugger clients
  sidebar/, panels/  explorer, search, Git, packages; terminal, build, console, logcat, problems, tests
  wizards/           setup, new project, signing, archive, settings, localization, devices
  state/             zustand stores
src-tauri/src/       Rust backend
  toolchains/ios/    xcodebuild, simctl, devicectl, signing, archive, crash reports, SwiftPM
  toolchains/android Gradle, adb, emulator, signing, Play upload
  ai/                llama-server sidecar, model downloads, chat streaming
  process.rs         cancellable jobs with streamed output
  lsp.rs             stdio bridge for language servers and debug adapters
  git.rs, workspace.rs, watcher.rs, terminal.rs, lifecycle.rs, updater.rs
```

## License

Proprietary. Free to use; see [LICENSE](LICENSE). Third-party components are listed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
