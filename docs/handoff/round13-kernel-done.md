# 第十三轮内核：交接（Opus 内核会话，最终状态）

分支 `claude/r13-kernel-e7a043`。依据 `round13-plan.md` §3，决定 D400、D401、**D403**（用户决定不做第一版旧库升级，取代 D383、D398、D399、D402）。

## 最终范围

- **保留并完成**：`workspace.settingsSnapshot`（只接受主进程）、`init-settings.json` 的应用；`app.*` 五个方法、`app.workspacesChanged` 的协议名与类型（主进程实现）。
- **按 D403 撤掉**（曾在本分支 78f24c5 实现过，已整体删除，不进交付）：第一版库识别与一次事务转换（含工作进程退出码 4）、`legacyKinds` 认领与 `kinds.handle` 的 `upgrade`、未认领状态 `unknownKind`、原因码 `legacyUpgradeFailed`/`legacyMoveFailed`、`PluginDetail.legacyClaimFailure`、审计名 `workspace.legacyUpgrade`/`plugin.legacyClaim`/`plugin.legacyClaimFailed`。`workspace.rs`、`worker/main.rs`、`deps.rs`、`sandbox.rs`、`pages.rs` 恢复为第十二轮的样子。
- **清单字段 `legacyKinds` 从内核删除**（D403）：清单解析、`PluginDetail.legacyKinds`（第十一轮加的协议字段，一并删，外壳没有用到）、相关测试。清单是 `deny_unknown_fields`，所以**还带 `legacyKinds` 的清单现在无效（`schema`）**——测试会话要同时从 `plugins/*/manifest.json` 和 `e2e/fixtures/market/…/manifest.json` 删掉它，否则这些插件加载不了、e2e 会失败。

## 实现（`crates/kernel/src/workspace_settings.rs`）

- `workspace.settingsSnapshot`：请求带 `client` → `denied`，`reason: mainProcessOnly`；不带（主进程自己发）→ `WorkspaceSettingsSnapshot`：
  - `config`：配置树每个根节点，递归子节点；每个节点的名称、说明、自己的参数（`{name, type, value}`）。`ref` 与 `secret` 类参数不复制（指向别的工作区的资源、别的工作区钥匙串里的密钥，新工作区都没有；审查 #8）。
  - `plugins`：每个有状态记录的插件 `{plugin, enabled}`（按 id 排序）。
- `init-settings.json`（`INIT_SETTINGS_FILE`）：`Kernel::open` 时若工作区文件夹里有它，**先删文件**；库里没有任何不是 `core` 创建的资源（即新工作区）才应用：第一个根节点取代启动时建的默认 “Workspace” 根（改名、说明、参数），其余根与子节点新建；插件开关照设（`enabled=false` 或去掉）；一个事务，审计 `workspace.initSettings`（摘要 `configNodes`、`plugins`）。解析失败或不是新工作区：记日志、不应用（文件同样删掉）。主进程把 `settingsSnapshot` 的结果原样写成这个文件即可。

## 协议（相对 main：只增，另删一个字段）

- 增：`method13`（`app.workspaces`、`app.createWorkspace`、`app.switchWorkspace`、`app.renameWorkspace`、`app.deleteWorkspace`、`workspace.settingsSnapshot`）、`topic13::APP_WORKSPACES_CHANGED = "app.workspacesChanged"`、`INIT_SETTINGS_FILE = "init-settings.json"`；类型 `WorkspaceEntry { id, name, folder, lastOpened?, current }`、`WorkspacesResult { items }`、`CreateWorkspaceParams { name }`、`WorkspaceIdParams { id }`、`RenameWorkspaceParams { id, name }`、`WorkspaceSettingsSnapshot { config, plugins }`、`SettingsSnapshotNode { name, description, params, children }`、`SnapshotParam { name, type, value }`、`PluginEnabledState { plugin, enabled }`。
- 删：`PluginDetail.legacyKinds`（D403）。
- 已 `pnpm gen:types`，生成的 TS 已提交。外壳 `src/workbench/protocol/types.ts` 有一个手写演示用 `WorkspaceEntry`（按名导入，不冲突），外壳会话可换成生成的。

## 原因码与审计名（本轮新增，全部）

- `denied` + `reason: mainProcessOnly`（`workspace.settingsSnapshot` 被窗口请求时）。
- 审计 `workspace.initSettings`。

## 测试

- `crates/kernel/tests/round13.rs`：`settingsSnapshot` 只答主进程（带 client 被拒、内容含配置与插件开关、密钥参数不在其中）；`init-settings.json` 应用一次后删除（根节点替换、子节点、`ref`/`secret` 不复制、插件停用、审计一条）、有用户内容后再放回的文件不应用但仍删除。
- `round11.rs`：原 `legacyKinds` 显示测试换成“带 `legacyKinds` 的清单无效（schema）”；`manifest.rs` 单测同样。
- 检查结果见汇报消息（`cargo test` 三个包、clippy `-D warnings`、`gen-types --check`、`pnpm lint`、`pnpm typecheck`）。

## 我做的决定

1. `PluginDetail.legacyKinds` 随清单字段一并从协议删掉（只剩它就没意义）。
2. “新工作区”判据是“没有非 core 创建的资源”，不是“库文件刚建”，工作进程中途崩了下次还能应用。
3. `ref` 与 `secret` 参数不进快照，文件里有也丢弃（审查 #8）。

## 没做 / 没验证

- 主进程端（写 `init-settings.json`、五个 `app.*`）不在本会话，没有连起来跑过。
- 内置插件清单里的 `legacyKinds` 由测试会话删；在那之前 `plugins/` 的这些插件加载失败。
