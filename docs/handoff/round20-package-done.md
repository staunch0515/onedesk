# 第二十轮 · 打包会话完成记录（r20-package）

## 做了什么
1. **版本号 1.0.0**：`Cargo.toml`（workspace，各 crate 继承）、`package.json`、`src-tauri/tauri.conf.json`；`Cargo.lock` 随之更新。
2. **`scripts/build-app.sh`**：`pnpm tauri build --bundles app`（`--config` 把 plugins 资源路径改成共享 target 的绝对路径）→ `codesign --force --deep -s -`（ad-hoc，不公证）→ `codesign --verify --deep --strict` / `-dv` → 检查 sidecar、插件资源 → `spctl --assess`。产物：`$CARGO_TARGET_DIR/release/bundle/macos/OneDesk.app`。
   `scripts/prepare-bundle.sh` 改为遵守 `CARGO_TARGET_DIR`（原来写死 `./target`）。
3. **迁移升级测试**：新增 `crates/kernel/tests/migration_upgrade.rs`（只新增测试文件，未改内核源码）：迁移文件与 `MIGRATIONS` 一一对应且按序；对 1..=14 每个版本造库（临时目录），经 `Workspace::open` 升到最新，`schema_version`、再次打开、`integrity_check` 均通过。
4. **`scripts/smoke-app.sh [app路径]`**：临时数据目录 `/tmp/od-smoke.*` + `ONEDESK_DATA_DIR` + `ONEDESK_SECRET_STORE=memory`；检查版本、签名、worker/mcp/插件齐全、启动、worker 子进程、窗口（osascript/CoreGraphics）、`mcp.sock`、`onedesk-mcp --print-config` 指向存在的文件、kill -9 worker 后自动重启且 app 存活、退出且不留 worker。每项一行 `ok:/FAIL:/skip:`，失败退出码 1。
5. **欢迎页**：已有——`plugins/org.onedesk.welcome`（`startup: true` 页面，en/zh/ja 语言文件齐）+ 外壳 `openStartupPage`（无标签时打开一次，D382）。**未改 `src/workbench`，没有新增 i18n 键。**

## 怎么验证（本机，2026-11-22）
- `scripts/build-app.sh` 成功；`codesign -dv`：`Signature=adhoc`、`flags=0x2(adhoc)`、`TeamIdentifier=not set`；`spctl --assess`：`rejected`（未公证，预期）。
- `.app/Contents/MacOS/` 有 `onedesk`、`onedesk-worker`、`onedesk-mcp`；`Resources/plugins` 22 个内置插件。
- `scripts/smoke-app.sh <app>`：全部 ok（5 个窗口对象在屏、worker 被 kill -9 后重启出新进程、app 未退出、退出后无残留）。
- `app.mcpInfo` 的路径与 `onedesk-mcp --print-config` 用同一规则（可执行文件同目录 `onedesk-mcp`），smoke 里验证该文件存在；没有通过界面调用 `app.mcpInfo` 本身。
- `pnpm typecheck`、`pnpm lint`、`pnpm clippy`、`pnpm test:rust` 通过。

## 给用户手册（r20-docs）的话：第一次打开
没有公证，Gatekeeper 会拒绝双击（`spctl: rejected`）。同事第一次：在 Finder 里**右键 OneDesk.app → 打开 → 再点“打开”**（或终端 `xattr -dr com.apple.quarantine OneDesk.app`）。之后正常双击。

## 给 r20-tests 的接法
`scripts/smoke-app.sh` 不依赖 Playwright；在 e2e 里用 `execFile` 跑它，退出码 0 为通过，输出里的 `FAIL:` 行是失败原因。先 `CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target scripts/build-app.sh`（约 10 分钟，已构建过则可跳过）。窗口检查需要 osascript 可用，不可用时会输出 `skip:` 而不是失败。

## 没验证的
- 没有在 Finder 里真实双击/右键打开（只直接运行 `Contents/MacOS/onedesk`）；隔离属性（quarantine）场景未测。
- 未截图确认欢迎页内容在 `.app` 里的渲染；只确认了窗口存在和插件被打包。
- 崩溃重启只验证“进程恢复”；“窗口里未保存状态的提示”没有在 `.app` 窗口里操作验证。
- MCP 应用开着时通过真套接字从 Claude Desktop 连接未测（只确认 `mcp.sock` 已绑定）。
- 仅 arm64。

## 范围外
- 无内核改动需求。`Terminated` 的 shell 提示会在 smoke 输出里出现一行（无害）。

## 补：欢迎页间距（协调会话转 r20-polish 的发现）
欢迎页四个“新建 …”链接每项一个 `link` 节点，外壳把每个 `link` 画在 `Pane pad="md"` 里，所以纵向间距大。改为 `pad="sm"`（`src/workbench/parts/view-nodes.tsx`，一行，只用设计 token）。注意这是 `link` 节点的通用画法，ai/datasource/sql/link 插件里的 link 列表也同样变紧。未重新截图确认；`.app` 需重打才含此改动。
