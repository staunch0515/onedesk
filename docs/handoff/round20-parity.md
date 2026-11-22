# 第二十轮：sqlpool 90 项逐行验收（`r20-parity`）

依据：`docs/redesign/sqlpool-parity.md` §3 的 90 行与 §5 的验收方法；`round20-plan.md` §1 第 3 条。验收人：独立会话（只读源码，没有改内核、插件、外壳）。

## 1. 结论

| 结果 | 行数 |
|---|---|
| 通过 | 77 |
| 按新需求改了（写明改成了什么） | 5 |
| 不通过 | 0 |
| 未验证（写明原因） | 8 |

**没有 sqlpool 可对照。** `sqlpool-parity.md` 里的 sqlpool 路径（`/Users/zhongpingxue/quizbuks/sqlpool`）在这台机器上不存在，查询目录插件 README 也说明了这一点。所以“同一份查询目录、同一个 PostgreSQL，两边结果行相同”这一条用 **psql 直接查同一个库、手写等价 SQL 作为对照**：A6、A7、A10、C4、D8、E1、F3、H4、H5、K11 的结果行都与 psql 逐行相同。其余行按 §3 的需求文字验。

**“通过”的含义**：在真运行的内核（`onedesk-devhost`，真工作进程）、真 PostgreSQL 17（临时 `initdb`）、浏览器里的外壳（Playwright chromium）里把这一行的事做了一遍；不是看单元测试。

## 2. 缺陷（交协调会话派发；本会话没有修）

**复验（`c771eaf`，r20-polish 的修复，在临时工作树上重跑 `e2e/parity`）**：缺陷 1（K11）已修——`pg_catalog.pg_user` 现在被拒，7 种越权写法仍全拒；缺陷 2（G2）已修——界面拖放生效（`G2-env-drag-c771eaf.png`）；缺陷 4 外壳侧已改（配置页显示数据源名 Shop、不再显示原始 id，`recheck-config-page-c771eaf.png`；r20-polish 说内核 `pages.rs:197` 把引用压成文本是根因，仍待协调会话派内核）；缺陷 5 复验时整套 E–H 没有再出现，r20-polish 也没能复现（48 次正常）；缺陷 3（内核）未修，仍待派。下表的“实际”是修复前的现象，K11、G2 两行已按复验结果更新为通过。

| # | 行 | 复现 | 预期 | 实际 | 疑似归属 | 严重度 |
|---|---|---|---|---|---|---|
| 1 | K11 | 打开 `mcp.allow_free_query`，用 `onedesk-mcp` 调 `org_onedesk_table__run_sql`，sql=`SELECT usename FROM pg_catalog.pg_user LIMIT 2`（映射里只有 `orders`） | 只对映射过的表运行（sqlpool 的第五个工具；`SELECT … FROM ord_line`——库里有、映射里没有——是被拒的） | 系统目录 `pg_catalog.pg_user` 被放行并返回行（用户名；`passwd` 列是 `********`） | 插件（`org.onedesk.table` 的 `aiRunSql` 词法检查）；根本边界是只读事务 + 只读角色 | 中（工具默认关；第十九轮验收把“黑名单挡不住未列入的函数”记为已接受，但“未映射的表被拒、系统目录放行”不一致，应补全：系统 schema 一并拒） |
| 2 | G2 | 环境视图（Environments）→ 全部展开 → 把 “Team A”（有一个子环境）拖到 “Team B”（没有子环境）那一行的中间松手 | 改父子关系（G2 的需求；资源树里把 SQL 拖进分组是好用的，B2 通过） | 没有任何变化（节点 `accepts:["core:env"]`、`draggable:true`；手动 `mouse` 拖和 Playwright `dragTo` 两种都不生效）。协议 `tree.move` 本身可用，移动后继承值立即变。截图 `G2-drag-failed.png` | 外壳（树的拖放：疑似“放进”一个没有子节点、`expandable:false` 的节点不被接受；资源树里的分组是 `expandable:true`） | 中（需求是“拖动改变父子关系”，现在只能用协议） |
| 3 | A2 | 协议 `page.save` 对查询目录条目改 `{"body.sql":"DROP TABLE x"}` | 条目是只读的（“类型声明为不可编辑”），保存应被拒 | 被接受，库里的正文变成 `DROP TABLE x`，之后“运行”“另存为 SQL”用的就是它，直到下一次“重新索引”才恢复；文件始终没动；界面没有入口改它 | 内核（`page.save` 对 `readOnly` 页没有按字段拒绝） | 低（只有协议客户端能触发；AI 接口的 `run` 不改页面） |
| 4 | F5/G（显示） | 把工作区默认数据源设成某个数据源，再打开“工作区配置”页（左下角齿轮） | `datasource.default` 显示数据源的名字（环境页对引用参数显示名字：G3 里 `display` 是 “Other”） | 工作区配置页显示的是原始 id（`9199c85d0be109830eeceb0228330c43`，截图 `L10-settings.png`） | 外壳（配置页没有走与环境页相同的引用显示） | 低 |
| 5 | F6（偶发） | 同一页面里先建好第一个数据源，再 New → Data source，在“Connection string”里填连接串，点“Import connection string” | 主机/端口/库/用户被填入 | 在刚建过第一个数据源的页面里连续做，e2e 里有几次没有填进表单（库、用户仍是空）；刷新页面后重做，单独循环 6 次全部正常。最后一次整套重跑没有再出现 | 外壳或数据源插件（页面状态竞态，原因没查） | 低，偶发 |

