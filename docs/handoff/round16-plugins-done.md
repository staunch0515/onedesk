# 第十六轮：新插件会话完成记录（r16-plugins）

分支 `claude/r16-plugins-fd9132`。只改了 `plugins/org.onedesk.catalog/**`、`plugins/org.onedesk.table/**` 和本文件。
插件代码的最后提交：**`813a875`**（审查修正；之前 `52dd001`、`d4ccbc9`），README 与本文件在其后单独提交。已合入协调分支 `claude/onedesk-coord-6` 的 `23d9380`。

验证：`pnpm test`（74 个文件 727 条全过，其中查询目录 35 条、表 18 条，另有公共的语言文件检查覆盖两个新插件）、`pnpm lint`（架构检查：16 个内置插件、沙箱全局对象检查通过；界面规范通过）、`pnpm typecheck` 通过。没有做 Rust 构建，也没有在真内核上跑过两个插件（需要合并内核分支后由第二阶段 e2e 验证）。没有新依赖：YAML 头与映射文件由插件自带的小解析器读取（规则 9 不涉及）。

本机没有 sqlpool 源码（`sqlpool-parity.md` 里的路径已不存在，`/Users/chloe` 下也找不到），**映射文件和查询文件头的格式是按 parity 清单和需求文档自定的**，写在 `plugins/org.onedesk.catalog/README.md`。若要与 sqlpool 的实际文件逐字一致，需要有人提供一份 sqlpool 的映射文件与查询文件样例再核对。

## A. 查询目录（`org.onedesk.catalog`）

| # | 结果 | 做了什么 | 怎么验证 |
|---|---|---|---|
| A1 | 做了 | 递归读授权文件夹里的 `.sql`（跳过隐藏项，最深 12 层、最多 5000 个），每个文件一条 `entry` 资源，外部键 = 绝对路径，一次 `resources.upsertByKey(..., { othersMissing: true })` 写入。触发：清单 `activation: ["workspace.opened"]`（X13）、树工具栏“重新索引”命令、“索引报告”页的“重新索引”动作 | `sync` 各条测试；“re-indexes when the workspace opens…” 测试调用注册的 `workspace.opened` 处理函数、命令和动作 |
| A2 | 做了 | 类型无 `tree`、无“新建”；页面 `readOnly: true`，字段都不绑定（`values` 给出正文） | “is read-only, binds nothing…” 断言没有 `bind` |
| A3 | 做了 | 同步只传 `description` 和 `body`；新条目随后用第二个批次按头部命名，被删除后恢复的条目保留用户改过的名字（审查 #8）；标签、收藏由内核按字段提交保留 | “a second sync writes only description and body…” |
| A4 | 按 D422 改了 | 不在这批里的资源由内核标为失效（`missing: true`）；目录树**照常列出**并用警告图标加“失效”徽标标出（从搜索里消失由内核负责）；页面仍能打开并显示“文件已不存在”的警告；文件回来时恢复原 id。遍历被截断（>5000 个文件或 >12 层）时这次不标失效 | “a deleted file is marked missing…”、“an entry whose file is gone still opens…” |
| A5 | 做了 | 解析 `/* --- … --- */` 或 `-- ---` 行的 YAML 头：id（必填）、title、description、params（列表/名字/映射，类型 text/number/date/datetime/time/enum，required、values、max、description）、permissions、tags、datasource。跳过原因：无头、头未闭合、YAML 错（带行号）、无 id、id 不合法、参数名/类型/重复、无正文、读不了、id 重复。原因列在“重新索引”的结果表和“索引报告”页 | “gives a reason for each file…”、“the index page lists skipped files…”、YAML 测试 |
| A6 | 做了 | `{{实体}}` → 表名、`{{实体.字段}}` → 列名；字符串、注释里的不算；不是小写或是保留字的名字加双引号；未映射的原样保留并报出；运行时有未映射的占位符就拒绝 | “replaces entities…”、“leaves unmapped placeholders…”、“refuses unmapped placeholders” |
| A7 | 做了 | `versioned` 实体换成 `DISTINCT ON (键) … WHERE from <= T [AND (to IS NULL OR to > T)] ORDER BY 键, from DESC`，有 `deleted` 列再滤掉删除版本；`T = COALESCE(CAST(:as_of AS timestamptz), now())`；没写别名时自动加 `AS "实体"`；页面多一个“截至时间”（`as_of`，UTC，带快捷值）字段 | “is the latest version in force at :as_of…”、“keeps an alias…”、“renders :as_of as a literal…”、页面字段断言 |
| A8 | 做了 | 未声明的参数、声明了未用的参数、没有映射的占位符、用了占位符但映射不可用（一条），显示为页面顶部的 `tone: "danger"` 文字（视图节点没有“警告”色，见下） | checks 两条测试、“shows warnings as a strip…”、“warns once when the mapping is missing” |
| A9 | 做了 | 提供树 `catalog`，按 id 前两段分组（`a.b.c` 在 `a › b` 下，`a.b` 在 `a` 下）；节点打开 `resource:<id>` | grouping 四条测试 |
| A10 | 做了（依赖未提供的导出） | 动作 `saveAsSql`：代入映射、保留 `:参数`，头部声明转成 SQL 插件的 `-- @param` 行，调用 **`org.onedesk.sql:create`**，输入 `{ name, description, sql, source, params }`（`params` = 页面上填的值），返回它的 `link` 输出 | “saves as SQL through the SQL plugin's create…”（假 host） |

