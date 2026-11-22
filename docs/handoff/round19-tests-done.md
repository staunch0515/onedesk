# 第十九轮 tests 会话完成报告

## 做了什么
- `scripts/check-arch.mjs`：新增禁用词 `sqlpool`、`list_tables`、`run_sql`、`search_queries`、`describe_query`、`run_query`（`mcp` 不禁）；禁用词 `ai` 为**操作者** `ai` 开最窄例外（`scripts/check-arch-ai.mjs`，仅 `.rs`：`Actor::Ai`、变体定义行、字符串 `"ai"`/`"ai:…"`/`--ai-client`、几处固定说明文字、代码里的标识符 `ai`；`.sql` 注释行）。`org.onedesk.ai`、“AI provider”等仍禁。测试 `e2e/arch-ai.spec.ts`。
- 假 MCP 客户端 `e2e/_mcp/mcp-client.ts`（自测 `mcp-client.spec.ts`）；`e2e/_mcp/kernel-conn.ts`：`UserKernel`（devhost，操作者 user，Node 侧 WebSocket）、`AiWorker`（`onedesk-worker --ai-client`，可发任意协议方法）。
- 探针插件 `e2e/fixtures/r19-plugins/org.test.mcp`（只读 AI 动作、没声明 ai 的写动作、两个 aiTools，其一 freeQuery）。
- `e2e/round19.spec.ts`：32 条通过、2 条 `test.fixme`（见“没做”）。逐条：默认全关（总开关、资源不可见、动作不可用）；tools/list；search/describe/run/get_run（分页、别的客户端读不到）；aiTools 的 JSON Schema 六种拒绝且不起运行；自由查询开关；`mcp.env` 指向不存在 → aiEnvMissing；22 条写入/删除/安装/改设置/读密钥值请求逐条 `denied/aiNotAllowed`、数据未变、各一条 `mcp.refused` 审计；`aiOnly`；限流（第 4 次 aiRateLimit、别的客户端独立）；行数/单元格截断；策略夹取；审计（字段、摘要截断与 `***`、`source=ai` 过滤）；`ai_visible` 开关与分组“含下级”（之后新建的为 0）；无界面连接（退出码 0、无残留工作进程、无 TCP、stdout 干净）；`--workspace`；`--print-config`；浏览器里的信息面板开关、AI 设置页、复制配置片段、审计页“仅 AI”（截图 `docs/screenshots/round19-{visible,settings,audit}.png`）。
- 外壳新键的中日译文（`plugins/org.onedesk.lang.{zh-cn,ja-jp}/shell/`，共 53 个键）；`pnpm test` 全过（lang-check）。
- 运行：`ONEDESK_DEVHOST_BIN/ONEDESK_MCP_BIN/ONEDESK_WORKER_BIN` 指向共享 `target/debug`（`ONEDESK_E2E_REQUIRE_DEVHOST=1`）。自动测试不联网，密钥只在内存库。

## 发现（给内核/协调）
1. `round19-protocol.md` §6 写自由查询关闭时 `denied/aiFreeQuery`，实际内核先在 `resolve_tool` 里把该工具藏起来，答 `notFound/tool`；`aiFreeQuery` 分支（`mcp.rs` 约 529 行）不可达。两种都拒绝且不泄露；测试两者都接受。请决定改文档还是改代码。
2. `onedesk-mcp` 的客户端名固定为 `mcp`（审计里 `ai:mcp`），不取 MCP `clientInfo.name`；多个客户端共用同一个限流窗口。若要区分，需 r19-mcp 改。
3. 分组节点在窗口里没有自己的页签，“含下级”开关在 e2e 里点不到（vitest 覆盖，内核用例覆盖效果）。

## 审查 #4 之后
`check-arch-ai.mjs` 的字符串例外收紧为精确的 `"ai"`、`"ai:"`、`"ai:{名字}"`、`"ai:tool"`；`.sql` 只跳过整行注释。`e2e/arch-ai.spec.ts` 补了反例（`"ai:org.onedesk.sql …"`、`"ai:anthropic"`、`"ai:{client} extra"`、SQL 语句里 `--` 之后的词都被拦）。协调会话已定：自由查询关闭时按代码实际（notFound/tool），文档改。客户端名用例待 r19-mcp 按 D450⑤ 改完后更新。

## 没做（`test.fixme`）
- 应用开着时 `onedesk-mcp` 经 `mcp.sock` 连主进程：devhost 不含套接字，需 `.app`，留给手动验收。
- `run` 超过 `mcp_wait` 返回 `running`：需要慢动作夹具，沙箱里没有计时器，目前只有代码路径。

## 范围外
- 分组节点在窗口里没有页签，“含下级”开关的界面点击在 e2e 里做不到（接受：vitest + 内核用例覆盖）。

## 第二轮收尾（D450/D451/限流修复之后）
- `e2e/round19.spec.ts` + `e2e/round19-sql.spec.ts`：45 条全过，连续 3 次（含「限流在并发下也成立」，内核 4a709a7 之后）。新增：D450 用例（探针插件 sneak：写资源/openExternal/POST/secrets.get 均 denied/aiRun；search 无 snippet；get_run 对不可见再拒；审计 80 字符与每秒 1 行；客户端名 = clientInfo.name + 后缀；限流重启后有效；并发）、D451 限流全工作区合计（两客户端轮流）、真 PG 的 SQL 经 MCP 带参数（行数截断、缺参/错类型/未声明参数被拒、写语句不改数据）。
- 全量 e2e（ONEDESK_E2E_REQUIRE_PG=1）：388 通过，2 失败，3 跳过，10 未运行（串行用例在失败后跳过）。失败一：`round5` 的 `params.known` 清单要加上 5 个 `mcp.*`（预期内变化，已改）。失败二：`week1` “files: grant a folder…”（文件夹节点展开后出现 `docs` 页签），**在 main 上同样失败，非本轮引入**，没有处理。
- 测试环境限制：headless 的 onedesk-mcp 与 devhost 是两个进程，内存钥匙串不共享，所以带密码的数据源经 MCP 的路径要在手动验收里用真钥匙串测；SQL 用例用免密码的 PG 角色（`e2e/pg-fixture.ts` 的 `PG_TRUST_USER`）。
- 限流现在是全工作区合计：round19 的其它用例把 `mcp.rate_per_minute` 设为 600，限流用例按“窗口已用数 + 余量”设上限。
