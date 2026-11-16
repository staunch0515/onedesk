# 第五轮内核：完成记录

分支 `claude/r5-kernel-f7da41`（从协调分支切出，未推送、未合并）。范围：`round5-plan.md` §3–§7 的内核与工作进程部分。

## 完成了什么

- **引用（§4，D321–D323）**：迁移 `0008_refs.sql` 新建 `refs` 表（来源、字段、序号、文字、目标 id 或空）。写入管线在同一事务里重算：新建、改、历史恢复、升级接管与撤销、插件写入、导入。目标改名后 `resource.get`、`page.resolve`（含给插件 `render` 的 `ctx.resource`、插件 `resources.get/list`）读出时把已解析的 `[[旧名]]` 换成当前名称，库里正文不变、不产生历史。删除/恢复/永久删除三种状态在读时由目标行算出；永久删除后目标置空；新建同名不自动接上。来源被删除时 `refs.incoming` 不列，永久删除来源时它的行删除。首次启动（`meta.refs_built` 不存在，即迁移 0008 之后）全量重建；内部重建函数 `refs::rebuild`（另有 `Command::RebuildRefs`）。
- **方法**：`refs.outgoing`、`refs.incoming`、`params.known`、`workspace.export`、`workspace.importPreview`、`workspace.import`、`run.export`（`crates/kernel/src/transfer.rs`）。
- **保护策略（§6，D327）**：`crates/kernel/src/policy.rs`。工作区配置层在写入管线里检查（所有内容写入命令）；`page.save`、`run.start` 另外检查标签页环境的父链。`page.resolve` 结果带 `restrictions`。
- **导出导入（§5，D324–D326）**、**结果导出（§7，D328）**。
- **事件**：引用变化时对另一端发已有的 `resource:<id>`（保存来源 → 新旧目标；目标改名/删除/恢复/永久删除 → 引用它的来源），不加新主题。

## 测试结果（本会话实际运行）

- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过（新增 `crates/kernel/tests/round5.rs` 16 个；单元测试新增 `refs` 2 个、`policy` 1 个、`transfer` 2 个、`manifest` 1 个）。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：无警告。
- `sh scripts/gen-types.sh --check`：最新（已提交生成的 `PageDescriptor.ts`）。
- `pnpm lint`：通过。
- 没运行：`pnpm check` 全套（typecheck、vitest、e2e 属外壳/测试会话）；连真应用的手动验证。

## 协议上“只增”加的字段

- `PageDescriptor.restrictions?: string[]`：值 `readonly`、`noExport`；没有限制时不出现（`crates/protocol` + 生成的 TS）。
- 其余全部用协调会话定好的 round 5 类型，未改。

## 清单新增部分

- 字段声明 `fields.<key>.refs: true`：只能用于 `text` / `longtext` / `code`；可与 `secrets: true` 同时出现；不能与 `grants` 同时出现。
- 字段声明 `fields.<key>.type: "ref"`：单个引用，资源里存 `{ "ref": "<id>" }`；不能带 `refs`、`grants`（带 `secrets` 按已有规则报 `badSecretsField`）。
- 新的拒绝原因：**`badRefsField`**（以上违规）。
- 内部：`fields.*.type` 现在由内核自己的 `DeclType`（`FieldKind` 加 `ref`）解析，协议的 `FieldKind` 不变。

## 新增错误原因码（外壳据此配文字）

| 方法 | code | `params.reason` | 其他参数 |
|---|---|---|---|
| 任意内容写入、`page.save`、`run.start`、`workspace.import`、插件 `resources.*` 写入与 `storage.set/remove` | `denied` | `readonly` | `layer`：生效那一层的节点 id（配置节点或环境节点） |
| `workspace.export`、`run.export` | `denied` | `noExport` | `layer` 同上 |
| `workspace.export` | `invalid` | `notAbsolute`、`noParent`（父目录不存在）、`notEmpty`、`insideDataDir`、`writeFailed`（`detail` 有系统错误） | |
| `workspace.import` | `invalid` | `fingerprintChanged`、`badParent`（`parent` 不是资源树里的分组）、以及预览的三种（`notExport`、`badVersion`、`unreadable`） | |
| `workspace.importPreview` 的 `problem` | `invalid` | `notExport`、`badVersion`、`unreadable` | |
| `ImportSkip.reason` | — | `unknownKind`、`needsVersion`、`invalid`、**`config`**（新增：工作区配置节点不导入，D326） | |
| `run.export` | `invalid` | `badFormat`、`notFinished`、`notTable`、`notAbsolute`、`noParent`、`exists`、`insideDataDir`、`writeFailed` | |
| `run.export` | `notFound` | （`what: run`） | |
| `refs.outgoing` / `refs.incoming` | `notFound` | （`what: resource`） | |

