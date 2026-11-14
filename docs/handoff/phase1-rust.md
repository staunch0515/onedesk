# phase1-rust：Rust 后端（契约中的全部 Tauri 命令 + 数据目录、迁移、快照、钥匙串、插件扫描、导出导入）

实际分支名：`worktree-agent-a2f4d3f1460b93200`（按主会话要求不切换分支；任务文件中的 `phase1/rust` 由主会话合并时处理）。

## 完成了什么

- `src/platform/contract.ts` 的 11 个命令全部实现并注册：`app_status`、`db_select`、`db_execute`、`db_batch`、`secrets_list/get/set/delete`、`plugins_scan`、`export_write`、`import_read`。全部为 `async` 命令（不占主线程），失败返回中文字符串。
- 启动顺序（`AppState::init`）：创建 `~/Library/Application Support/onedesk/`、`backups/`、`plugins/` → 打开 `onedesk.db` → 若库文件已存在（非空）则 `VACUUM INTO backups/onedesk-YYYYMMDD-HHMMSS.db`，只留最近 7 份 → 执行未应用的迁移（每个迁移一个事务，失败回滚，中文错误写入 `AppStatus.migrationError`）。有 `migrationError` 时 `db_*` 和 `secrets_*` 一律拒绝；`app_status`、`plugins_scan`、导出导入不受影响。
- 迁移：`include_str!` 嵌入 `migrations/0001_init.sql`；`schema_version(version INTEGER NOT NULL)` 单行，由迁移器在迁移事务内创建和更新。库版本高于应用支持的版本时报错（不降级）。
- `db_select` 返回列名 → 值的对象数组；整数（含 `3.0` 这样的整值浮点）绑定 INTEGER，其他数字 REAL，布尔转 0/1，数组/对象参数报错；BLOB 列返回字节数组。`db_batch` 单事务，返回每条的 rowsAffected，失败全部回滚并指出第几条。
- 密钥：keyring（service `onedesk`，account = 名字）；先写钥匙串再写 `secret_names` 索引（钥匙串失败则索引不变）；删除不存在的钥匙串项不报错。值不进日志和数据库。名字不能为空、首尾无空格、≤128 字符。
- `plugins_scan`：扫描 `plugins/*/`（跳过以 `.` 开头的文件夹和普通文件，按名字排序），返回 manifest 原文与入口源码。`main` 含 `..`、`\`、绝对路径或非普通路径段 → 拒绝；规范化（解析符号链接）后越出插件目录 → 拒绝；`main` 非字符串、坏 JSON、缺 manifest、缺入口均给出中文 `error`。插件文件夹不存在时返回 `[]`。
- `export_write`：在 `parentDir` 下建 `onedesk-export-YYYYMMDD-HHMMSS/`（同秒重名加 `-2`），写入文件和空 `attachments/`；文件名只能是普通文件名；写入失败时删除半成品文件夹。`import_read`：读 resources/collections/manifest 三个文件，缺哪个报哪个。
- `capabilities/default.json`：opener 改为带 scope 的 `opener:allow-open-url`，只允许 `http://*`、`https://*`、`mailto:*`（D65）。

## 改了哪些文件

- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`：加 rusqlite 0.42（bundled）、keyring 3（apple-native）、dirs 7、tempfile 3（dev）
- `src-tauri/src/lib.rs`（注册命令和状态）
- 新增 `src-tauri/src/commands.rs`、`db.rs`、`secrets.rs`、`plugins.rs`、`transfer.rs`、`time.rs`
- `src-tauri/capabilities/default.json`
- `docs/handoff/phase1-rust.md`

## 测试与检查结果

- `ONEDESK_TEST_DB=1 cargo test`（src-tauri）：**20 passed, 0 failed, 1 ignored**（钥匙串真实读写测试 `real_keychain_roundtrip` 默认 `#[ignore]`，未运行）。覆盖：迁移空库→最新；升级测试（0001 之前的空库、已有 0001 数据的库再迁移：数据不丢、幂等、schema_version 只有一行）；坏迁移回滚（测试专用迁移 0002）并在启动时报告；库版本过高；快照只留 7 份、同秒重名、快照可读；首次启动不快照、第二次快照；D26 路径拒绝；select/execute 参数绑定；db_batch 回滚；密钥索引（内存后端）与钥匙串失败不写索引；扫描（正常、自定义 main、缺 manifest、坏 JSON、main 越界 `..`/绝对路径/符号链接、缺入口、main 非字符串、隐藏目录）；导出导入往返与错误输入；迁移失败后数据命令被拒绝；时间格式化。
- `cargo clippy --all-targets -- -D warnings`：通过，无警告。
- `cargo fmt --check`：通过。
- `python3 -m json.tool src-tauri/capabilities/default.json`：通过。
- `pnpm lint`：架构检查通过、界面规范检查通过。
- `pnpm tauri dev`：端口 1420 已被另一个会话的 vite（node 进程）占用，未动它；本次用 `pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:1430","beforeDevCommand":"pnpm dev --port 1430 --strictPort"}}'`（不改文件）启动。`target/debug/onedesk` 进程运行约 9 分钟，日志在 `Running target/debug/onedesk` 之后无任何输出，无 error/panic/warn。启动前数据目录不存在；启动后：

