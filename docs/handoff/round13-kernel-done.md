# 第十三轮内核：交接（Opus 内核会话）

分支 `claude/r13-kernel-e7a043`。依据 `round13-plan.md` §2 内核部分、§3 `workspace.settingsSnapshot` / `init-settings.json`，决定 D397–D401。

## 做了什么

- **第一版库识别与转换**（新文件 `crates/kernel/src/legacy.rs`）
  - 识别：有 `schema_version` 表、有 `collections` 表、`resources` 有 `group_name` 列、没有内核的 `meta` 表。
  - `legacy::upgrade_folder(dir, builtin)`：在**设 WAL 之前**打开 `workspace.db`，是第一版就先做 D280 快照，再在**一个事务**里转换：
    把第一版的 `resources`/`plugin_storage`/`secret_names` 改名到旁边（`v1_*`）→ 跑全部现有迁移 → 复制数据 → 删掉第一版的表 → 审计一条。任何一步出错整个事务回滚，文件字节不变（测试逐字节比较）。
  - `Workspace::open_with(dir, builtin)`（`open(dir)` 不变，等于 builtin 为空）和 `Kernel::open`（用 `cfg.builtin`）都先调它。
  - **工作进程**在监听 socket **之前**调 `upgrade_folder`：失败时 stderr 打一行 `onedesk-worker: legacyUpgradeFailed {"table":"<表>"}`，再一行详细原因，**退出码 4**（`legacy::EXIT_LEGACY_FAILED`）。主进程按退出码 4 给界面 `{code:"legacyUpgradeFailed", params:{table}}`（外壳会话的事）。
  - 转换规则（逐条照 §2）：
    - 资源：id、name、tags、description、body、created_at、updated_at 原样（时间转毫秒）；kind 保留短名；放进资源树；`group_name` 按 `/` 拆层、去空白、同一路径只建一个 `core:group`（分组 `created_by = core`，资源 `created_by/updated_by = user`）；每层里分组在前、资源按名称（不分大小写）排；每条一条 rev 1 的 `create` 历史。`visibility`、`ai_visible`、`origin`、`search_text`、`version` 丢弃；搜索索引与引用表由现有启动步骤重建（不写 `search_built`/`refs_built`）。
    - 集合：每条一条资源，kind 短名 `collection`，body `{ "ruleType", "ruleValue" }`，资源树顶层，创建与修改时间都用 `created_at`。集合 id 与某资源 id 相同时换新 id。
    - `plugin_storage`：按插件 id 原样复制，`version` 暂记为 `legacy`（第一版存储没有版本）；插件认领时移到它当时的版本（见下）。
    - `secret_names` → 密钥名字索引（`updated_at` = 第一版 `created_at`），值不在库里。
    - `app_settings`：`language`（优先）/`locale` → `ui.language`（形如语言标签才收），`theme` → `ui.theme`（只收 `system/light/dark`）；值是 JSON 字符串时先解开。写进新建的根配置节点 “Workspace”（于是启动时不再多建一个）。其余键丢弃，键名写进审计摘要 `droppedSettings`。
    - `plugins`：只取 `enabled = 0` 且 id 在内置列表（`--builtin` 的 id 部分）里的，建插件状态 `enabled = false`。
  - 失败判据（报出错的表）：正文不是 JSON 对象、tags 不是字符串数组、时间解析不了 → 表 `resources`/`collections`/`secret_names`；建当前结构出错 → `schema`。时间接受 `YYYY-MM-DD[T ]HH:MM[:SS[.fff]]` 加 `Z`/`±HH:MM`/`±HHMM`/无（按 UTC），或纯毫秒数。
