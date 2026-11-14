# 任务：Rust 后端（分支 phase1/rust）

**目标**：实现 `src/platform/contract.ts` 中的全部 Tauri 命令，以及数据目录、迁移、快照、钥匙串、插件扫描、导出导入，并有 Rust 测试。

**允许修改**
- `src-tauri/**`，但 `src-tauri/migrations/0001_init.sql` 只读（已定稿；不要新增迁移，本里程碑只有 0001）
- `docs/handoff/phase1-rust.md`

**只读依赖**：`src/platform/contract.ts`（命令名、参数、返回值、文件头注释中的 Rust 侧约定）、`src/kernel/contracts.ts`（AppStatus、ScannedPlugin、SqlParam）、`docs/decisions.md`（D20–D26、D52–D55、D59、D63）

**要点**
- 依赖（已在依赖表）：rusqlite（bundled）、keyring、dirs、serde、serde_json、tempfile（dev）。时间格式化尽量用标准库。
- 数据目录 `dirs::data_dir()/onedesk`（`~/Library/Application Support/onedesk/`，不是 `/Library/...`），启动时创建（含 `backups/`、`plugins/`）。
- 启动顺序：确保目录 → 若库存在且需迁移或每次启动：`VACUUM INTO backups/onedesk-YYYYMMDD-HHMMSS.db`，只留最近 7 份 → 迁移（`include_str!` 嵌入 `migrations/*.sql`，每个迁移一个事务，失败回滚并把中文错误放进 `AppStatus.migrationError`；此时数据命令一律拒绝）。
- 单连接 `Mutex<Connection>`；`db_select` 返回列名 → 值的对象数组；整数参数绑定为 INTEGER；`db_batch` 一个事务，返回每条的 rowsAffected。
- 密钥：keyring（service `onedesk`，account = 名字）；名字索引在 `secret_names` 表。密钥值不得写入日志或数据库。
- `plugins_scan`：扫描 `plugins/*/`，读 `manifest.json` 原文与入口文件（manifest 的 `main`，默认 `index.js`）；main 含 `..` 或绝对路径、规范化后越出插件目录 → 返回 error（宁可误拒）。只把 manifest 解析为 serde_json::Value 取 main，不做业务校验（业务校验在 TS）。
- `export_write`/`import_read`：按契约读写文件夹；`export_write` 创建 `attachments/` 空文件夹。
- 更新 `capabilities/default.json`（D65：opener 只放 http/https/mailto）并 `python3 -m json.tool` 校验。
- 测试（`cargo test`）：迁移从空库到最新；**迁移升级测试**：用 0001 之前的空库和“已有 0001 数据的库”再跑一次迁移，数据不丢、幂等；迁移失败回滚（用测试专用的坏迁移）；快照只留 7 份；扫描（正常、缺 manifest、坏 JSON、main 越界、缺入口）；导出导入往返；`db_batch` 回滚。测试只用 tempfile 目录。会重建数据的测试需 `ONEDESK_TEST_DB=1`，并拒绝路径含 `Application Support/onedesk` 或文件名为 `onedesk.db` 的库（D26），为这个拒绝写测试。钥匙串测试默认跳过（`#[ignore]`），避免在用户钥匙串中写入。

**完成标准**：`cargo test`、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --check` 通过；`pnpm tauri dev` 能启动窗口，日志无错误，并确认 `~/Library/Application Support/onedesk/onedesk.db` 与 `backups/` 已创建（写进交接文件，附 `ls -la` 输出）。

**交付物**：分支 `phase1/rust` 上的提交 + `docs/handoff/phase1-rust.md`。