另外发现、不算缺陷的行为差异都写在行结果里（B2 删除分组、D7 导出目录、G5 层级气泡、G6 每页签环境、K10 密钥位置）。

## 3. 没能验证的 8 行（原因）

| 行 | 原因 |
|---|---|
| F2 | 密码存钥匙串：库、清单、数据目录里搜不到密码、资源里只有名字引用都验了；但测试内核用内存钥匙串（规则不许碰用户的真钥匙串），写入 macOS 真钥匙串这半没有验证 |
| F3 | 经 ssh 的数据源：ssh/docker 是 e2e 的假程序（在本地 shell 里执行同一条命令，psql 是真的），没有连真服务器和真容器；本机没有可登录的主机，也不允许改 `~/.ssh` |
| F7 | “钥匙串一次运行只读一次”要观察真钥匙串的授权弹窗，内存钥匙串做不到 |
| I4 | 经 ssh 运行：真 `/usr/bin/ssh` 被启动、不问密码（对不存在的主机立刻返回 ssh 自己的 “Could not resolve hostname”）；读 `~/.ssh/config` 的别名和成功登录没有验证 |
| J1 | 备份一键流程：用假 ssh/docker（pg_dump/pg_restore 是真的）逐步走通——新库有 4 行、新直连数据源已建、转储文件在备份文件夹；真服务器、真 Docker 容器没有验证（本机没有 docker） |
| K5 | 发给 Anthropic：只对本机的假服务验证了协议、请求头、流式；没有连真实 Anthropic（规则不许），密钥用的是内存钥匙串 |
| K8 | 生成结果检查：SQL 的全部拒绝/接受情形验了；服务器命令、本机脚本生成时“危险词给警告”那一半没有在界面逐条验证 |
| L10 | 设置页：截图里看到的“工作区配置”页只有工作区参数；映射文件（`mappingFile`）、资料文件夹（`docFolder`）是插件设置，导出文件夹是首次导出时询问并记住的目录（不是设置项）。四项在界面上是否都找得到，需人工看一遍插件设置页 |

此外**用户在桌面窗口里的画面、打包的 `.app`、Claude Desktop 本身**都没有验证（浏览器外壳 + devhost）。D7 的系统文件夹选择器只在桌面窗口里出现，这里测的是浏览器里的路径输入框。

## 4. 做法与证据

- 脚本：`e2e/parity/`（`support.ts` 记录器与 psql 对照；`parity-1` A–D，`parity-2` E–H，`parity-3` I–J，`parity-4` L，`parity-5` K1–K10，`parity-6` K11）。运行方式（需要先 `cargo build` 出 devhost/worker/mcp）：

```bash
ONEDESK_DEVHOST_BIN=<devhost> ONEDESK_MCP_BIN=<onedesk-mcp> TMPDIR=/private/tmp/claude-501/t E2E_PORT=1471 pnpm exec playwright test e2e/parity/parity-1.spec.ts
python3 e2e/parity/make-report.py   # 由 results.json 生成 docs/handoff/_parity_rows.md（第 5 节的行，手工并入本文件）
```

- 每行结论与一句话证据：`docs/screenshots/parity/results.json`；截图在同目录（`<行号>-….png`）。下表是它的汇总。
- 真内核用的是 `target/debug` 下的第十九轮构建（`3e5333b` 之后），外壳是当前工作树的 vite；插件是当前工作树的 `plugins/`。内核只读，没有碰 `~/Library/Application Support/onedesk*`，没有 `git push`。
- 假程序：ssh/scp/docker 用 `e2e/fake-tools.ts`（只在 I3/I5、F3、J1 用到，已在对应行标明）；AI 用 `plugins/_testing/fake-ai`。

