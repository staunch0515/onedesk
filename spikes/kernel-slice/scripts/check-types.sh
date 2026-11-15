#!/bin/sh
# Fails when bindings/ is not what the Rust protocol types generate right now
# (changed, missing or left-over files).
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
TS_RS_EXPORT_DIR="$tmp" cargo test -q -p ks-protocol export_bindings >/dev/null
if diff -r "$tmp" bindings >/dev/null 2>&1; then
  echo "bindings are up to date"
else
  echo "bindings are STALE - run scripts/gen-types.sh" >&2
  diff -r "$tmp" bindings >&2 || true
  exit 1
fi
