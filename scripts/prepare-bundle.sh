#!/bin/sh
# Prepares what the Tauri bundle needs beside the interface (macOS):
#   - onedesk-mcp as a sidecar too (round 19): src-tauri/binaries/onedesk-mcp-<target triple>
#   - the worker as a sidecar: src-tauri/binaries/onedesk-worker-<target triple>  (externalBin)
#   - the built-in plugins as resources: target/bundle-inputs/plugins/<id>/…       (no tests, no _testing)
# Usage: scripts/prepare-bundle.sh [release|debug]   (default release). Run from anywhere.
set -eu
cd "$(dirname "$0")/.."
profile="${1:-release}"
triple="$(rustc -vV | sed -n 's/^host: //p')"
if [ "$profile" = release ]; then cargo build --release -p onedesk-worker -p onedesk-mcp; else cargo build -p onedesk-worker -p onedesk-mcp; fi
mkdir -p src-tauri/binaries
cp "target/$profile/onedesk-worker" "src-tauri/binaries/onedesk-worker-$triple"
cp "target/$profile/onedesk-mcp" "src-tauri/binaries/onedesk-mcp-$triple"
rm -rf target/bundle-inputs/plugins
mkdir -p target/bundle-inputs/plugins
for dir in plugins/*/; do
  name="$(basename "$dir")"
  case "$name" in _*) continue ;; esac
  [ -f "$dir/manifest.json" ] || continue
  mkdir -p "target/bundle-inputs/plugins/$name"
  (cd "$dir" && find . -type f ! -name '*.test.*' ! -name '.DS_Store' | while read -r f; do
    mkdir -p "../../target/bundle-inputs/plugins/$name/$(dirname "$f")"
    cp "$f" "../../target/bundle-inputs/plugins/$name/$f"
  done)
done
echo "bundle inputs ready ($profile, $triple)"