## 5. 逐行结果

| 行 | sqlpool 的功能 | 结果 | 做了什么 / 看到什么 | 证据 |
|---|---|---|---|---|
| A1 | 把一个文件夹里的 `.sql` 文件建成索引；启动时和按“重新索引”时同步 | **通过** | 重启后自动同步（激活=工作区打开）；新增文件按“重新索引”进入索引（6 条） |  |
| A2 | 文件是源头，应用不改文件；查询只读 | **通过** | 条目页只读；对条目发保存请求、运行、重新索引、删除再恢复后，目录里没有应用造成的文件改动（recent.sql、items.sql 字节不变，无新增删除） |  |
| A3 | 同步后保留收藏、标签、历史 | **通过** | 同步后正文/说明更新，同一资源 id；名称、标签、收藏、运行历史都在 |  |
| A4 | 文件被删后从搜索中消失，历史保留 | **通过** | 删文件→重新索引：资源状态 broken(sourceMissing)、搜不到、运行历史还在；文件放回后恢复 |  |
| A5 | 解析文件头部（YAML）：id、说明、参数、权限等；无法解析的文件列出原因 | **通过** | id/title/description/params/permissions 被解析；无头部、坏 YAML 的两个文件在索引报告里列出原因 |  |
| A6 | `{{实体}}`、`{{实体.字段}}` 占位符，经映射文件换成真实表名和列名 | **通过** | 行与 psql 直查同一库一致（2 行 + 8 行）；实际发出的 SQL 不含 {{ }} |  |
| A7 | 时间版本实体：`{{实体}}` 换成“某一时刻生效的最新版本”子查询；“截至时间”输入框 | **通过** | “现在”“1月10日”“4月1日”三个截至时间的结果都与 psql 手写的“某时刻生效的最新版本”一致；已删除的版本（item 3）现在不出现 |  |
| A8 | 检查：未声明或未使用的参数、没有映射的占位符，显示为警告条 | **通过** | 页面给出三种警告：未声明的 undeclared、未使用的 unused、没有映射的 {{nothing}} |  |
| A9 | 目录树按 id 的前两段自动分组 | **通过** | recent→sales›orders、lines.by_order→sales›lines、sales.top 在 sales 下、items.current→items |  |
| A10 | “另存为保存的 SQL”，带上当前参数值 | **通过** | 另存为 SQL：新资源带展开后的正文与 :min，带上当前值 20，再运行结果与 psql 一致 |  |
| B1 | 新建、编辑、保存、删除；名称、说明 | **通过** | 新建、编辑、保存、改名、删除（进“已删除”）都做过；说明字段见页面（B1-edit-page.png） |  |
| B2 | 分组（文件夹），拖动归组；删除分组时内容上移 | **按新需求改了** | 建组、协议移动、界面里拖动归组（B2-group-drag.png）均通过；删除分组的行为改了：sqlpool 是“内容上移”，OneDesk 是“分组连同内容整批进已删除、可整批恢复”（kernel-design.md 第 170 行）。实测：top-after-delete=["Shop","Recent orders","Orders by id","Other","Which A","Which B"]; trash=[{"accepts":[],"draggable":false,"expandable":false,"icon":"folder","key":"6a2f7de087fc65c415c3cc5e8ffe1d59","kind":"core:group","label":"Group G","menu":[{"icon":"undo-2","id":"deleted.restore","labe; after restore group children=["Drag me","In group"] |  |
| B3 | 新建时先开一个未保存的标签页，第一次保存才成为正式的 | **通过** | 新建 SQL 开的是“未保存”标签页，资源数不变（截图 B3-unsaved-tab.png） |  |
| B4 | “保存并运行” | **通过** | “保存并运行”：第一次保存才成为正式资源，同时运行并出结果（B3 的第二半） |  |
| B5 | 每条语句可以指定自己的数据源 | **通过** | 两条语句各指定自己的数据源，分别连到 other 与 shop 库；（取用顺序的其余两层见 F5） |  |
| B6 | 复制 SQL | **通过** | “复制 SQL”按钮：出现“SQL copied.”提示（剪贴板内容未读取） |  |
| B7 | ⌘Enter 运行 | **通过** | 光标在编辑器里按 ⌘Enter 触发一次新的运行（运行序号 #n 增加） |  |
| C1 | 从正文里认出 `:name`，跳过字符串、注释和 `::` | **通过** | 认出 since/kind/n/day/at/empty；字符串里 ':skipped'、::text/::int、注释、双引号名、$$…$$ 里的都不算 |  |
| C2 | 按参数类型生成输入框：文本、数字、日期、时间、枚举下拉；必填标记；最大长度 | **通过** | 文本/数字/日期/时间/日期时间/枚举下拉各有对应输入；必填缺值时拦住并点名（since）；数字、枚举、最大长度的检查见 round15 与下面 C4 |  |
| C3 | 时间选择器：UTC，可手输可选日历，带“常用时间”快捷按钮 | **通过** | UTC 日期时间输入（运行结果为 …Z）+ 常用时间菜单（since：Now / Today 00:00 / Yesterday 00:00 / 7 days ago / Start of this month；at：00:00 / 12:00），点“Now”填入当前 UTC 时间 |  |
| C4 | 空值 = NULL；值渲染成 SQL 字面量（单引号转义），不用驱动绑定 | **通过** | 空值=NULL；值以 SQL 字面量代入（单引号加倍，实际发出的 SQL 里可见），恶意值只是字符串，orders 仍 4 行 |  |
| C5 | 参数先取环境的值，没有才让用户填 | **通过** | 表单空 → 取环境的 m=7（输入框占位显示 7，结果 8）；填 100 → 用 100（结果 101） |  |
| C6 | 参数名后的图标悬停显示说明 | **通过** | 悬停 since 旁的说明图标显示“from when”（截图 C6-hover.png） |  |
| D1 | 只读执行：`BEGIN READ ONLY … ROLLBACK`，语句超时，行数上限 | **通过** | 只读事务拦住写入（含 data-changing WITH、COPY…PROGRAM、反斜杠命令），orders 仍 4 行；超时 700ms 在 941ms 内取消并报 statement timeout；30 万行结果：status=success total=300000 truncated=true |  |
| D2 | 结果表格：行数、耗时、是否截断 | **通过** | 结果表格：显示“3 rows”、耗时；截断标志见 D1 行（30 万行）与 D8 |  |
| D3 | 表头三态排序、列宽拖动、表头固定、横向滚动 | **通过** | 表头三态排序（升/降/原序）、列宽拖动（176→263px）、表头 position:sticky、横向滚动（scrollWidth 4834 > 959）；纵向“表头固定”只由 CSS 属性证明，行少没有滚动实测（D3-grid.png） |  |
| D4 | 显示实际发出的 SQL（参数已代入） | **通过** | “实际发出的 SQL”页签：参数已代入（'x''y'、NULL）；界面里的页签见 C4-sent-sql.png |  |
| D5 | 运行时整块区域显示忙碌和计时 | **通过** | 运行时结果区整块显示“Running on the data source…”与计时（D5-busy.png） |  |
| D6 | 出错信息留在结果区；失败的运行也进历史 | **通过** | 出错文字留在结果区（relation … does not exist），失败的运行进了历史页签（D6-error.png） |  |
| D7 | 导出 CSV：没设目录先问一次并记住；带 BOM | **按新需求改了** | 第一次导出弹出“导出目录”输入框、导出带 BOM 的 CSV；第二次直接写入已记住的目录（无对话框）。浏览器外壳里是文本框，桌面窗口是系统的文件夹选择器——后者没有验证（D7-ask-folder.png） |  |
| D8 | 大结果（上限内的全部行）不拖慢界面 | **通过** | 2.5 万行：总数 25000 在界面 827ms 内出现、分页读取，最后一页与 psql 一致，滚到底看到 25000（D8-25000.png）；界面期间可操作（未测帧率） |  |
| E1 | 每条查询保留最近 200 次运行：参数、时间、成功与否、行数、耗时、错误 | **通过** | 每次运行记着参数、开始时间、状态、行数、耗时；失败的记着错误文字；再对同一语句跑 205 次后“最近运行”为 200 条（≤200，每条查询保留最近 200 次） |  |
| E2 | “复用参数”：把某次运行的值填回表单 | **通过** | run.reuse 返回“打开该语句 + 当时的参数 min=5”；界面上的打开见 E3 |  |
| E3 | “最近运行”面板：跨所有查询；点开回到那条查询并带上当时的值 | **通过** | “最近运行”面板列出跨查询的运行（两条不同语句的运行都在）；点开的落点是该语句并带上当时的值 min=5（经 run.reuse）；界面双击打开的画面见 E3-run-records.png |  |
| E4 | “保留结果”：存到磁盘，有名字，记下数据源、SQL、参数 | **通过** | 保留结果：有名字“Five and up”、进“已保存”分组、记下语句与参数 min=5；（磁盘留存见 D420 与内核测试，这里未逐文件核对） |  |
| E5 | “保存的结果”面板：打开、删除（二次确认） | **通过** | “保存的结果”面板列出已保留的运行；删除先出确认、确认前什么都没删（确认后删除见下一步） |  |
| E6 | 保存的结果在自己的标签页里打开：工具栏、数据源、SQL、行 | **通过** | 保存的结果在自己的标签页打开（只读、带数据源/SQL/行；E6-saved-result-tab.png）；确认后删除，从列表消失 |  |
| F1 | 直连：主机、端口、库、用户、密码 | **通过** | 表单填主机/端口/库/用户/密码，“保存并测试”→“Connected. PostgreSQL 17…”，资源建好（F1-form.png、F1-connected.png） |  |
| F2 | 密码存钥匙串，库里只记“已保存” | **未验证** | 库里/清单/数据目录任何文件都搜不到密码，资源里只有 {secret: 名字}，页面显示“已保存”。但测试内核用的是内存钥匙串（ONEDESK_SECRET_STORE=memory，规则不让碰真钥匙串），写入 macOS 真钥匙串这一半没有验证 |  |
| F3 | 经 ssh：`ssh 主机 docker exec 容器 psql`，结果以 CSV 取回 | **未验证** | 插件构造的命令是 ssh <别名> docker exec <容器> psql …（-o BatchMode=yes -o ConnectTimeout=10 db-host docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=30000' p…），结果以 CSV 取回，行与 psql 直查相同；但 ssh/docker 是 e2e 的假程序（在本地 shell 里执行同一条命令），没有连真服务器和真容器——本机 ssh 到不了任何可用主机，也不允许改 ~/.ssh |  |
| F4 | 测试连接 | **通过** | 测试连接：对的密码→已连接 PostgreSQL 17；错的密码→“password authentication failed”（F1-connected.png 为界面） |  |
| F5 | 默认数据源；取用顺序：语句自己的 → 环境的 → 默认的 | **通过** | 语句自己的 > 环境的 > 工作区默认的，三层各自生效；都没有时报“No data source” |  |
| F6 | 从旧的连接串导入 | **通过** | 连接串 postgres://… 拆进主机/端口/库/用户；连接串里的密码不取（提示 without the password）；之后手填密码可连（F6-import.png） |  |
| F7 | 钥匙串一次运行只读一次，不反复弹授权 | **未验证** | 需要观察真钥匙串的授权弹窗次数；测试内核用内存钥匙串（不许碰真钥匙串），无法验证“一次运行只读一次”。只确认到：同一次运行里多次用同一数据源不报错 |  |
| G1 | 环境树：父子、继承、覆盖、说明 | **通过** | 父子环境：孙环境继承根的值；中间层覆盖后取覆盖值；取消覆盖回到继承值 |  |
| G2 | 拖动改变父子关系 | **通过** | 复验 c771eaf：界面里把 Team A 拖到没有子环境的 Team B 下生效，孙环境改为继承 Team B 的值（asia）（G2-env-drag-c771eaf.png）。修复前（6197af8）拖放不生效，为缺陷 2 | G2-env-drag-c771eaf.png |
| G3 | 环境可以指定数据源，子环境继承 | **通过** | 环境（Team B）指定数据源 Other；其下的子环境运行取到 Other 库（other），参数显示数据源名称而非 id |  |
| G4 | 参数表标明每个值来自哪一层；新行自动出现 | **通过** | 解析结果带来源层名（region 取自 “Team B”）；环境页（G4-env-page.png）文字：Welcome Team B Default Team B Team B Environment 1 child environment(s) Default INFO Name Location Top level / Default Kind Environment Description Tags Modified 11/22/2026, 23:53 · user Created 11/22 |  |
| G5 | 悬停显示该参数在整棵树里的所有取值 | **按新需求改了** | sqlpool 是悬停显示该参数在整棵树里的所有取值；OneDesk 改成：继承来的参数名旁有“层级”图标，点开气泡显示它在各级父环境里的取值（region in the parent environments 1 Default eu 2 Team B inherited from here asia 3 Team A），只含祖先链，不含兄弟分支，且是点击不是悬停（G5-layers-popover.png） |  |
| G6 | 当前环境在顶部栏选择 | **按新需求改了** | sqlpool 在顶部栏选一个全局环境；OneDesk 每个标签页自己选环境（工具栏右侧下拉）：标签页 A 选 Team B → 新打开标签页 B 默认沿用 Team B → 在 B 里改选 Default → 回到 A 仍是 Team B（G6-tab1-teamB.png、G6-tab-switch.png）。注意：“新建 SQL”的未保存标签页只有一个，再点“新建”会回到它，所以两个标签页要用两条已保存的语句 |  |
| G7 | 改名、删除 | **通过** | 改名；删除（连同子环境进“已删除”，可恢复） |  |
| H1 | 列出映射里的表和列，按名字前缀分组 | **通过** | 映射里的表按名字前缀分组（item_*、no_*、ord_*、orders），表页列出列（4 个列子节点）；H1-table-tree.png |  |
| H2 | 一层或两层分组的切换按钮 | **通过** | 树工具栏有“一层/两层”切换命令；切换后分组层数变化（节点列表不同），再切回原样 |  |
| H3 | 映射里有、库里没有的表标为缺失 | **通过** | 映射里有、库里没有的 no_such_table 标“缺失”，库里有的 item_ver 不标 |  |
| H4 | 表页：说明、来源、列（可勾选）、取行 | **通过** | 表页显示说明、来源表、可勾选的列；“取行”未勾列=表的全部列（5 列，行与 psql 一致），勾 customer/amount 只取这两列 |  |
| H5 | 五种版本查询：当前版本、某条记录的历史、某一时刻的状态、一段时间内的变化、已删除的记录 | **通过** | 五个动作：当前版本[1,2]、记录1的历史（2 个版本）、1月10日的状态[1,2,3]、1/20–3/1 的变化[1]、已删除[3]；各与 item_ver 的内容手算一致 |  |
| I1 | 保存的命令：分组、编辑、`:name` 参数 | **通过** | 命令可新建、放进分组、改正文；页面按 :who、:n 生成参数输入框（I1-command-page.png） |  |
| I2 | 参数值按 shell 规则加引号，不能借此插入命令 | **通过** | 7 种注入式取值（引号逃逸、$()、反引号、分号、换行、反斜杠）在真 bash 里都只是原样的一个词，注入文件未生成 |  |
| I3 | 选择在哪台服务器（ssh 别名）上运行 | **通过** | 资源字段“host”指定 ssh 别名（web-1 出现在 ssh 参数里）；以 - 开头、可被读成选项的主机名在 ssh 启动前被拒绝 |  |
| I4 | 经 ssh 运行；用 `~/.ssh/config`，不问密码 | **未验证** | 真 /usr/bin/ssh 被启动、不问密码（BatchMode）：不存在的主机立即返回 ssh 自己的“Could not resolve hostname”。读取 ~/.ssh/config 的别名、成功登录这两点没有验证——本机没有可登录的服务器，也不允许改 ~/.ssh；e2e 的假 ssh 记录到的参数含 BatchMode=yes、-- 分隔 |  |
| I5 | 输出为“流、行”两列的结果，可导出、保留、看历史 | **通过** | 输出是“流、行”两列的表（stdout/stderr 分行），可导出 CSV、可保留、在该命令的历史里 |  |
| I6 | 终端样式显示：深色底，stderr 另一种颜色 | **通过** | 终端样式：深色底（rgb(31, 35, 41)），stdout 颜色 rgb(230, 232, 235)，stderr 颜色 rgb(255, 180, 138)，两者不同（I6-terminal.png） |  |
| I7 | 输出里名字像密码的变量值打码 | **通过** | DB_PASSWORD/API_TOKEN/secret_key/Authorization: Bearer 的值被打码为 ***，普通变量 HOME_DIR 原样 |  |
| I8 | 本机 bash 脚本：保存、参数、超时、行数上限 | **通过** | 本机 bash 脚本：保存、:who 参数（注入取值只是字符串）、超时 2s 后保留已收到的行、行数上限 3、非零退出算失败且保留输出 |  |
| I9 | 把全部脚本导出为文件夹里的 `.sh` | **通过** | 全部脚本导出为 4 个 .sh（Exit-3.sh、Greeter.sh、Many-lines.sh、Slow-script.sh），都通过 bash -n 语法检查；未授权的文件夹拒绝写入 |  |
| J1 | 一键：服务器上 `pg_dump` → 下载 → 拷进本机容器 → 新建库 → `pg_restore` → 新建一个直连数据源 | **未验证** | 一键流程（服务器 pg_dump → 下载 → 拷进本机容器 → 新建库 → pg_restore → 新建直连数据源）逐步执行：新库 shop_copy 有 4 行 orders，新数据源已建。但 ssh/docker 是 e2e 的假程序（pg_dump/pg_restore 是真的、对着临时 PostgreSQL），没有连真服务器和真 Docker 容器——本机没有 docker |  |
| J2 | 找 `docker` 时查固定的几个位置（图形程序不继承终端的 PATH） | **通过** | 真内核、本机没装 docker：运行失败并点名 docker（message":"docker was not found on this Mac (notFound). Install Docker Desktop, or put docker in /usr/local/bin or /opt/homebrew/bin."},"icon":"database","id":"2）；PATH 里放一个 docker 也不被使用（固定位置查找，不读 PATH）。docker 装在固定位置时能找到这一半没有验证（本机没有 docker，也不往系统目录放文件） |  |
| J3 | 名字只接受安全字符；已有的库绝不动 | **通过** | 已存在的库（shop_copy，含手工加的一行）再次备份被拒绝，数据原样、没有 drop/--clean；库名/容器/端口/用户里的不安全字符全部拒绝 |  |
| J4 | 下载的转储文件保存在应用的备份文件夹 | **通过** | 转储文件 shop-20261122-142345.dump 保存在应用自己的备份文件夹（plugin-data/…/backups），文件头 PGDMP |  |
| K1 | 任何结果（查询的行、命令的输出）都有“分析”按钮 | **通过** | SQL 的表格结果、本机脚本的输出（别的插件）上都有“Analyze”按钮；失败的运行没有；点它只生成预览草稿，没有任何请求发出（K1-analyze-button.png） |  |
| K2 | 资料索引：把一个文件夹里的文档建成全文索引；按结果里的表名、列名挑相关文档，总量控制在预算内 | **通过** | 资料文件夹（授权后）建成文档资源；“命中任一词、按相关度排序、限定类型”的查询成立；按语句里的表名/列名挑文档（orders.md、notes.txt、billing.md），总量在预算（3000 token）内、无关文档不选 |  |
| K3 | 发送前预览完整请求，可编辑，可取消勾选文档 | **通过** | 发送前预览页显示完整请求（可编辑）与每篇文档的勾选；没点发送前没有请求发出；发送的是编辑后的文字，取消勾选的文档没有进请求 |  |
| K4 | 脱敏：敏感列、邮箱、长数字串；只发前 20 行；值截断 | **通过** | 敏感列（password、email）打码；长数字串、邮箱被替换；只带前 20 行（cust20 有、cust21 无）；长文本在 200 字处截断 |  |
| K5 | 发给 Anthropic；API 密钥在钥匙串，前端拿不到 | **未验证** | 按 Anthropic Messages 协议（POST /v1/messages、SSE 流、x-api-key 由宿主代入）发给本机的假服务：请求头与流式都对；资源、页面描述、审计、数据目录里搜不到密钥。没有连真实 Anthropic（规则不许）、密钥用的是内存钥匙串（不是 macOS 真钥匙串） |  |
| K6 | 保存分析：名称、请求、回答、模型；挂在对应的结果下；删结果连带删分析 | **通过** | 保存分析：名称、请求、回答、模型存进该结果的 run_artifacts 行（挂在那次运行下）；删除这次运行后分析一并删除 |  |
| K7 | 用 AI 生成 SQL、命令或脚本：从“说明”出发，带上相关文档和表名（不带数据） | **通过** | 从“说明”出发生成 SQL：请求带说明与相关文档、表名，不带任何数据行（ann/bob/10.50 都不在请求里）；先预览、点发送才发出 |  |
| K8 | 生成的结果先检查（SQL 必须是单条 SELECT；命令里的危险词给警告），是“提议”不是直接执行 | **未验证** | SQL：写语句、两条语句、WITH 里写、SELECT INTO 都不能接受，字符串里的 DROP 字样可以；orders 仍 4 行。服务器命令/本机脚本生成时“危险词给警告”的那一半没有在界面逐条验证（只验了 SQL） |  |
| K9 | “接受”把文字放进编辑器，作为未保存的修改 | **通过** | “接受”返回对编辑器的修改（body.sql = 提议），已保存的资源不变（即未保存的修改）；“放弃”不改编辑器 |  |
| K10 | 模型选择、密钥的保存与移除 | **按新需求改了** | sqlpool 在 AI 设置页保存/移除 API 密钥、选模型；OneDesk：密钥填在每个连接的表单里（存钥匙串，K5），移除在“密钥”页点删除；模型在连接上可“列出模型”（3 个）并在分析页选连接。删除密钥后发送失败且没有请求发出（提示：The AI service could not be reached. The request failed (denied/unknownSecret)）。密钥页的删除我走的是 secrets.delete 协议调用，没有在界面上点按钮 |  |
| K11 | MCP 服务：独立的命令行程序，供 Claude Desktop 用；只读；五个工具（搜索查询、查看查询、运行查询、列出表、对映射过的表运行单条 SELECT 并有词法检查）；自己的索引和历史；应用没开也能用 | **通过** | 复验 c771eaf：系统目录 pg_catalog.pg_user 现在被拒，未映射的 ord_line 被拒，7 种越权写法全部被拒，orders 仍 4 行；其余（应用没开时的 onedesk-mcp：tools/list、search/describe/run 行与 psql 相同、list_tables、审计）原来就通过。未验证的只有 Claude Desktop 本身、应用开着时的 mcp.sock 路径、带密码的数据源（无界面进程看不到内存钥匙串）。修复前（6197af8 时）系统目录放行，为缺陷 1 |  |
| L1 | 活动栏、侧边树、标签页、底部面板的布局 | **通过** | 活动栏（左）、侧边树、标签页条、编辑区、底部结果面板都在（L1-layout.png） |  |
| L2 | 树：展开全部、折叠全部，折叠状态记住；悬停只改背景 | **通过** | 全部展开/全部折叠两个按钮有效；单独折叠 Folder two 后刷新仍是折叠；悬停只改背景色（位置、字体、颜色、边框、内边距不变） |  |
| L3 | 标签前有类型图标 | **通过** | 每个标签页标题前都有图标（Welcome、Inside query；2 种图形） |  |
| L4 | 编辑页：面包屑、图标工具栏、参数区、编辑区 | **通过** | SQL 编辑页：面包屑与标题、图标工具栏（运行/保存/保存并运行/复制）、参数区（有 :name 时出现，见 C 组）、编辑区（L1-layout.png） |  |
| L5 | 编辑页右侧的信息面板（名称、分组、说明），分割线可拖，宽度不随内容变 | **通过** | 右侧信息面板：名称、位置、种类、说明、标签、修改/创建记录；名称填 200 字、说明填 640 字后宽度不变（194px → 194px）（L5-info-panel.png） |  |
| L6 | 所有分割线可拖动并记住 | **通过** | 界面上的分割线（Resize side panel、Resize info panel、Resize result area）逐个拖动：Resize side panel、Resize info panel、Resize result area 能拖；刷新后位置都还在（L6-splitters.png） |  |
| L7 | 搜索：3 个字符以上走索引，更短的走模糊匹配，多词同时满足；⌘K 聚焦 | **通过** | ≥3 字符走索引（budg 命中两条）；2 字符（qb）按顺序模糊命中 Quarterly budget plan、不含 Zebra；多词必须全部命中（budget draft 只命中 budget draft notes）；无匹配为空；⌘K 聚焦搜索框并列出结果（L7-search.png） |  |
| L8 | 收藏排在前面；标签可编辑、可搜索 | **通过** | 收藏的排在搜索结果和树的最前；标签在信息面板里输入（回车添加），之后按标签搜索能找到（L8-tags.png） |  |
| L9 | 短消息浮在角上，不挤动布局，自动消失 | **通过** | 提示浮在窗口右下角（position:fixed，不挤动布局：运行按钮位置不变），3.8s 后自动消失（L9-toast.png） |  |
| L10 | 设置页：目录文件夹、映射文件、导出文件夹、资料文件夹 | **未验证** | 设置页已打开（L10-settings.png）；页面文字摘录：Default ⌘ K New WORKSPACE CONFIGURATION Workspace Welcome Inside query Quarterly budget plan Workspace Workspace Workspace Configuration Add parameter INFO Name Location Top level Kind Configuration D。清单里对应 sqlpool 四个文件夹设置的：目录文件夹=查询目录插件的授权文件夹、映射文件=插件设置 mappingFile、资料文件夹=AI 插件设置 docFolder、导出文件夹=首次导出 CSV 时询问并记住（不是设置项）。设置页里这四项是否都能找到需人工对照截图 | L10-settings.png |
