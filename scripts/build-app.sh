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
# --config is a JSON merge patch: null drops the default key from tauri.conf.json, so only one source stays.
cfg="{\"bundle\":{\"resources\":{\"../target/bundle-inputs/plugins\":null,\"$tgt/bundle-inputs/plugins\":\"plugins\"}}}"
# Keep the builder's home, checkout and cargo registry paths out of the binaries (panic messages, debug strings).
sysroot="$(rustc --print sysroot)"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$HOME/.rustup=/rustup --remap-path-prefix=$sysroot=/rust --remap-path-prefix=$PWD=/onedesk"
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
leaks="$(for f in onedesk onedesk-worker onedesk-mcp; do strings "$app/Contents/MacOS/$f" | grep -c "/Users/" || true; done | paste -sd+ - | bc)"
echo "build-machine paths left in binaries: $leaks (expected 0)"
echo "plugins: $(ls "$app/Contents/Resources/plugins" | wc -l | tr -d ' ')"
# Gatekeeper's verdict (expected: rejected, because it is not notarized).
spctl --assess --type execute -vv "$app" 2>&1 | sed 's/^/spctl: /' || true
echo "built $app"