```
$ ls -la "~/Library/Application Support/onedesk"   # 实际路径 /Users/<me>/Library/Application Support/onedesk
drwxr-xr-x@   5 staff    160 Nov 14 18:15 .
drwxr-xr-x@   2 staff     64 Nov 14 18:15 backups
-rw-r--r--@   1 staff  65536 Nov 14 18:15 onedesk.db
drwxr-xr-x@   2 staff     64 Nov 14 18:15 plugins
```

  `sqlite3 -readonly onedesk.db`：schema_version = 1；表 app_settings、collections、plugin_storage、plugins、resources、schema_version、secret_names。之后停止进程，再直接运行一次 `target/debug/onedesk` 验证启动快照：

```
$ ls -la ".../onedesk/backups"
-rw-r--r--@ 1 staff  65536 Nov 14 18:18 onedesk-20261114-091817.db
```

  两次启动后均已停止进程（含 1430 端口的 vite）。前端是占位页，未检查界面内容；命令未从前端实际调用过（前端 tauri 适配器不在本会话范围）。

## 还缺什么

- 钥匙串真实读写只写了 `#[ignore]` 测试，未运行（避免写用户钥匙串）。手动：`cargo test -- --ignored`。
- 命令未经前端端到端调用；JSON 形状由 Rust 单测验证（camelCase 字段、`rowsAffected`、`null` 返回）。

## 决定（请主会话汇总到 decisions.md）

1. **快照时机**：库文件已存在（非空）时**每次启动**都快照（不只在需要迁移时），首次创建库时不快照。快照失败：若有待执行迁移，则不迁移并设置 `migrationError`（没有备份不迁移）；否则只记日志。
2. **时间用 UTC**：快照名、导出文件夹名中的 `YYYYMMDD-HHMMSS` 和 `secret_names.created_at` 都是 UTC（标准库无本地时区；没有引入 chrono/time）。用户看到的导出文件夹名会比本地时间差时区（例：本地 18:18 → `091817`）。如需本地时间需引入新依赖。
3. **同秒重名**：快照名加 `-2`、`-3`…；导出文件夹同样。
4. **迁移失败语义**：每个迁移单独事务，失败的那个回滚，之前已成功的保留（与 D21 一致）。库版本高于应用最新版本 → `migrationError`，不降级。
5. **整数绑定**：JSON 中整值浮点（如 `3.0`）也绑定为 INTEGER；布尔绑定 0/1（契约未列 boolean，但宽松接受）。BLOB 列返回字节数组。
6. **`secrets_get` 也受 `migrationError` 阻断**（与其他 secrets 命令一致）。密钥名校验：非空、首尾无空格、≤128 字符。
7. **扫描**：跳过以 `.` 开头的文件夹；`main` 含 `\` 也拒绝；入口必须是文件；结果按文件夹名排序。
8. **keyring 用 3.x**（3.6.3，`apple-native` 特性），不用最新 4.x：4.x 改为按平台 store 的新 API，3.x API 简单且满足需求。依赖表中只写了 keyring，没写版本。
9. **D26 测试开关**：会写数据库文件的测试在没有 `ONEDESK_TEST_DB=1` 时**跳过（打印提示）而不是失败**；内存库测试不受开关影响。测试数据库一律命名 `test.db` 并先过 `check_test_db_path`。
10. `capabilities/default.json` 保留了原有的 `dialog:allow-ask`（契约头注释只列了 `dialog:allow-open`）；没删，以免影响内核/外壳的确认对话框。

## 需要谁确认 / 问题

- **主会话 / package.json**：`pnpm test:rust` 现为 `cargo test --manifest-path src-tauri/Cargo.toml`，未设 `ONEDESK_TEST_DB=1`，因此 `pnpm check` 下 8 个写库测试会被跳过（仍显示 ok）。建议改为 `ONEDESK_TEST_DB=1 cargo test --manifest-path src-tauri/Cargo.toml`（我无权改 package.json）。
- **主会话**：契约头注释写 opener 用 `opener:allow-open-url`；我用了带 `allow` scope 的对象形式（同一权限 + URL 范围），是否需同步改注释措辞。
- **主会话**：是否保留 `dialog:allow-ask`（见决定 10）。
- **主会话**：导出文件夹名是否需要本地时间（见决定 2）。
- **环境**：端口 1420 被其他会话的 vite 占用，多个会话同时 `pnpm tauri dev` 会冲突。另外发现存在另一个 worktree `.claude/worktrees/phase1-rust-3f25ab`（也在编译 tauri），可能是重复的 Rust 会话，请主会话确认用哪一份。
