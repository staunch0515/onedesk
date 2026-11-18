# 第十三轮：多工作区 + 多窗口（协调会话定，2026-11-18；同日按用户决定修改，D403）

> **D403（用户决定）：不做第一版旧库升级。** 下面 §2 和 §1 里关于旧库的部分作废，`legacyKinds` 从清单格式里去掉；多窗口并入本轮（见 §3 末尾）。内核会话本轮只做 `workspace.settingsSnapshot` / `init-settings.json` 与去掉 `legacyKinds`；测试会话的第二阶段只测多工作区与多连接。

依据：`dev-plan.md` 阶段 1 验收“第一版旧库升级不丢数据”、阶段 4 “多窗口、多工作区的新建、切换、删除”；`kernel-design.md` §2.1、§3.1（工作区文件夹、`workspace.json`、旧库移到 `workspaces/default/`、`legacyKinds`）、D211、D228、D230、D383。沿用前几轮的全部约定（`round4-plan.md`–`round12-plan.md`、`coordinator-handover.md` §3–§5）。决定 D397–D401 见 `docs/decisions.md`。
本文件里的名字**定死**；协议类型由内核会话按这里的名字“只增”加进 `crates/protocol`（并 `pnpm gen:types`），外壳先按可选字段写。

## 1. 做完是什么样

- **旧库升级**：数据目录里只有第一版的 `onedesk.db`（第一版的结构见 git `bf8f6b0^:src-tauri/migrations/0001_init.sql`）时，启动新版本后：旧文件原样备份，数据出现在默认工作区里——每条资源都在（名称、标签、说明、正文、创建与修改时间），第一版的 `group_name` 变成资源树里的分组（`core:group`，同名合并、按 `/` 分层），第一版的“集合”变成集合资源，插件存储与密钥名字都在；内置插件按 `legacyKinds` 认领后，网址、笔记、提示词、HTTP 请求、集合在新版里照常打开、编辑、运行。没有插件认领的短类型名的资源不丢，在树里显示为“没有插件处理的类型”。升级失败时旧数据不动、界面说明原因。
- **多工作区**：标题栏的工作区菜单能列出全部工作区、新建（复制当前的配置树和插件启用状态，不复制数据）、切换、改名、删除（不能删当前的；删除是移到数据目录的 `trash/`，并删掉它在钥匙串里的条目）。切换后整个界面换成那个工作区的内容。
- **不做（下一轮，D397）**：多窗口（一个窗口一个工作区、“新窗口”）；第一版插件的设置（`plugins.settings`）迁移；第一版钥匙串里的密钥值迁移（密钥名字在，值要重新填）。

## 2. 旧库升级（D398，内核 + 主进程）

- **主进程**（`crates/host/src/data_dir.rs`）：启动时若 `<数据目录>/onedesk.db` 存在且 `workspaces/` 下没有任何含 `workspace.db` 的文件夹：建 `workspaces/default/backups/`，把 `onedesk.db`（及 `-wal`、`-shm`，若有）**复制**为 `backups/v1-onedesk.db`，再把原文件**移动**为 `workspaces/default/workspace.db`。之后照常启动工作进程。两个步骤都成功前不删任何东西；任何一步失败：不启动、日志与界面给原因码 `legacyMoveFailed`。已有 `workspaces/` 时不碰 `onedesk.db`。
- **内核**（打开工作区数据库时）：识别第一版结构（有 `schema_version` 表且有 `collections`、`group_name` 列，没有内核的迁移记录）→ 在**一个事务**里把它转成当前结构，然后照常跑现有迁移。转换规则：
  - `resources`：id、name、tags、description、body、created_at、updated_at 原样；`kind` 保留短名；树为内核资源树；`group_name` 非空的按 `/` 拆层建 `core:group`（同一路径只建一个），资源放进去；`visibility`、`ai_visible`、`origin`、`search_text`、`version` 丢弃（新版没有对应，搜索索引重建）。
  - `collections`：每条变成一条资源，kind 短名 `collection`，body `{ "ruleType": rule_type, "ruleValue": rule_value }`，放在资源树顶层。
  - `plugin_storage` → 插件存储（按插件 id 原样）；`secret_names` → 密钥名字索引（值不在库里）；`app_settings` 中 `language`/`locale`→`ui.language`、`theme`→`ui.theme`（若键存在且值合法），其余丢弃并写进审计摘要；`plugins` 表只取 `enabled = 0` 的内置插件 id 设为停用。
  - 审计一条 `workspace.legacyUpgrade`（操作者内核，摘要含各类条数）。失败 → 事务回滚、数据库不变，工作进程报 `legacyUpgradeFailed`（参数含出错的表）。
- **认领**（D399，`legacyKinds`）：插件启用（含启动时已启用）时，内核把本工作区里 kind 等于它 `legacyKinds` 某一项、且尚未被认领的资源改写成 `<插件id>:<短名>`，同一事务里对每条调用该类型的 `upgrade`（若声明）。宿主接口只增：`host.kinds.handle("<kind>", { upgrade(ctx, { body, legacyKind }) { return { body } } })`；`ctx` 含 `resource`（基本信息）、`locale`。没声明 `upgrade` 的照原样改 kind。某一条 `upgrade` 出错或返回不合法 → 整批回滚、插件照常启用但这批不认领，审计 `plugin.legacyClaimFailed`，插件页显示原因；成功审计 `plugin.legacyClaim`（摘要含条数）。两个插件声明同一短名：先启用的认领，后一个不再有可认领的。
- 没被认领的短类型名资源：树节点 `state: "unknownKind"`（若已有表示“类型不可用”的状态就用已有的，在交接文件写明），可删除、可移动，不能打开编辑器。

