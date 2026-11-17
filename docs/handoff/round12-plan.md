# 第十二轮：阶段 5 第二部分——综合、集合、HTTP 请求补全（协调会话定，2026-11-18）

依据：`dev-plan.md` 阶段 5；`docs/requirements.md` I.10f（综合插件）、I.0g（拖拽由插件决定）、A 节（HTTP 请求）；`kernel-design.md` §5（“集合”“综合节点”两段）、§7.2（`requires.resources`）、§7.5（`resources` 一行、`kinds.handle` 的 `drop`）。沿用前十一轮的全部约定和共同规则（`round4-plan.md`–`round11-plan.md`、`coordinator-handover.md` §3–§5）。决定 D388–D392 见 `docs/decisions.md`。
本文件里的名字**定死**；协议类型由内核会话按这里的名字“只增”加进 `crates/protocol`（并 `pnpm gen:types`），外壳先按可选字段写。
注意：第十一轮的外壳收尾（内核词表改成 i18n 键，D387）可能还在另一个会话里进行；本轮外壳会话不要动 `src/workbench/i18n/kernel-texts.ts` 的结构，新文字只往 `en-US.ts` 里加。

## 1. 做完是什么样

- **综合**：新建一个“综合”节点，把树里任意插件的资源（笔记、网址、提示词、HTTP 请求…）拖到它上面——资源本身不动、不复制，综合节点下面多出一条指向它的引用；展开综合节点看到这些引用，点开就是原资源；在综合节点的页面上能看到列表（按类型的图标）、移除某一条、上移下移；移除引用不删除资源；被引用的资源删了，那一条显示为失效。综合节点可以嵌套（一个综合里放另一个综合）。
- **集合**：新建一个“集合”，填条件（类型、标签、名称或正文里的文字），它下面自动列出当前符合条件的资源，资源变了再展开就是新的结果；点开某一条就是原资源。
- **HTTP 请求**：可以选方法（GET、POST、PUT、PATCH、DELETE、HEAD）、填查询参数、请求头、正文，发出后看到状态码、耗时、大小、响应头和正文（JSON 自动排版）；失败有明确状态。
- 做完这一轮，阶段 5 的基础插件齐了（网址、笔记、提示词、HTTP 请求、语言、综合、集合、欢迎页、本地市场）；第一版旧库升级单独放下一轮。

## 2. 范围（D388）

**做**：清单 `requires.resources` 与 `ctx.host.resources.search`；插件决定的放置（类型声明 `drop`、`kinds.handle` 的 `drop`）；内置插件 `org.onedesk.composite`、`org.onedesk.collection`；HTTP 请求插件补全。
**不做（下一轮）**：第一版旧库升级；多窗口、多工作区；智能集合的保存条件之外的功能（排序规则、嵌套条件）。

## 3. 读全部资源的基本信息（D389，§7.2、§7.5）

- 清单 `requires.resources: true`（布尔；现在若已有同名字段且含义不同，以本文为准并在交接文件写明）。这是一项权限：`PluginPermission.id = "resourcesAll"`，没有明细，进安装确认与指纹；外壳文字：“读取本工作区所有内容的名称、类型和位置（不含正文）”。
- `ctx.host.resources.search({ kinds?, tags?, text?, ids?, limit?, offset? })` → `{ items: ResourceInfo[], total, next? }`。`ResourceInfo` = `{ id, name, kind, kindLabel?, icon, tree, parent?, tags, deleted }`——**没有 `body`、没有说明**。`kinds` 是类型全名的列表；`tags` 是“都含有”；`text` 走内核已有的全文搜索（名称、说明、标签、正文都参与匹配，但结果里仍只给基本信息）；`ids` 按给的 id 取（用于综合：已不存在的 id 不出现在结果里）；`limit` 默认 200、最大 500。只含未删除的，除非按 `ids` 取时资源在已删除里——那时 `deleted: true`。没声明 `requires.resources` 调用 → `denied/notRequested`。可在渲染、页面事件、运行、`children`、`drop` 里调用。
- 声明了 `requires.resources` 的插件，其自供子节点（第十轮）的 `target` 可以指向任何未删除资源的 `resource:<id>`；没声明的照旧只能指向自己可读的。
- 读正文仍然只限自己的类型和依赖导出的（不变）。

## 4. 插件决定的放置（D390，I.0g、§7.5）

