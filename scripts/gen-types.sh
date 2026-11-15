#!/bin/sh
# Generates the TS protocol types from crates/protocol (kernel-design §12).
#   sh scripts/gen-types.sh          regenerate src/workbench/protocol/generated/
#   sh scripts/gen-types.sh --check  exit 1 when the committed files are out of date
set -eu
cd "$(dirname "$0")/.."
OUT=src/workbench/protocol/generated
gen() {
  rm -rf "$1"
  TS_RS_EXPORT_DIR="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")" cargo test -q -p onedesk-protocol export_bindings >/dev/null
  ( cd "$1" && for f in *.ts; do [ "$f" = index.ts ] || echo "export type * from \"./${f%.ts}\";"; done | sort > index.ts )
}
if [ "${1:-}" = "--check" ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  gen "$TMP/generated"
  if ! diff -r "$TMP/generated" "$OUT" >/dev/null; then
    diff -r "$TMP/generated" "$OUT" | head -40
    echo "协议类型已过期：运行 pnpm gen:types 并提交" >&2; exit 1
  fi
  echo "协议类型是最新的"
else
  gen "$OUT"; echo "已生成 $OUT"
fi