## 3. 多工作区（D400，主进程 + 外壳；内核只增一个方法）

主进程方法（`app.*`，只经主进程，不转给工作进程）：
- `app.workspaces` → `{ items: WorkspaceEntry[] }`；`WorkspaceEntry = { id, name, folder, lastOpened?, current }`（`current`：本连接正在用的那个）。按 `lastOpened` 倒序。
- `app.createWorkspace { name }` → `WorkspaceEntry`：建 `workspaces/<文件夹>`（由名称生成、去重），写 `workspace.json`；向当前工作进程取 `workspace.settingsSnapshot`（内核只增，只接受主进程的连接）写到新文件夹的 `init-settings.json`；新工作进程第一次打开空库时应用它（配置树的值、插件启用状态）后删掉该文件。不切换。
- `app.switchWorkspace { id }` → `WorkspaceEntry`：本连接改绑到该工作区（需要时启动它的工作进程，更新 `lastOpened`）；成功后外壳整页重新载入（重新 `hello`）。没有连接再用的工作进程按现有规则关闭。
- `app.renameWorkspace { id, name }` → `null`：改 `workspace.json` 的名称；正在运行的工作进程的 `workspace.info` 名称在下次启动前可以是旧的（界面以 `app.workspaces` 为准）。
- `app.deleteWorkspace { id }` → `null`：当前的、或有别的连接正在用的 → `conflict/inUse`；否则把文件夹移到 `<数据目录>/trash/workspaces/<文件夹>-<时间>`，删掉它的钥匙串条目（测试里是内存密钥库）。
- 事件 `app.workspacesChanged`（无参数）在新建、改名、删除后推给所有连接。
- 错误一律 `{code, params}`；名称空或超过 100 字符 → `invalidParams`。
- 多窗口（D403 并入）：桌面版“新窗口”开一个窗口并绑定一个工作区；一个窗口同一时间只属于一个工作区，同一工作区可在多个窗口；窗口位置与大小记在该工作区的 `workspace.json`；某工作区最后一个窗口关闭后按现有规则关闭它的工作进程；浏览器/devhost 下“新窗口”是新开一个标签页连接（地址参数指定工作区）。
- 外壳：标题栏工作区菜单（“切换、新建、新窗口”都打开）；新建/改名用对话框，删除要确认（写明“移到数据目录的 trash 文件夹”）；`workspacesChanged` 时刷新列表。假数据模式给出 2 个工作区的演示。

## 4. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §2 内核部分（识别与转换、认领与 `upgrade`、未认领状态）、`workspace.settingsSnapshot` 与 `init-settings.json` 的应用、协议类型 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS |
| 外壳（Sonnet） | §2 主进程的移动与备份；§3 全部（主进程方法、事件、devhost 同样支持、界面菜单与对话框）；新增英语文字 | 同前几轮（`crates/host/**`、`src-tauri/**`、`src/workbench/**`、`src/design/**` 等） |
| 插件与测试（Sonnet） | 第一阶段：第一版的测试夹具（按 `0001_init.sql` 建库、含各类数据的脚本，放 `e2e/fixtures/legacy-v1/`，内核测试也用它——内核会话可自建同样的 Rust 夹具）；各内置插件按第一版的正文字段写 `upgrade`（第一版各类型的字段在 git `bf8f6b0^` 的源码里查）；集合插件 `legacyKinds: ["collection"]` 与 `ruleType/ruleValue` → 新条件；第二阶段：`e2e/round13.spec.ts`、补本轮外壳新增文字的中日译文 | `plugins/**`、`e2e/**`、`scripts/check-*.mjs` |

## 5. 完成标准

- 内核必须有的测试：第一版库识别；每张表的转换（条数与内容）、`group_name` 分层与同名合并、集合转资源、设置键映射；转换失败回滚（数据库字节不变）；认领改 kind、`upgrade` 改正文、`upgrade` 出错整批回滚并审计、两个插件同名短类型、未认领状态；`settingsSnapshot` 只接受主进程、`init-settings.json` 应用一次后删除。全部用临时目录。
- 主进程测试：只有 `onedesk.db` 时备份并移动、已有 `workspaces/` 时不动、移动失败不删；五个方法与事件；删除当前/占用中的被拒；删除移到 `trash/`、钥匙串条目（内存库）删除。
- `e2e/round13.spec.ts` 连真内核：用夹具旧库启动 devhost → 每类资源能打开、正文正确、HTTP 请求能发、分组与集合在；多工作区新建、切换（内容不同）、改名、删除。
- 假数据模式 `workbench.spec.ts` 全过、截图不变（工作区菜单的变化如需更新基准，逐张对照后更新并写明）。
- 交接文件 `round13-kernel-done.md`、`round13-shell-done.md`、`round13-tests-done.md`。