- **认领（D399）**
  - 时机：启动后（自动切版本之后，在同一个后台任务里）、以及每次 `settle_dependents` 结束时（启用、停用、确认权限、换版本、重新扫描等都会经过它）。没有短类型名资源、也没有 `legacy` 存储时只花一次查询。
  - 每个**正在工作**（启用、有可用版本、依赖满足）的插件，按插件 id 顺序，一个插件一批（含它全部 `legacyKinds`）。`legacyKinds` 里插件本身没声明成类型的短名不认领（改成 `<id>:<短名>` 会变成不存在的类型）。认领包括已删除（回收站里）的行。
  - 每条先调 `kinds.<短名>.upgrade(ctx, { body, legacyKind })`（纯计算，写入类宿主调用被拒，在事务外）；然后一个写入事务把全部行改 kind、绑定版本、写新正文、rev+1、历史 op `legacyClaim`，同事务把该插件 `legacy` 存储移到当前版本（当前版本已有的键优先），清掉上次失败记录，审计 `plugin.legacyClaim`。
  - 任一条 `upgrade` 抛错 / 返回不合法 / 写时发现行已变 → 整批不认领；审计 `plugin.legacyClaimFailed`（失败行），插件状态参数 `legacyClaimFailure` 记下原因，`plugin.get` 的 `legacyClaimFailure` 显示；插件照常启用。
  - 两个插件同短名：先认领的拿走，后一个找不到行就什么都不写（不审计）。
  - 认领一次只有一个（`claim_lock`）。
- **未认领的短类型名**：树节点 `state: "unknownKind"`（新增，见下）；可删除、可移动（测试过）；`page.resolve` 返回 `state: unknownKind`、`readOnly: true`、空视图（同已有的“插件缺失”处理）。带 `:` 的未知类型仍是 `missing-plugin`。
- **`workspace.settingsSnapshot` 与 `init-settings.json`（D400）**
  - 请求带 `client` → `denied`，`reason: mainProcessOnly`；不带（主进程自己）→ `WorkspaceSettingsSnapshot`：配置树（每个节点的名称、说明、自己的参数，递归子节点；`ref` 类参数不复制）和每个有状态的插件的开关。
  - 新工作进程打开工作区时，若文件夹里有 `init-settings.json`：先删文件；库里没有任何非 `core` 创建的资源才应用（第一个根节点替换默认的 “Workspace” 根，其余新建；插件开关照设），审计 `workspace.initSettings`。解析失败或工作区不是新的：记日志、不应用（文件同样已删）。主进程把 `settingsSnapshot` 的结果原样写成这个文件即可。

## 协议（只增）

- `NodeState::UnknownKind`，线上名 **`"unknownKind"`**（计划定死的名字；与其他 kebab-case 值风格不同，是有意的）。
- `ErrorCode::LegacyUpgradeFailed`（`"legacyUpgradeFailed"`，params `table`）、`ErrorCode::LegacyMoveFailed`（`"legacyMoveFailed"`，由主进程用）。
- `PluginDetail.legacyClaimFailure?: LegacyClaimFailure { legacyKind, resource?, reason, at }`。
- `method13`：`APP_WORKSPACES = "app.workspaces"`、`APP_CREATE_WORKSPACE`、`APP_SWITCH_WORKSPACE`、`APP_RENAME_WORKSPACE`、`APP_DELETE_WORKSPACE`、`WORKSPACE_SETTINGS_SNAPSHOT = "workspace.settingsSnapshot"`；`topic13::APP_WORKSPACES_CHANGED = "app.workspacesChanged"`；常量 `INIT_SETTINGS_FILE = "init-settings.json"`。
- 类型：`WorkspaceEntry { id, name, folder, lastOpened?, current }`、`WorkspacesResult { items }`、`CreateWorkspaceParams { name }`、`WorkspaceIdParams { id }`、`RenameWorkspaceParams { id, name }`、`WorkspaceSettingsSnapshot { config: SettingsSnapshotNode[], plugins: PluginEnabledState[] }`、`SettingsSnapshotNode { name, description, params: SnapshotParam[], children }`、`SnapshotParam { name, type, value }`、`PluginEnabledState { plugin, enabled }`。
- 已 `pnpm gen:types` 并提交生成的 TS。注意外壳 `src/workbench/protocol/types.ts` 里有一个手写的演示用 `WorkspaceEntry`（只有 id/name/current），与生成的同名不冲突（那里是按名导入），外壳会话可改用生成的。

## 宿主接口 `upgrade` 的确切签名