## 审计操作名

- `workspace.export`：对象是文件夹路径，摘要 `{resources, revisions, runs, audit, blobs}`。
- `workspace.import`：对象是来源工作区名字，摘要 `{group, created, updated, skipped}`。导入的授权地址照常记 `network.grant`（用户写入）。
- `run.export`：对象是运行 id，摘要 `{rows, format}`。
- 被拒时（`readonly` / `noExport`）照例写一行 `result = failed:denied`，操作名为对应命令：`resource.create/update/move/delete/undelete/purge/restore`、`page.save`、`run.start`、`plugin.undoUpgrade`、`plugin.upgrade`、`workspace.import`、`workspace.export`、`run.export`。
- 插件 `storage` 写入被拒时不写审计（与以前一样，存储命令不记审计）；插件把错误照常收到。
- 内部命令名 `refs.rebuild`（只在失败时出现）。

## 导出文件格式（版本 1）

文件夹内：`manifest.json`、`resources.json`、`revisions.json`、`runs.json`、`audit.json`、`blobs/`（内核目前没有大块数据，空文件夹，`blobs: 0`）。JSON 两格缩进、每层键按字母序、末尾换行。

- `manifest.json`：`{ format: "onedesk-export", version: 1, workspace: { id, name }, exportedAt, counts: { resources, revisions, runs, audit, blobs }, appVersion }`。
- `resources.json`：数组，按树深度优先（父在子前）。每项 `{ id, kind, plugin, pluginVersion, tree, parent, pos, name, description, tags, body, externalKey, rev, createdAt, createdBy, updatedAt, updatedBy, refs: [{ field, seq, text, target }] }`。导入时只要求 `id`、`kind`、`name`；`refs` 缺省时导入后按名称解析（给手写的导出用）。
- `revisions.json`：导出资源的全部历史 `{ resourceId, rev, at, actor, op, fields, snapshot, restoredFrom }`。
- `runs.json`：`{ id, seq, title, resourceId, resourceKind, plugin, action, envName, actor, source, startedAt, endedAt, status, params, input, summary, error, kept, keptName }`，**没有 `output`**；只含资源已导出或无资源的运行。
- `audit.json`：全部审计行 `{ seq, at, actor, op, object, summary, result }`。
- 不含：密钥值（密钥字段与参数只有名字）、`ui_state`、`resource_meta`（收藏、使用记录）、`plugin_storage`、插件状态节点（权限确认、授权文件夹）、已删除资源及其历史。
- 导入只读 `manifest.json` 和 `resources.json`；指纹 = 两个文件字节的 FNV 指纹。格式说明也放在共享笔记 `r5-kernel-export-format.md`，供测试会话手写夹具。

## 我做的决定（设计没写到或需要取舍的）

1. **引用状态不存表**：`refs` 只存目标 id 或空；`ok/deleted/missing` 读时由目标行算。永久删除时把目标置空。
2. **重算只针对改动的字段**：只改名字、移动等不会重新解析引用。同一字段里文字没变的 `[[X]]` 保留原目标（按 id，D323）；文字变了才按名称重新解析。因此“新建同名不自动接上”成立，直到用户改了那段文字。
3. **“路径最靠前”= 树上显示顺序**：按（树、从根到自己的各级位置、id）字典序比较；所以一个靠上分组里的同名资源排在下面的顶层资源之前。
4. **字段声明取所有已安装版本的并集**（与 D311 的受保护字段同一做法），写入规则只按 kind，不按绑定版本。
5. **`RefInfo.text`** 是 `[[` 与 `]]` 之间的文字（不带括号）；单个引用字段是写入时目标的名称（目标不存在时是那个 id）。`field` 形如 `body.text`。
6. **只读放行的**：参数本身（`params.*`、配置/环境页只改参数的 `page.save`）、密钥、界面状态、收藏与最近使用、审计、插件状态（启用停用、设置、授权文件夹、钉住）、已在运行的运行的结束与进度、保留运行、清空任务、**不改写任何资源的**版本切换（`Upgrade` 无条目时），以及插件安装移除。**拒绝的**还包括新建/删除环境与配置节点（它们是资源）、插件提供树节点的 `page.save`。
7. **配置层的合并**：所有配置节点（不只根节点）都是一层，任何一个为真即禁止；`layer` 优先报根节点。布尔值认 `true/1/yes/on`（不分大小写）。
8. **`run.export` 的环境**：用运行记录里的环境（配置层 + 该环境父链）；结果页的 `restrictions` 也按运行的环境算。
9. **数据目录**：工作区文件夹、插件文件夹，以及工作区上级名为 `workspaces` 时的再上一级（正式布局 `<数据目录>/workspaces/default`）。路径先把父目录解析成真实路径再比较。
10. **导入**：外部键匹配到**已删除**的同类资源时，新建一条且不带外部键（唯一索引含已删除行）。同一导出里两条同类同外部键 → 事务失败，全部不动（测试即用此构造“一条失败”）。外部键更新的条目原地更新，不移动；导入的版本：绑定版本已安装则绑它，否则活动版本能接管（`upgradesFrom`）就先跑插件 `migrate` 再绑活动版本，失败则整个导入失败。导入的分组只能放 `resources` 树（其他存储树的节点放到各自树顶层）；文件里的父链有环时，那些节点放到导入分组下。环境只给顶层环境加序号。导入资源的 `origin` 仍是 `original`。
11. **预览计数**：分组、环境也算在 `create` 里；工作区配置节点出现在 `skipped`（`config`）。
12. **只读检查放在写入管线**（配置层）+ `page.save` / `run.start` 入口（环境层），不在每个方法里各写一遍；被拒的审计由管线照常写。

