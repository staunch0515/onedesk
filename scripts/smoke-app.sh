#!/bin/sh
# Smoke test of the built OneDesk.app (round 20). Never touches ~/Library/Application Support/onedesk*:
# it runs the app with a temporary data dir and ONEDESK_SECRET_STORE=memory (no keychain).
# Usage: scripts/smoke-app.sh [path/to/OneDesk.app]
#   default app: $CARGO_TARGET_DIR/release/bundle/macos/OneDesk.app (or ./target/…)
# Checks: version 1.0.0 · ad-hoc signature valid · worker/mcp/plugins inside · launch · main process alive ·
#   window exists (skipped with a note when macOS does not let us list windows) · mcp.sock bound ·
#   `onedesk-mcp --print-config` · killing the worker brings a new one · quit.
# Exit 0 = all passed, 1 = a check failed. Output: one "ok:" / "FAIL:" / "skip:" line per check.
set -u
tgt="${CARGO_TARGET_DIR:-$(cd "$(dirname "$0")/.." && pwd)/target}"
app="${1:-$tgt/release/bundle/macos/OneDesk.app}"
fail=0
ok()   { echo "ok: $*"; }
bad()  { echo "FAIL: $*"; fail=1; }
skip() { echo "skip: $*"; }
[ -d "$app" ] || { echo "FAIL: no app at $app"; exit 1; }
macos="$app/Contents/MacOS"

ver="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null)"
[ "$ver" = "1.0.0" ] && ok "version $ver" || bad "version is '$ver', expected 1.0.0"
codesign --verify --deep --strict "$app" 2>/dev/null && ok "ad-hoc signature valid" || bad "codesign --verify failed"
for f in onedesk-worker onedesk-mcp; do [ -x "$macos/$f" ] && ok "$f present" || bad "$f missing"; done
n="$(find "$app/Contents/Resources/plugins" -name manifest.json -maxdepth 2 2>/dev/null | wc -l | tr -d ' ')"
[ "$n" -ge 10 ] && ok "$n built-in plugins" || bad "only $n built-in plugins"
[ -f "$app/Contents/Resources/plugins/org.onedesk.welcome/manifest.json" ] && ok "welcome plugin present" || bad "welcome plugin missing"

# A short path: socket paths are limited to ~100 bytes.
data="$(mktemp -d /tmp/od-smoke.XXXXXX)"
cleanup() { [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null; rm -rf "$data"; }
trap cleanup EXIT
export ONEDESK_DATA_DIR="$data" ONEDESK_SECRET_STORE=memory
"$macos/onedesk" >"$data/app.log" 2>&1 &
pid=$!
sleep 1
kill -0 "$pid" 2>/dev/null && ok "app process started (pid $pid)" || { bad "app exited at once"; cat "$data/app.log"; exit 1; }

# The worker starts with the first window connection.
w=""
for _ in $(seq 1 40); do
  w="$(pgrep -P "$pid" -f onedesk-worker | head -1)"
  [ -n "$w" ] && break
  sleep 0.5
done
[ -n "$w" ] && ok "worker running (pid $w)" || bad "no worker child within 20 s"

win="$(OD_PID="$pid" osascript -l JavaScript -e '
ObjC.import("CoreGraphics"); ObjC.import("Foundation");
var pid = parseInt($.NSProcessInfo.processInfo.environment.objectForKey("OD_PID").js);
var l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
var n = 0;
l.forEach(function (w) { if (w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 300) n++; });
n' 2>/dev/null)"
case "$win" in
  "") skip "window check could not run (osascript/CoreGraphics unavailable)" ;;
  0) bad "no on-screen window" ;;
  *) ok "$win window(s) on screen" ;;
esac

sock="$data/mcp.sock"
for _ in $(seq 1 20); do [ -S "$sock" ] && break; sleep 0.5; done
[ -S "$sock" ] && ok "mcp.sock bound" || bad "mcp.sock missing"
"$macos/onedesk-mcp" --print-config 2>/dev/null | python3 -c 'import json,sys,os; c=json.load(sys.stdin)["mcpServers"]["onedesk"]["command"]; sys.exit(0 if os.path.isfile(c) else 1)' \
  && ok "onedesk-mcp --print-config points at an existing file" || bad "onedesk-mcp --print-config"

# Crash recovery: kill the worker; the host must start a new one.
if [ -n "$w" ]; then
  kill -9 "$w"
  w2=""
  for _ in $(seq 1 40); do
    w2="$(pgrep -P "$pid" -f onedesk-worker | head -1)"
    [ -n "$w2" ] && [ "$w2" != "$w" ] && break
    w2=""; sleep 0.5
  done
  [ -n "$w2" ] && ok "worker restarted (pid $w2)" || bad "worker not restarted within 20 s"
  kill -0 "$pid" 2>/dev/null && ok "app survived the worker crash" || bad "app died with the worker"
fi

kill "$pid" 2>/dev/null
for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$pid" 2>/dev/null; then bad "app did not quit"; kill -9 "$pid"; else ok "app quit"; fi
pid=""
sleep 1
[ -z "$(pgrep -f "$macos/onedesk-worker")" ] && ok "no worker left behind" || bad "worker left behind"
exit "$fail"
