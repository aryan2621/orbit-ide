# Releasing Orbit

**GitHub Releases is the only place Orbit is distributed.** Pushing a `v*` tag runs
`.github/workflows/release.yml` on a GitHub Apple Silicon Mac. The workflow:

1. checks that the tag matches the version in `tauri.conf.json`, `package.json` and `Cargo.toml`;
2. builds `llama-server` (cached after the first run);
3. builds one universal app (Apple Silicon and Intel), ad-hoc signed;
4. publishes a GitHub Release with the DMG and, when the updater key is set, the auto-update files
   (`Orbit.app.tar.gz`, `.sig` and `latest.json`).

There's no Apple Developer account, notarization or App Store involved. Because of that, macOS blocks
Orbit the first time it's opened. Users open it once, then go to **System Settings → Privacy &
Security → Open Anyway**. The release notes explain this. Updates installed by Orbit itself don't
trigger the prompt again.

Installed copies check `https://github.com/aryan2621/orbit-ide/releases/latest/download/latest.json`
once a day and from "Orbit: Check for Updates".

## One-time setup: auto-update key (optional, free)

Without this, releases still build and download fine, but installed copies can't update themselves.

```sh
npm run tauri signer generate -- -w ~/.tauri/orbit-updater.key
```

1. Paste the public key (`~/.tauri/orbit-updater.key.pub`) into `src-tauri/tauri.conf.json` → (done for this repo)
   `plugins.updater.pubkey`, replacing `REPLACE_WITH_UPDATER_PUBLIC_KEY`, and commit it.
2. In the GitHub repo → Settings → Secrets and variables → Actions, add:
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/orbit-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you chose (leave empty if none)
3. Back up the private key. If it's lost, existing installs can't auto-update anymore.

## Each release

1. Set the new version in all three files. `npm version X.Y.Z --no-git-tag-version` updates
   `package.json` and the lockfile; edit `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` by
   hand.
2. Commit and push, then tag:
   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
3. The release appears under Releases when the workflow finishes (20–40 minutes the first time).
   It's public as soon as it's published.

A tag with a dash, like `v1.1.0-beta.1`, is published as a **pre-release**. Pre-releases aren't
offered as updates, so you can test them first.

## Building locally

```sh
scripts/build-llama-server.sh      # once; needs cmake (brew install cmake)
npm run tauri build                # this Mac's architecture
npm run tauri build -- --target universal-apple-darwin   # needs both Rust targets:
                                   # rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

## Updating llama.cpp

Change `LLAMA_TAG` in `scripts/build-llama-server.sh`, run it, and try a chat and an inline
completion. The CI cache is keyed on the script, so the next release rebuilds it.
