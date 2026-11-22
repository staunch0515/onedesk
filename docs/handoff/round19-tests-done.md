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

## 没做（`test.fixme`）
- 应用开着时 `onedesk-mcp` 经 `mcp.sock` 连主进程：devhost 不含套接字，需 `.app`，留给手动验收。
- `run` 超过 `mcp_wait` 返回 `running`：需要慢动作夹具，沙箱里没有计时器，目前只有代码路径。

## 范围外
- 无。
