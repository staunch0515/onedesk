#!/bin/sh
# Regenerates bindings/*.ts from the Rust protocol types.
set -eu
cd "$(dirname "$0")/.."
rm -rf bindings
cargo test -q -p ks-protocol export_bindings >/dev/null
echo "generated $(find bindings -name '*.ts' | wc -l | tr -d ' ') files in bindings/"
