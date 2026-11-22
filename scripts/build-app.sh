#!/bin/sh
# Builds OneDesk.app (release), signs it ad-hoc for this machine (no notarization) and checks what it contains.
# Usage: scripts/build-app.sh            (CARGO_TARGET_DIR may point at a shared target folder)
# Output: $CARGO_TARGET_DIR/release/bundle/macos/OneDesk.app   (default ./target/release/bundle/macos/OneDesk.app)
#
# Colleagues: the app is NOT notarized, so macOS Gatekeeper rejects a double-click the first time. Right-click the
# app → "Open" → "Open" once (or: xattr -dr com.apple.quarantine OneDesk.app). Later launches are normal.
set -eu
cd "$(dirname "$0")/.."
tgt="${CARGO_TARGET_DIR:-$PWD/target}"
case "$tgt" in /*) ;; *) tgt="$PWD/$tgt" ;; esac
export CARGO_TARGET_DIR="$tgt"
# The plugins resource path in tauri.conf.json is relative to src-tauri; point it at the real (maybe shared) target.
cfg="{\"bundle\":{\"resources\":{\"$tgt/bundle-inputs/plugins\":\"plugins\"}}}"
pnpm tauri build --bundles app --config "$cfg"
app="$tgt/release/bundle/macos/OneDesk.app"
[ -d "$app" ] || { echo "no .app at $app" >&2; exit 1; }
# Ad-hoc signature over the whole bundle (sidecars included).
codesign --force --deep -s - "$app"
codesign --verify --deep --strict "$app"
codesign -dv "$app" 2>&1 | sed 's/^/codesign: /'
for f in Contents/MacOS/onedesk-worker Contents/MacOS/onedesk-mcp; do
  [ -x "$app/$f" ] || { echo "missing $f" >&2; exit 1; }
done
[ -d "$app/Contents/Resources/plugins" ] || { echo "missing plugins resource" >&2; exit 1; }
echo "plugins: $(ls "$app/Contents/Resources/plugins" | wc -l | tr -d ' ')"
# Gatekeeper's verdict (expected: rejected, because it is not notarized).
spctl --assess --type execute -vv "$app" 2>&1 | sed 's/^/spctl: /' || true
echo "built $app"
