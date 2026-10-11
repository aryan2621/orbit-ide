#!/usr/bin/env bash
# Builds a static, Metal-enabled llama-server for Apple Silicon and places it where Tauri bundles
# sidecars: src-tauri/binaries/llama-server-{aarch64,universal}-apple-darwin.
#
#   scripts/build-llama-server.sh            # pinned tag below
#   LLAMA_TAG=b11552 scripts/build-llama-server.sh
#
# Needs Xcode command-line tools, cmake and git. The result has no dylib dependencies beyond the
# system frameworks, and the Metal shaders are embedded, so it runs from inside the app bundle.
set -euo pipefail

LLAMA_TAG="${LLAMA_TAG:-v0.6.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$ROOT/.build/llama.cpp}"
OUT="$ROOT/src-tauri/binaries/llama-server-aarch64-apple-darwin"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: llama-server for Orbit is built on macOS" >&2
  exit 1
fi
command -v cmake >/dev/null || { echo "error: cmake not found (brew install cmake)" >&2; exit 1; }

if [[ -d "$WORK/.git" ]]; then
  git -C "$WORK" fetch --depth 1 origin "refs/tags/$LLAMA_TAG:refs/tags/$LLAMA_TAG"
else
  rm -rf "$WORK"
  git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp.git "$WORK"
fi
git -C "$WORK" checkout --quiet "$LLAMA_TAG"

cmake -S "$WORK" -B "$WORK/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF \
  -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16 \
  -DLLAMA_CURL=OFF \
  -DLLAMA_OPENSSL=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON
cmake --build "$WORK/build" --config Release --target llama-server -j "$(sysctl -n hw.ncpu)"

mkdir -p "$(dirname "$OUT")"
cp "$WORK/build/bin/llama-server" "$OUT"
strip -x "$OUT" || true
chmod +x "$OUT"

# Only system libraries should remain.
if otool -L "$OUT" | tail -n +2 | grep -v -E '^\s*(/usr/lib/|/System/Library/)' | grep -q .; then
  echo "error: $OUT links non-system libraries:" >&2
  otool -L "$OUT" >&2
  exit 1
fi
# The universal app bundles the same arm64 binary: the AI only runs on Apple Silicon, and Intel
# Macs hide it, so an x86_64 slice would never run. Tauri looks for this name with
# `tauri build --target universal-apple-darwin`.
cp "$OUT" "$ROOT/src-tauri/binaries/llama-server-universal-apple-darwin"
echo "Built $OUT ($LLAMA_TAG, $(du -h "$OUT" | cut -f1))"