## 没做 / 没验证的

- 只读对“版本切换带来的改写”（`plugin.activateVersion` 有条目）没有单独测试，只测了 `plugin.undoUpgrade`；插件安装/移除在只读下放行也没有单独测试（代码上不经过被拒的命令，除非安装触发了有条目的接管——那一步会被拒）。
- 只读时启动的自动接管（`auto_switch`）会被拒并只记日志，版本保持原样。
- 导入时绑定版本缺失、由活动版本 `migrate` 接管的路径没有集成测试（预览的 `needsVersion` 有测试）。
- `blobs/` 永远为空（内核还没有大块数据）。
- 外壳、e2e 未运行（不在本会话范围）。

## 审查后的修改（`round5-review.md`，D329）

先合并了协调分支 `claude/onedesk-coord-2-91a88b`。11 条全部修了，每条有测试（`crates/kernel/tests/round5.rs` 末尾 `review*` 7 个，`refs.rs` 单元测试 1 个，原有测试相应补断言）。

| # | 改了什么 | 测试 |
|---|---|---|
| 1 | 导入的每一条按新建的规则定树：插件类型只取清单规则的树；分组只能在 `resources` 或插件的存储树，文件写 `env`/`config`/`core:plugin-state` 的记 `invalid`；`core:plugin-state` 节点记 `invalid`。文件里的父节点要同树且 `accepts` 本类型，否则 `invalid`（父节点没被导入的照旧放进导入分组/树顶层）。写入事务里再过一遍 `check_parent` 和树校验（`otherTree`）。 | `review1_imported_structure_follows_the_creation_rules` |
| 2 | 协议只增 `ImportPreview.grantHosts`、`ImportPreview.secretNames`（排序去重）。来源：授权地址字段；密钥字段 `{secret}`、`secrets: true` 文字里的 `{{secret:…}}`、环境参数中类型为 `secret` 的值。只算会被导入的条目；接管版本的条目按接管前的正文算。`network.grant` 审计照记。 | `review2_preview_lists_granted_hosts_and_secret_names` |
| 3 | 保留表同时以旧文字和旧目标的**当前名称**为键，改名后保存读到的 `[[新名]]` 仍接原目标。 | `review3_saving_what_was_shown_after_a_rename_keeps_the_target` |
| 4 | 单引用字段的目标没被导入：正文改写为 `{ "ref": null }`，`refs` 行保留文字（文件 `refs` 里该字段的文字，没有就用旧 id），状态 `missing`。 | `review4_a_single_reference_to_something_not_imported_is_cleared` |
| 5 | 读之前查大小：`manifest.json`、`resources.json` 各 256 MB，超了 `invalid/tooLarge`；条数上限 200 000（`tooLarge`）；单条正文序列化超过 8 MB 的记 `invalid`。 | `review5_8_limits_duplicate_ids_and_untrusted_refs` |
| 6 | 新迁移 `0009_resource_names.sql`：`CREATE INDEX resources_name ON resources (name)`（0008 未改）。 | `review6_resource_names_are_indexed`；迁移升级测试同时覆盖 |
| 7 | `meta.refs_decl` 记下建表时各类型的引用字段；启动时和 `plugin.rescan` 之后（新命令 `SyncRefDecls`，审计名 `refs.sync` 只在失败时出现）比较：去掉的字段删行，新增的字段对该类型的全部资源（含已删除）计算，不变的字段不动。 | `review7_9_new_reference_fields_and_undo_under_readonly` |
| 8 | 不信文件里的 `refs`：导入后按正文重算；同字段、同序号、同文字的文件行只作提示（目标按新旧 id 对应，没导入的为 `missing`），其余按名称解析；文件行重复、错位都不影响。预览查重复 id：`valid: false`，`problem` = `invalid/duplicateId`；`workspace.import` 同样拒绝。 | `review5_8_…` |
| 9 | 只读：空的 `page.save` 放行（管线里空的 `Update` 也不拒）；撤销升级只在确有资源要改写时拒绝（检查移到撤销内部，第一条要恢复的资源之前）。 | `review7_9_…`（空保存、能改写时被拒、全部已被改过时放行） |
| 10 | CSV 每行按表头列数截断或补空；结果已被清理（`output` 为空）的报 **`noOutput`**，有输出但不是表格才是 `notTable`。 | `run_export_writes_rfc4180_csv_…` |
| 11 | 读出替换时，目标名称含 `]]`、`[[`、换行、以 `]` 结尾、为空或超过 200 字符的不替换，保持原样（`refs::shows_as_mark`）。 | `refs::review_tests` |

