# 第五轮：引用、导出导入、保护策略、结果导出（协调会话定，2026-11-16）

依据：`dev-plan.md` 阶段 3/4 的剩余部分；`kernel-design.md` §3.5、§6.3、§9.5、§10、§13。沿用前四轮的全部约定和共同规则（`round4-plan.md`、`coordinator-handover.md` §4–§5）。决定 D321–D328 见 `docs/decisions.md`。
类型以 `crates/protocol/src/lib.rs` 末尾“round 5”一段为准（已生成 TS）。**字段名已定死，不要各猜各的**；确实缺字段时内核按“只增不改”加，并写进交接文件。

## 1. 做完是什么样

- 在笔记正文里写 `[[另一条的名称]]` 并保存：信息面板的“引用”一节列出它引用了谁、谁引用了它，点一下打开对方。对方改名后，这条笔记里显示的是新名称，引用不断；对方被删除后显示为“已删除”的引用，永久删除或本来就不存在的显示为“失效”，不会静默消失。删除一条被别人引用的资源时，确认框写明有几处引用它。
- 命令面板或设置菜单里“导出工作区…”：选一个空文件夹，导出成可直接阅读的 JSON；“导入…”：选一个导出文件夹，先看到预览（新建几条、更新几条、哪些不导入及原因），确认后内容作为新数据进到一个新分组里，资源之间的引用仍然连着。
- 工作区配置页和环境页能从“已知参数”里添加策略参数（不用手打名字）：`protection.readonly`、`protection.no_export`、`network.allow`。打开只读后，保存、新建、删除、移动、运行里的写入都被拒绝并说明原因；打开禁止导出后，导出工作区和导出结果都被拒绝。
- 结果区的“导出 CSV”真的写出文件（现在只弹提示）。

## 2. 范围

**做**：`refs` 表与引用字段、可含引用的文字字段（§10）；引用的查询；工作区导出、导入预览、导入（§3.5）；策略 `protection.readonly`、`protection.no_export`（§6.3 的“禁止类开关”）；`params.known`；`run.export`（CSV）；笔记插件的正文声明为可含引用；界面对应部分。

**不做（之后）**：宿主能力 `process`、`transfer`、`events`、`plugins`；依赖与导出点（§7.3）；本地插件市场；`param_decls`；清单缓存；空闲回收；第一版旧库升级；`ai.policy`、`process.allow`；正文里点击 `[[…]]` 跳转（本轮只在信息面板里列出）；给插件的引用/搜索查询接口。

## 3. 方法

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `refs.outgoing` | `RefsParams` → `RefInfo[]` | 这条资源引用了谁（按字段、出现顺序） |
| `refs.incoming` | `RefsParams` → `RefInfo[]` | 谁引用了这条资源（`source` 是对方）；不含已删除的来源 |
| `params.known` | — → `KnownParam[]` | 内核自己解释的参数；本轮：`ui.language`（plain，config）、`network.allow`（allowList，config+env）、`protection.readonly`、`protection.no_export`（deny，config+env） |
| `workspace.export` | `WorkspaceFolderParams` → `ExportResult` | 见 §5 |
| `workspace.importPreview` | `WorkspaceFolderParams` → `ImportPreview` | 只读，不改任何东西 |
| `workspace.import` | `ImportParams` → `ImportResult` | 一个事务；`fingerprint` 与预览不符则拒绝 |
| `run.export` | `RunExportParams` → `RunExportResult` | 见 §7 |

事件：引用变化时发已有的 `resource:<id>` 主题（来源和目标两边都发），不加新主题。

## 4. 引用（D321–D323）

