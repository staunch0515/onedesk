# 第十九轮 · 插件会话完成报告（r19-plugins）

依据：`round19-protocol.md`（内核会话 `cb7737c`）。分支 `claude/brave-grothendieck-b9e115`。

## 做了什么

| 插件 | 清单 | 实现 |
|---|---|---|
| `org.onedesk.sql` | `run` 加 `ai: {readOnly:true, description:"ai.runDesc", describe:"aiParams"}`；新动作 `aiParams`（不带 kinds，`output:none`） | `aiParams` 由 `-- @param` 声明给出 `ParamDecl[]`（name/type/required/description/options；date、datetime、time 作 text，说明里写格式）。`run` 在入参里没有 `body.sql/body.source` 时用资源已保存的正文和数据源（AI 的 `input` 恒为空） |
| `org.onedesk.catalog` | 同上（`entry` 类型的 `run`） | `aiParams` 取头部 `params`，`as_of` 在版本表上自动出现；读不到映射时按原文给参数（describe 是纯调用） |
| `org.onedesk.table` | `aiTools`: `list_tables`（`freeQuery:false`）、`run_sql`（`freeQuery:true`）；对应动作 `aiListTables`、`aiRunSql`（不带 kinds，自己有 `ai.readOnly`） | `list_tables`：只读映射，一列一行（实体、表、字段、列、说明、是否版本表），可 `filter`。`run_sql`：前置词法检查（单条、首词 SELECT/WITH、无反斜杠命令、≤20000 字符，拷自数据源的 `scanSql`），再经 `datasource:query`（`inline`、`maxRows` 默认 200 最多 2000、`timeoutMs` 15000）；数据源内部仍是 `BEGIN READ ONLY … ROLLBACK`、`refuse()` 再查一遍 |

- 其它动作（`create`、`newHere`、`aiWrite`、`aiFetch`、`saveAsSql`、`reindex` 等）**不**声明 `ai`：它们写资源或发给模型。测试里逐个断言。
- 译文：三个插件的 `locales/` 英、中、日都补了（`ai.*`、`action.aiParams` 等），测试要求三种语言键齐全。
- 测试：`plugins/org.onedesk.{sql,catalog,table}/main.test.ts` 各新增 “for AI clients” 一节（声明、参数说明、空入参运行、自由查询每条拒绝且拒绝时不碰数据源、行数上限、译文）。`pnpm typecheck`、`pnpm lint`、`pnpm test` 通过（1137 个）。

## 第⑤项：真内核走一遍（已做）

方法：无界面 `onedesk-worker`（`CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target`，合并 `claude/onedesk-r19` 后重建）加全部内置插件；先以用户身份起一次（`mcp.enabled`、数据源、SQL 查询、`resource.setAiVisible`、给目录插件授权放映射文件的文件夹），再用 `--ai-client probe` 重起，直接对着行格式的套接字发 `mcp.tools`、`mcp.call`。脚本在会话草稿目录，不入库。

发现并修掉的问题：
1. **`describe` 的动态参数放错了地方**：协议文档写 `{output, params}`，内核实际读 `{output, data: {params, description?}}`（`crates/kernel/src/mcp.rs` `describe_params`），我按文档写时 describe 给出 `paramsError: badOutput`。已改成 `data.params`（SQL、目录两个 `aiParams`），vitest 同步。协议文档 §2.4 应改成 `data`（内核会话的文档，没动）。
2. 其余假 host 看不出的点都没问题：

| 检查 | 结果 |
|---|---|
| 22 个内置插件全部安装通过（含 `ai`、`aiTools`、`aiParams` 不带 kinds） | 通过 |
| `mcp.tools`：自由查询关时只有 `search describe run get_run org_onedesk_table__list_tables`；开 `mcp.allow_free_query` 后多 `org_onedesk_table__run_sql`；关着时直接调 `run_sql` → `notFound/tool` | 通过 |
| `search` 只找到 `ai_visible` 的 SQL 查询 | 通过 |
| `describe`：`run` 的参数 `n`（number、必填、说明 “how many”）、`status`（enum，options new/paid） | 修后通过 |
| `run` 空 `input`：用已保存的正文，`params` 值（`n:5, status:"paid"`）渲染进语句并交给数据源（本机没有数据库，得到数据源的 “Connection refused”，说明走到了 `datasource:query`）；`n:"abc"` → 插件的参数检查文字 | 通过 |
| `list_tables`：授权文件夹里的 `mapping.yaml` → 2 行（实体、表、字段、列、说明、类型） | 通过 |
| `run_sql`：`delete from t` → “Only SELECT or WITH…”；`select 1; select 2` → “Only one statement…”；`select 1` 到达数据源 | 通过 |
| 不带 kinds 的 `aiListTables`/`aiRunSql` 不被当成资源动作 | 通过 |

没有真的数据库可连，所以没验证“成功返回行”“行数上限在数据源侧生效”“超时”；这部分由数据源的既有测试和我的单元测试（入参 `maxRows`、`timeoutMs`）覆盖。目录条目的 `describe` 与 SQL 同一实现，真内核里没单独走。

## 范围外 / 需要决定

- `run_sql` 没有把语句限制在“映射过的表”上：从语句里认表名不可靠（子查询、CTE、别名），真正的边界是只读事务、AI 环境指向的数据源和账号。如需限制，要么由数据库账号给只读且只授权映射表，要么内核/插件另定规则。
- 假设 `describe` 的动态参数动作返回 `{output:{type:"none"}, params}`（协议 §2.4）；`output:"none"` 的动作清单上已有先例（`OutputType::None`）。

## D450⑥：自由查询的函数黑名单（已做）

`org.onedesk.table` 的 `run_sql`（`aiRunSql`）在“单条 SELECT/WITH”之后，再按词检查（`sqlWords`/`forbiddenName`，在 `freeQueryProblem` 里）：
- 词取自字符串、注释、美元引号之外的文本，`"带引号的名字"` 取引号里的内容（`""` 还原），不分大小写，schema 前缀因按词拆开所以无效（`pg_catalog.pg_terminate_backend`、`"pg_catalog"."Pg_Cancel_Backend"`、注释/换行隔开都拦得住）。
- 精确：`copy`、`pg_sleep`、`pg_terminate_backend`、`pg_cancel_backend`、`set_config`、`pg_reload_conf`、`query_to_xml`、`cursor_to_xml`、`pg_notify` 等；前缀：`dblink*`、`pg_read_*`（含 `pg_read_file`/`pg_read_binary_file`）、`pg_ls_*`、`lo_*`（`lo_import`/`lo_export`）、`pg_advisory_*`、`pg_file_*`、`pg_replication_*`、`pg_logical_*`…；含 `_to_xml` 的（`query_to_xml`、`database_to_xml` 能把字符串当 SQL 跑）。
- `U&"…"` 写法的名字（能用转义拼出别的名字）整体拒绝：`ai.sql.unicodeEscape`。
- 错误文字 `ai.sql.forbiddenFunction`（带名字）英中日；`ai.tool.runSql`（给 AI 的说明，也是用户在清单里看到的）末尾写明“自由查询的数据源请使用只读数据库角色”。
- 已知限度：这是词法黑名单，挡不住 PostgreSQL 将来新增的或扩展里的有副作用函数，也挡不住字符串里的 SQL 被某个没列入的函数执行；根本边界仍是只读事务 + 只读数据库角色。
- vitest：大小写、带引号标识符、schema 前缀、注释和换行隔开、子查询/CTE/UNION 里、`COPY`、`U&""`、以及字符串/注释里出现名字不误拦。