运行：走 `org.onedesk.datasource:query`（只读），数据源取“头部 `datasource` → 环境 `datasource` → 工作区 `datasource.default`”。值写成 SQL 字面量（同 SQL 插件 D177），实际发出的 SQL 在“实际 SQL”页签；没运行时该页签显示代入映射后的语句。映射文件：设置 `mappingFile`，留空取授权文件夹顶层的 `mapping.yaml|yml|json`。导出动作 `mapping`（文字输出，归一化后的 JSON）供表插件读同一份映射。

## H. 表（`org.onedesk.table`）

| # | 结果 | 做了什么 | 怎么验证 |
|---|---|---|---|
| H1 | 做了 | 提供树 `tables`：经 `org.onedesk.catalog:mapping` 读映射；表名去掉 schema 后按 `_` 分段，表放在“除最后一段外的前缀”下（`order_line` 在 `order` 下）；表节点展开是列（映射字段名，徽标为真实列名） | tree 测试 |
| H2 | 做了 | 树工具栏命令 `toggleDepth`（一层/两层，存在插件存储里）和 `refresh`；内核在插件命令成功后重发提供树主题（protocol §4） | “the toolbar switches the depth (X9)” |
| H3 | 按现有能力改了 | 用 `information_schema.tables` 查库里有哪些表（经环境/工作区默认数据源；没有数据源或读不了就不标，概览页写明原因），名字按大小写精确比较（审查 #10）。**按 D421，这一步只在“从数据库刷新”动作的运行里做**，结果分块存进插件存储，树和页面只读存储；没有快照时树里只有一个“尚未加载”节点，指向概览页。**提供树节点还不能带状态**（内核把提供节点的 `state` 固定为 `ok`），所以缺失的表先用 `triangle-alert` 图标加“缺失”徽标表示；表页顶部有 danger 文字说明 | “marks tables the database does not have…”、“a missing or plain table says so” |
| H4 | 做了 | 表页：说明、来源（映射文件路径、实体 → 表）、版本信息、每列一个勾选框（参数，不保存；都不勾 = 全部列）、行数；“取行”动作 | “shows description, source, columns to tick…”、“fetch rows uses the ticked columns…” |
| H5 | 做了 | 五个带输入的动作：当前版本（`current`）、某条记录的历史（`history`，输入键，多列键用逗号）、某一时刻的状态（`at`）、一段时间内的变化（`changes`，`[from, to)`）、已删除的记录（`deleted`：最新版本是删除标记，或没有标记时已结束）；非版本表、缺输入给出各自的错误 | 五条生成 SQL 的精确断言 + 动作逐个调用后比对发出的 SQL + “explains missing inputs…” |

## 第十六轮审查的处理（`round16-review.md`）

