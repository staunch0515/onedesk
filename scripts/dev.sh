#!/usr/bin/env bash
# First-time install + start OneDesk in development (macOS).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "需要 Node.js 22（见 .nvmrc）"; exit 1; }
command -v pnpm >/dev/null || { echo "需要 pnpm：corepack enable"; exit 1; }
command -v cargo >/dev/null || { echo "需要 Rust stable：https://rustup.rs"; exit 1; }
node -e 'process.exit(process.versions.node.split(".")[0]==="22"?0:1)' || echo "提示：建议使用 Node.js 22（当前 $(node -v)）"
pnpm install
pnpm tauri dev