- 类型字段声明两种：`{ "type": "ref" }`（单个引用，资源里存 `{ "ref": "<id>" }`）；`{ "type": "text" | "longtext" | "code", "refs": true }`（文字里的 `[[名称]]`）。`refs` 与 `grants`、`secrets` 可以同时出现在不同字段上；同一字段同时声明 `refs` 和 `secrets` 允许（两种记号不冲突），`refs` 和 `grants` 不允许（清单拒绝 `badRefsField`）。只看声明过的字段。
- 保存时（写入管线，同一事务）：从声明的字段里取出每个 `[[文字]]`，按名称解析成目标 id，写 `refs`（来源、字段、序号、文字、目标 id 或空）。解析规则：名称完全相等（区分大小写）且未删除的资源；多于一个时依次取：与来源同一父分组的、路径（树上位置）最靠前的。分组、环境、配置、插件状态节点不能被引用。`[[` 和 `]]` 之间不能有换行，长度上限 200；`\[[` 不算。
- **正文保持用户写的原样**，不改写（D321）。目标改名后，`resource.get`、`page.resolve` 给出的文字里，已解析的 `[[旧名]]` 换成 `[[当前名称]]`（读出时替换，按 `refs` 行）；用户再保存时写进去的就是新名称。未解析（失效）的原样显示。
- 目标被删除：`refs` 行保留，状态 `deleted`；恢复后回到 `ok`。目标被永久删除：行保留、目标置空，状态 `missing`。之后新建了同名资源：**不自动接上**（引用按 id，不按名称重新猜；用户重新保存来源时才重新解析）。
- 来源被删除：它的 `refs` 行保留但 `refs.incoming` 不列；恢复后重新列出。来源被永久删除：行删除。历史恢复、升级接管（`migrate`）之后按新内容重算 `refs`。
- 插件写入（`resources.create/update`）同样重算 `refs`；引用不是授权，插件可以写这类字段（与 D311 的授权字段不同）。
- `refs` 可随时重建：迁移时对已有资源全量重建一次；提供内核内部的重建函数并有测试。
- 搜索不变。

## 5. 导出与导入（D324–D326，§3.5 全文适用）

- 导出文件夹的内容（格式版本 1）：`manifest.json`（`format: "onedesk-export"`、`version: 1`、来源工作区名字与 id、导出时间、各项数量、应用版本）、`resources.json`（未删除的全部节点：资源、分组、环境、配置；含绑定的插件 id 与版本、父节点、顺序、外部键、参数）、`revisions.json`、`runs.json`（不含保留结果的大块内容，只有摘要与输入）、`audit.json`、`blobs/`。JSON 用两格缩进、键有序，能直接读、能 diff。
- **不含**：密钥的值（密钥字段只有名字）、界面状态、`resource_meta`、`plugin_storage`、插件状态节点（权限确认、授权的文件夹不随导出走）、已删除的资源。
- 目标文件夹必须是绝对路径，不存在或为空；在数据目录之内的拒绝；写到同目录的临时文件夹再改名。被 `protection.no_export` 禁止时 `denied`（`reason: noExport`）。审计记一行 `workspace.export`（对象是文件夹路径，摘要是数量）。
- 导入预览：读 `manifest.json` 与 `resources.json`，不改任何东西；格式或版本不认识 → `valid: false`（`reason: notExport` / `badVersion` / `unreadable`）。逐条判断：类型没有任何已安装的插件 → 跳过 `unknownKind`；绑定的版本不在、活动版本也不能接管 → 跳过 `needsVersion`；过不了类型校验 → `invalid`；带外部键且本工作区已有 → 计入 `update`；其余计入 `create`。
- 导入（一个事务，任何一条写不进去则全部不动）：每条得到新 id；父子关系、`{ "ref": id }`、`refs` 按新旧 id 对应改写；指向没被导入的资源的引用变成失效引用（保留文字）。新内容放进一个新建的顶层分组（名字 = 来源工作区名字；同名则加序号）或 `parent` 指定的分组。环境和配置节点：环境导入到环境树（同名加序号），**工作区配置不导入**（本工作区的策略不被外来数据改写，D326）。授权地址字段、密钥引用字段：照常导入，但这是用户发起的导入，算用户写入，`network.grant` 审计照记。密钥的值不存在，字段显示“未设置”。
- 导入的资源从一条 `import` 历史开始（操作者是用户）；来源的历史、运行、审计不导入。本工作区审计记一行 `workspace.import`（来源名字、数量）。
- 只读时导入被拒（`readonly`）。

## 6. 保护策略与已知参数（D327）