| # | 处理 | 测试 |
|---|---|---|
| 1 | 按 D421：表插件新增动作 `refresh`（概览页 `page:org.onedesk.table/overview` 的主按钮，表页也有）在运行里读映射和库表并写进存储；树、表页、概览页、命令只读存储；工具栏“刷新”命令改为打开概览页；其他取数动作在运行里若没有快照就先取一次。两个插件的假 host 在没有 `runId` 时 `actions.call` 抛 `denied/notInRun` | 表：“outside a run nothing is fetched…”、“the refresh action reads… in its run…”、“an action without a stored snapshot…”；目录：“outside a run the data source cannot be called…” |
| 2 | 两个插件的“实际 SQL”都放在一个键 `sent` 里：最近 30 次运行，每条最多 6000 字符；写入失败不影响运行。不再有每次运行一个键 | 两个插件各一条“sent statements share one key…”（1100/1200 次运行后仍只有一个键；存储写入被拒时运行仍成功）。假 host 按内核的 256 KB 和 1000 键上限拒绝 |
| 5 | 存进存储的报告最多 300 条跳过记录、说明截到 200 字符，另记总数；索引报告页显示“还有 N 个”；写入失败不影响同步（运行的输出表仍是完整列表） | “the stored report stays small…” |
| 6 | 遍历前对每个文件夹 `files.stat` 取真实路径，去重后再进入；超过 5000 个文件或 12 层时 `truncated`，这次 `upsertByKey` 不带 `othersMissing`，报告和提示写明 | “a folder link back up is walked once; a cut-short walk marks nothing missing…” |
| 7 | 按 D422：失效条目留在目录树，警告图标加“失效”徽标 | “builds the tree level by level; entries whose file is gone stay, marked (D422)”、同步测试里的断言 |
| 8 | 同步批次不带名字；新建的再用一个批次按头部命名；若本次有恢复的条目，只给仍是内核默认名（路径最后一段）的条目改名 | “a deleted entry that comes back keeps the name the user gave it” |
| 9 | 参数前紧贴 `E` 或 `U&` 时，字面量里的反斜杠也加倍（catalog 部分；SQL 插件同写法归测试会话） | “E and U& before a parameter make an escape string…” |
| 10 | 存在判断不再转小写，按查询实际使用的名字精确比较 | “marks tables the database does not have…” 中的大小写断言 |
| 11 | 快照按 10 万字符一块分块存储（最多 40 块），头部记块数与长度；旧的多余块删除；块不完整视为没有快照 | “a large snapshot is stored in chunks…” |
| 17 | `mappingFile` 不是以 `/` 开头时报 `mappingNotAbsolute`，不读文件 | “a mapping file named in the settings is used…” 中的相对路径断言 |

验证（`813a875`）：`pnpm lint`、`pnpm typecheck` 通过；`pnpm test` 中查询目录 41 条、表 23 条全过。全量 753 条里有 4 条失败，都在 `plugins/_testing/lang-check.test.ts`（外壳新键缺中日译文，审查 #13，归测试会话），与本会话的文件无关。

## 需要别的会话做的（插件里没有绕过）

1. **SQL 插件导出 `create`（r16-tests 负责 `org.onedesk.sql`）**：`exports.actions: ["create"]`，动作 `create` 无 `kinds`、输出 `link`，输入 `{ name, description, sql, source, params }`，新建一条 `query`（`body: { sql, source }`）并返回 `{ output: { type: "link", label, target: "resource:<id>" } }`。“带上参数值”还需要链接能带初始页面状态（X8 的 `params`）：现在 `link` 输出没有 `params` 字段，所以值目前只会传给 `create`，打开后的表单不会自动填上——需要协调会话决定是给 `link` 输出加 `params`，还是由 SQL 插件把值写成 `-- @param … default=` 一类的声明。在这之前 A10 在真内核上会因动作不存在而失败。
2. **提供树节点的状态（内核）**：H3 要“节点状态”，提供树节点的返回里应能带 `state`/`stateReason`（例如 `broken` + 插件文字），内核目前固定为 `ok`。有了之后把表插件 `treeChildren` 里的图标+徽标换成状态即可。
3. **同步后刷新查询目录树（内核）**（表插件的“从数据库刷新”是动作，同样不会触发树刷新，用户需重新展开或点工具栏命令）：工具栏命令之后内核会重发树主题；但 `workspace.opened` 处理函数和 `reindex` 动作里调用 `upsertByKey` 后，插件的提供树不会刷新（writeText 会刷新，upsertByKey 是否刷新协议里没写）。建议 `upsertByKey` 成功后也发布本插件提供树的主题。
4. **视图文字的“警告”色**：A8 写的是“警告条”，文字节点的 `tone` 只有 `default/muted/danger`，现在用 `danger`。若要黄色警告，需要协议给文字节点加 `warning`（外壳配色）。
5. 失效资源的外壳文字 `sourceMissing` 由外壳会话按 protocol §6 配。

## 范围外

- 本机没有 PostgreSQL，生成的 SQL 只做了字符串断言，没有对真实库执行过（时间版本子查询、`DISTINCT ON`、`information_schema` 查询都只在 PostgreSQL 上成立）。第二阶段 e2e 若有临时 PostgreSQL，建议各跑一次五种版本查询和一条时间版本目录查询。
- 两个插件的格式未按 prettier 排版（仓库没有格式检查脚本，其它插件也不统一）。