```js
host.kinds.handle("<短名>", {
  upgrade(ctx, { body, legacyKind }) { return { body: { /* 新正文 */ } }; }
});
```
- `ctx`：`{ resource, locale, host, t, ... }`，`resource` 为资源基本信息（只读，kind 仍是短名），`locale` 为工作区配置的界面语言（没有则 `null`）。和 `children`/`drop` 一样 ctx 在前（`migrate` 仍是 `(body, fromVersion, ctx)`）。
- 返回 `{ body }`（对象）→ 用新正文；返回 `null`/`undefined` 或没声明 `upgrade` → 正文不变；其他（字符串、没有 `body` 的对象、`body` 不是对象）→ `badUpgrade`；抛错 → `upgradeFailed`。可以异步。
- 注意：插件包必须有 `activate`（与其他调用一样，认领要先启动插件）。

## 新增原因码与审计名（全部）

- 原因码：`legacyUpgradeFailed`（ErrorCode，params `table`）、`legacyMoveFailed`（ErrorCode，主进程用）；`denied` + `reason: mainProcessOnly`；认领失败的 reason：`upgradeFailed`、`badUpgrade`、`changedDuringClaim`（conflict）。
- 审计：`workspace.legacyUpgrade`（actor `core`，摘要 `resources/groups/collections/pluginStorage/secretNames/settings/disabledPlugins/droppedSettings`）、`plugin.legacyClaim`（`count/kinds/storageKeys/version`）、`plugin.legacyClaimFailed`（失败行，摘要只有 code 与 reason）、`workspace.initSettings`（`configNodes/plugins`）。认领失败记原因时另有一条 `plugin.state`。

## 测试结果

- `crates/kernel/tests/round13.rs` 11 个 + `legacy.rs` 单元 2 个，全部通过：识别；各表转换（条数与内容、分组分层与同名合并、集合、存储、密钥名、设置映射、只取内置插件的停用、旧表全删、审计、搜索可找到）；失败回滚（数据库逐字节不变、`Kernel::open` 也拒绝、错误表名）；空的第一版库；认领改 kind/`upgrade` 改正文/存储移版本/无 `upgrade` 正文不变；`upgrade` 出错与返回不合法整批回滚并审计、插件页原因；两插件同名（启动时按 id、和先由用户启用的）；未认领状态、移动、删除、不能打开；`settingsSnapshot` 只接受主进程；`init-settings.json` 应用一次后删除、有用户内容时不应用。
- 检查（本分支）：`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol` 全过；`cargo clippy … --all-targets -D warnings` 无警告；`sh scripts/gen-types.sh --check` 最新；`pnpm lint` 通过。
- **`pnpm typecheck` 不过**：`src/workbench/parts/frame.tsx`（三处 `Record<NodeState, …>` 缺 `unknownKind`）和 `src/workbench/parts/side-panel.tsx:222`（`TreeNodeState` 不含 `unknownKind`）。这是新增枚举值的预期后果，文件在外壳会话范围内，需外壳会话补上（已记入 todo.md）。合并时请把本分支与外壳分支一起合。

## 我做的决定（设计没写到的）

1. 转换放在工作进程监听之前（失败 = 退出码 4 + 一行 stderr），`Kernel::open` 里也会做（进程内使用）。
2. 第一版插件存储先记版本 `legacy`，认领时移到插件当时的活动版本；没有插件认领的存储一直留着。
3. 正文/标签/时间不合法就整体失败（不静默丢数据或改数据）。
4. 认领时不检查 D311 受保护字段（第一版的地址是用户自己的数据）；也**没有**像保存那样审计“新授予的网络地址”（D307）——见下。
5. 未认领节点打开时给空的只读页面（与插件缺失一致），不是报错。
6. `init-settings.json` 判断“新库”用“没有非 core 创建的资源”，而不是“文件刚建”，这样工作进程中途崩了下次还能应用。

## 没做 / 没验证

- 没用测试会话的 `e2e/fixtures/legacy-v1/`（本分支还没有）；夹具是 `round13.rs` 里按 `0001_init.sql` 自建的，第一版真实运行时写入的时间格式与 JSON 只按 SQL 注释（ISO 8601 UTC、JSON）推断，没有对照真实第一版库。
- 认领后新授予的网络地址没有单独审计（D307 那条路径没接）。
- 没有在真实工作进程 + 主进程下跑过退出码 4 的路径（只单测了 `upgrade_folder` 与 `Kernel::open`）。
- 第一版插件设置、钥匙串里的值不迁移（D397）。