- 类型声明只增 `"drop": true`；代码 `host.kinds.handle("<kind>", { drop(ctx, ev) { … } })`。`ctx` 含 `resource`（被放上去的那条资源，本插件的类型，可写）、`locale`；`ev` = `{ sources: ResourceInfo[] }`（被拖的资源的基本信息——这一条不要求 `requires.resources`：用户亲手拖上来的就给）。返回 `{ handled: true, message?: Label }` 或 `{ handled: false }`。
- 树节点只增 `dropAny: bool`：这种类型的节点对“放到它上面”接受任何资源节点（放到它前后仍按普通规则）。外壳据此允许放下；放下时仍调现有的移动方法。
- 内核在“把资源移到某个节点下面”的入口里：目标是 `drop: true` 的类型时，不移动，改为调用该插件的 `drop`；`handled: true` → 这次操作到此为止（返回结果里带可选的提示文字，外壳显示）；`handled: false` 或类型的 `accepts` 本来就接受它 → 按普通移动继续（先问 `accepts`：普通规则接受的直接移动，不问插件——综合节点嵌套综合就是这种）。处理函数出错或超时 → 操作失败（`pluginError`），什么都不动。操作者：插件（它改的是自己的资源）；审计 `tree.drop`（对象是目标资源，摘要含来源个数）。
- 插件停用时这种节点不接受放下（按普通规则）。

## 5. 内置插件（插件与测试会话）

都有英、中、日三份语言文件和假 host 的 vitest；写法照现有内置插件。
- `org.onedesk.composite`：`requires.resources: true`。类型 `composite`（树 `resources`，`children: true`，`drop: true`，`accepts: ["composite"]`——综合可以真的放进综合里；字段 `items`：资源 id 的数组，上限 1000）。`drop`：把来源的 id 追加进 `items`（已有的不重复加；来源里的综合节点不走这里——它被普通移动接走了），返回 `handled: true` 和提示“已加入 N 项”。`children`：按 `items` 的顺序给节点（`resources.search({ ids })`），每个带 `target: "resource:<id>"`、图标和名称取自基本信息；查不到的显示为失效样式的节点（用节点已有的状态字段，名称写“（已不存在）”）。页面：一张表（图标、名称、类型），行上有事件“移除”“上移”“下移”，点行打开资源；空的时候一句说明“把资源拖到这个节点上”。`legacyKinds` 不写。
- `org.onedesk.collection`：`requires.resources: true`。类型 `collection`（树 `resources`，`children: true`；字段 `kinds` 文字（逗号分隔的类型全名，可空）、`tags` 文字（逗号分隔）、`text` 文字）。`children`：`resources.search` 按条件分批给节点（每批 200，`next` 续），带 `target`；三项条件都空时不给任何节点并在页面上提示“至少填一项条件”。页面：条件表单（绑定字段，保存）+ 结果表（前 200 条与总数）。
- `org.onedesk.http`：类型 `request` 的字段补全——`method`（枚举 GET/POST/PUT/PATCH/DELETE/HEAD，默认 GET）、`query`（多行 `名=值`）、`headers`、`body`、`token` 保持；页面按 方法+地址 一行、其余分区排；动作 `send` 的输出与结果页签：状态码与状态文字、耗时、大小、响应头（表）、正文（`Content-Type` 是 JSON 时排版后显示）；HEAD 不带正文；`{{secret:名字}}` 的代入规则不变。已有的字段名不改（旧数据照常可用）。

## 6. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3、§4 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS |
| 外壳（Sonnet） | 树节点 `dropAny` 的放置（含合成的放置提示与内核返回的提示文字）；权限 `resourcesAll` 的文字；自供子节点里“失效”状态的显示核对；表格行事件按钮（移除、上移、下移）在页面上的显示核对——视图表格若还不支持行内动作，按现有视图树的能力给出最小实现并写明；新增文字（英语） | 同前几轮 |
| 插件与测试（Sonnet） | 第一阶段：§5；第二阶段（合并后）：`e2e/round12.spec.ts`，并把本轮外壳新增的英语文字补进两个语言插件的 JSON | `plugins/**`、`e2e/**`、`scripts/check-*.mjs` |

## 7. 完成标准

- 内核必须有的测试：`requires.resources` 的清单校验、权限 `resourcesAll` 进确认与指纹；`search` 的每个条件与组合、分页与 `total`、结果里没有 `body` 和说明、未声明被拒、`ids` 取到已删除的标 `deleted`、不存在的不出现、`limit` 上限；有此权限的插件自供子节点的 `target` 可指向任意资源、没有的不行。`drop`：清单校验、未声明注册被拒、`dropAny` 出现在节点上、放到上面调用插件且资源不移动、`handled: false` 走普通移动、`accepts` 接受的不问插件、出错与超时什么都不动、插件停用时按普通规则、`ev.sources` 只有基本信息、审计。全部用临时目录。
- 外壳、插件：同前几轮；假数据模式 `workbench.spec.ts` 全过、截图不变。
- `e2e/round12.spec.ts` 连真内核跑通。交接文件 `round12-kernel-done.md`、`round12-shell-done.md`、`round12-tests-done.md`。
