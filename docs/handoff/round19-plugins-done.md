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

## 还没做：第⑤项（真内核走一遍）

提交时内核会话的 `ActionDef.ai`、`aiTools` 解析还在它自己的工作树里未提交（`crates/kernel/src/manifest.rs`），我的工作树里的内核还不认识 `ai` 字段（`ActionDef` 是 `deny_unknown_fields`），所以现在**装不上**这些清单，也不能用真内核跑。待内核提交并入集成分支后，要在真内核上确认：
1. 三个插件的清单通过安装检查（`badAiAction`/`badAiTools`）；特别是 `ai.describe` 指向的 `aiParams` 不带 kinds、无 `ai`，是否被接受。
2. `mcp.call describe` 对 SQL 查询和目录条目给出 `aiParams` 的参数；`run` 空 `input` 时 SQL 能读到 `ctx.resource.body`（假 host 里 `ctx.resource` 是我假设有的）。
3. `describe` 的纯调用里 `ctx.t`、`ctx.locale` 可用（用于格式说明）。
4. `run_sql` 在 `mcp.allow_free_query` 关时 `tools/list` 里没有；开时 `ctx.host.actions.call(datasource:query)` 带 `inline` 正常。
5. “带 kinds 的动作不能用于节点”：`aiListTables`/`aiRunSql` 不带 kinds，是否会被当成要选资源的动作。

## 范围外 / 需要决定

- `run_sql` 没有把语句限制在“映射过的表”上：从语句里认表名不可靠（子查询、CTE、别名），真正的边界是只读事务、AI 环境指向的数据源和账号。如需限制，要么由数据库账号给只读且只授权映射表，要么内核/插件另定规则。
- 假设 `describe` 的动态参数动作返回 `{output:{type:"none"}, params}`（协议 §2.4）；`output:"none"` 的动作清单上已有先例（`OutputType::None`）。
