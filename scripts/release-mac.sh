#!/bin/sh
# Builds the macOS release (D463): ONE universal OneDesk.app (Apple Silicon + Intel, macOS 11.3+), signed ad-hoc
# (not notarized), a .dmg of it, the external plugins as .odplugin files, and SHA-256 checksums.
#
# Usage: scripts/release-mac.sh            (run from anywhere; needs rustup targets aarch64- and x86_64-apple-darwin)
# Output: dist/release/<version>/
#   OneDesk-<version>-macos-universal.dmg     the app, drag to Applications
#   OneDesk-<version>-macos-universal.zip     the same app as a zip (for machines that block dmg mounting)
#   plugins/<id>-<version>.odplugin           every plugin under plugins-external/ except the sample (install via the Plugin market)
#   SHA256SUMS                                checksums of all of the above
#
# The app is NOT notarized: the first start on another Mac is refused by Gatekeeper. Right-click the app → Open →
# Open once, or: xattr -dr com.apple.quarantine /Applications/OneDesk.app
set -eu
cd "$(dirname "$0")/.."
root="$PWD"
version="$(python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
tgt="${CARGO_TARGET_DIR:-$root/target}"
case "$tgt" in /*) ;; *) tgt="$root/$tgt" ;; esac
export CARGO_TARGET_DIR="$tgt"
out="$root/dist/release/$version"

sysroot="$(rustc --print sysroot)"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$HOME/.rustup=/rustup --remap-path-prefix=$sysroot=/rust --remap-path-prefix=$root=/onedesk"
export MACOSX_DEPLOYMENT_TARGET=11.3

# 1. Sidecars for both architectures, joined with lipo under the name Tauri expects for a universal build.
for arch in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --target "$arch" -p onedesk-worker -p onedesk-mcp
done
mkdir -p src-tauri/binaries
for bin in onedesk-worker onedesk-mcp; do
  lipo -create -output "src-tauri/binaries/$bin-universal-apple-darwin" \
    "$tgt/aarch64-apple-darwin/release/$bin" "$tgt/x86_64-apple-darwin/release/$bin"
done

# 2. The bundled plugins (plugins/ only; tests left out) — the same step as a normal build.
sh scripts/prepare-bundle.sh release >/dev/null

# 3. The universal app. The resource path points at the real (maybe shared) target folder.
cfg="{\"bundle\":{\"resources\":{\"../target/bundle-inputs/plugins\":null,\"$tgt/bundle-inputs/plugins\":\"plugins\"}}}"
pnpm tauri build --target universal-apple-darwin --bundles app --config "$cfg"
built="$tgt/universal-apple-darwin/release/bundle/macos/OneDesk.app"
[ -d "$built" ] || { echo "no .app at $built" >&2; exit 1; }
# Sign a clean copy on the system disk: on exFAT/network disks macOS adds `._*` files into the bundle, which
# codesign refuses ("Operation not permitted … ._Info.plist"). --norsrc --noextattr leaves them behind.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
app="$work/OneDesk.app"
ditto --norsrc --noextattr --noqtn "$built" "$app"
find "$app" -name '._*' -delete
codesign --force --deep -s - "$app"
codesign --verify --deep --strict "$app"
for f in onedesk onedesk-worker onedesk-mcp; do
  archs="$(lipo -archs "$app/Contents/MacOS/$f")"
  case "$archs" in *arm64*x86_64*|*x86_64*arm64*) echo "ok: $f is universal ($archs)" ;; *) echo "FAIL: $f is $archs" >&2; exit 1 ;; esac
done
leaks="$(for f in onedesk onedesk-worker onedesk-mcp; do strings "$app/Contents/MacOS/$f" | grep -c "/Users/" || true; done | paste -sd+ - | bc)"
[ "$leaks" = 0 ] || { echo "FAIL: $leaks build-machine paths left in binaries" >&2; exit 1; }

# 4. The release folder: made only now, because the interface build (vite) empties dist/.
rm -rf "$out"
mkdir -p "$out/plugins"

# 5. dmg (app + a link to /Applications) and zip.
stage="$work/dmg"
mkdir -p "$stage"
ditto --norsrc --noextattr "$app" "$stage/OneDesk.app"
ln -s /Applications "$stage/Applications"
# Made on the system disk, then copied: hdiutil cannot write an image straight onto an exFAT disk.
hdiutil create -quiet -volname "OneDesk $version" -srcfolder "$stage" -fs HFS+ -format UDZO "$work/OneDesk-$version-macos-universal.dmg"
hdiutil verify -quiet "$work/OneDesk-$version-macos-universal.dmg"
cp "$work/OneDesk-$version-macos-universal.dmg" "$out/"
ditto -c -k --norsrc --noextattr --keepParent "$app" "$work/OneDesk-$version-macos-universal.zip"
cp "$work/OneDesk-$version-macos-universal.zip" "$out/"

# 6. External plugins as package files (checked first; their tests ran in pnpm check).
node scripts/plugin-tool.mjs pack-all --out "$out/plugins" --skip-tests
# org.onedesk.sample is a demo for plugin authors and the tests, not a feature: it is not released.
rm -f "$out/plugins/org.onedesk.sample-"*.odplugin

# 7. Checksums.
(cd "$out" && find . -type f ! -name SHA256SUMS ! -name '._*' | sed 's|^\./||' | sort | xargs shasum -a 256 > SHA256SUMS)
# The signed app itself, for scripts/smoke-app.sh (on the system disk, outside the repository).
rm -rf "${TMPDIR:-/tmp}/onedesk-release-app" && ditto --norsrc --noextattr "$app" "${TMPDIR:-/tmp}/onedesk-release-app/OneDesk.app"
echo "signed app for smoke tests: ${TMPDIR:-/tmp}/onedesk-release-app/OneDesk.app"
echo "release ready: $out"
ls -la "$out" "$out/plugins" | grep -v " \._"
