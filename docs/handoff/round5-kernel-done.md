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