- `protection.readonly`、`protection.no_export`：布尔参数，合并规则“任何一层为真即禁止”。层：工作区配置 →（有环境时）环境父链。
- `readonly` 拒绝：`page.save`、资源的新建/改/删/恢复/永久删除/移动/改名/排序、`tree.createGroup`、导入、撤销升级与版本切换带来的改写、插件的 `resources.*` 写入与 `storage` 写入、运行（因为运行会写运行记录——**运行整个被拒**，`denied/readonly`）。**不拒绝**：界面状态、收藏与最近使用、审计、密钥的增删改、参数本身的修改（否则关不掉）、插件的启用停用与安装移除。
- 哪一层生效：树上的操作和命令只看工作区配置；`page.save`、`run.start` 带着标签页的环境，看工作区配置加那个环境的父链（§6.3）。
- `no_export` 拒绝：`workspace.export`、`run.export`（`denied/noExport`）；界面的“复制结果”不归内核管，本轮外壳在 `no_export` 生效时把“复制结果”“导出”禁用并说明原因（需要内核告诉界面：`page.resolve` 的结果或 `PageDescriptor` 上按“只增”加 `restrictions: string[]`，值为 `readonly`、`noExport`；字段名定死为 `restrictions`）。
- 错误：`denied`，`params.reason` = `readonly` / `noExport`，`params.layer` = 生效的那一层的节点 id（界面可据此说“由工作区配置限制”或“由环境 X 限制”）。
- `params.known`：配置页、环境页的“添加参数”里列出已知参数；类型按 `KnownParam.type`；`EnvParam.restricted`（已有）继续用于“被上层限制”。

## 7. 结果导出（D328）

- `run.export`：只对输出是表格的、已结束的运行；`format` 只有 `csv`。RFC 4180：逗号分隔、CRLF、含逗号/引号/换行的字段加引号、引号加倍；UTF-8 带 BOM（Excel 能直接打开中文）；第一行是列名。路径必须是绝对路径、父目录存在、文件不存在；在数据目录之内的拒绝。运行结果被截断过的，导出的是保存下来的那部分，`rows` 如实返回。审计 `run.export`。
- 外壳：桌面用系统“另存为”对话框，浏览器模式用输入路径的对话框（与安装插件相同的做法）。

## 8. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3–§7 的内核与工作进程部分；迁移 0008（`refs` 若已有表则补列，不改已发布的迁移） | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改） |
| 外壳（Sonnet） | 信息面板“引用”一节（引用了 / 被引用，状态徽标，点了打开）；删除确认里的被引用数；导出、导入（预览对话框）入口放在设置菜单和命令面板；配置页、环境页“添加参数”列出已知参数；只读、禁止导出时的提示与禁用；结果区“导出 CSV”；新增原因码与审计操作名的文字；另修 `todo.md` 里“第四轮验收”标出的外壳两条（升级后“上次运行”与结果区不一致；密钥页“使用者”显示名称） | 同前 |
| 插件与测试（Sonnet） | 第一阶段：笔记插件正文字段声明 `refs: true`（及 vitest）；`e2e/fixtures/exports/` 下一个手写的导出文件夹（含两条互相引用的笔记、一条本机没有插件的类型、一条外部键与已有资源相同的）和一个坏的导出文件夹。第二阶段（合并后）：`e2e/round5.spec.ts` | 同前 |

## 9. 完成标准

- 内核必须有的测试：清单 `refs` 字段的每种拒绝；保存后 `refs` 行正确（多处、重复、转义、超长、跨行不算）；同名解析的三条规则；改名后读出的文字是新名称且库里正文没变；删除/恢复/永久删除三种状态；永久删除后新建同名不自动接上；插件写入重算；历史恢复重算；迁移后全量重建；导出的每个文件的内容与“不含”清单（直接读文件验证没有密钥值、没有界面状态）；目标文件夹的每种拒绝；导入：新 id、引用改写、外部键更新、三种跳过、一条失败全部不动、配置不导入、从 `import` 历史开始、指纹不符被拒；只读对 §6 列出的每一种写入都拒绝且“不拒绝”的每一种都放行；环境层只读只影响带该环境的保存与运行；`no_export`；`params.known`；CSV 的转义、BOM、已存在文件被拒、非表格输出被拒。全部用临时目录和内存密钥库。
- 外壳、测试：同前几轮（`pnpm typecheck`、`lint`、`test`、host 的测试与 clippy、假数据模式 `workbench.spec.ts` 全过且截图不变；`e2e/round5.spec.ts` 连真内核跑通）。
- 交接文件：`docs/handoff/round5-kernel-done.md`、`round5-shell-done.md`、`round5-tests-done.md`。内核的交接文件必须列全：新增的错误原因码、审计操作名、清单新增部分、协议上“只增”加的字段。
