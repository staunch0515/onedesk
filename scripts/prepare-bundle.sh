#!/bin/sh
# Prepares what the Tauri bundle needs beside the interface (macOS):
#   - onedesk-mcp as a sidecar too (round 19): src-tauri/binaries/onedesk-mcp-<target triple>
#   - the worker as a sidecar: src-tauri/binaries/onedesk-worker-<target triple>  (externalBin)
#   - the built-in plugins as resources: target/bundle-inputs/plugins/<id>/…       (no tests, no _testing)
# Usage: scripts/prepare-bundle.sh [release|debug]   (default release). Run from anywhere.
set -eu
cd "$(dirname "$0")/.."
profile="${1:-release}"
# CARGO_TARGET_DIR (a shared target folder) wins over ./target; everything below is relative to it.
tgt="${CARGO_TARGET_DIR:-target}"
triple="$(rustc -vV | sed -n 's/^host: //p')"
if [ "$profile" = release ]; then cargo build --release -p onedesk-worker -p onedesk-mcp; else cargo build -p onedesk-worker -p onedesk-mcp; fi
mkdir -p src-tauri/binaries
cp "$tgt/$profile/onedesk-worker" "src-tauri/binaries/onedesk-worker-$triple"
cp "$tgt/$profile/onedesk-mcp" "src-tauri/binaries/onedesk-mcp-$triple"
rm -rf "$tgt/bundle-inputs/plugins"
mkdir -p "$tgt/bundle-inputs/plugins"
for dir in plugins/*/; do
  name="$(basename "$dir")"
  case "$name" in _*) continue ;; esac
  [ -f "$dir/manifest.json" ] || continue
  mkdir -p "$tgt/bundle-inputs/plugins/$name"
  out="$tgt/bundle-inputs/plugins/$name"
  case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
  (cd "$dir" && find . -type f ! -name '*.test.*' ! -name '.DS_Store' | while read -r f; do
    mkdir -p "$out/$(dirname "$f")"
    cp "$f" "$out/$f"
  done)
done
echo "bundle inputs ready ($profile, $triple)"