新增错误原因码：`invalid/tooLarge`、`invalid/duplicateId`（预览 `problem` 与 `workspace.import`）、`invalid/noOutput`（`run.export`）、`invalid/otherTree`（导入事务内的防线，正常不会出现）。其余见上文各节。

不改（按审查记录）：FNV 指纹（已在 `todo.md`）、`writeFailed` 的 `detail`、插件存储被拒不记审计。

运行结果（本会话）：`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol` 全过；clippy `-D warnings` 无警告；`gen-types --check` 最新（已提交 `ImportPreview.ts`）；`pnpm lint` 通过。另核对了 `e2e/fixtures/exports/sample` 在新规则下不受影响（都是 `resources` 树的顶层节点）。

## 验收后的修改（D330：先写引用、后建目标）

先合并了协调分支。

- **迁移 `0010_refs_ever.sql`**（0008、0009 未改）：`refs.ever`（是否曾指向过资源）。已有行目标非空的记 1，目标为空的记 0（无法区分，一律算“从未”）；部分索引 `refs_waiting (text) WHERE target_id IS NULL AND ever = 0`。
- **接上的时机**（同一事务）：资源新建、改名、恢复删除（整批）、导入（新建与外部键更新的条目，全部写入之后）得到某名称时，`refs::connect_name` 把“目标为空且从未指向过”、文字等于该名称的行逐条从**来源**的角度按 D322 解析（同父分组优先，再取树上显示顺序最靠前），设目标并记 `ever = 1`；来源和目标都发 `resource:<id>`。分组、环境、配置、插件状态节点得到名称时不接。已删除的来源的等待行也会接上（恢复后即可用）。
- **D323 不变**：曾指向过、目标被永久删除的行 `ever = 1`，不自动接；用户改了正文别处再保存，同一文字的标记保留“曾指向过”。只有改了这段文字本身（新文字）才重新按名称解析。
- **单引用字段**（`{ref: id}`）的行一律算“曾指向过”，不按名称自动接（它们按 id，接上需要改写正文）。
- **导入**：文件里目标未被导入的文字引用记“从未”（在本工作区没指向过），之后出现同名资源会接上。
- 测试：`d330_a_reference_written_first_connects_when_the_name_appears`（先写后建、改名成该名、恢复删除、两端事件）、`d330_purged_targets_stay_missing_and_namesakes_are_chosen_from_the_source`（永久删除后新建同名不接、改正文别处后仍不接、不同分组的等待来源、已接上的不被新同名改接、一次导入同时出现两个同名时取树上靠前的）、`d330_imported_names_connect_waiting_references`、`refs::migration_tests::migration_0010_marks_rows_that_had_a_target`（升级测试）。原有 D323 测试继续通过。
- 运行结果：`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol` 全过；clippy `-D warnings` 无警告；`gen-types --check` 最新（协议未改）；`pnpm lint` 通过。
- 没测：一次导入里同时出现两个同名、且等待来源与其中一个同父分组的情形（等待来源在导入之前就存在，不可能与新导入分组同父；同父优先由逐条新建的情形和 D322 原有测试覆盖）。
