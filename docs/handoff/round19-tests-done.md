# 第十九轮 tests 会话：第一阶段完成

- `scripts/check-arch.mjs`：新增内核禁用词 `sqlpool`、`list_tables`、`run_sql`、`search_queries`、`describe_query`、`run_query`。`mcp` 没有禁（它是内核通用命令前缀）；协议文件出来后如需再加，我再改。`pnpm lint` 通过。
- `e2e/_mcp/mcp-client.ts`：假 MCP 客户端（JSON-RPC 行，标准输入输出；initialize/listTools/callTool/close，记录 stderr 与非 JSON 的 stdout）；`fake-server.mjs` + `mcp-client.spec.ts` 自测通过。
- `e2e/round19.spec.ts`：脚手架 + 33 条 `test.fixme`（默认全关、各工具、各条拒绝、限流、截断、审计、ai_visible、应用开着/没开、外壳），每条写明断言。待填：onedesk-mcp 路径与参数名、协议命令名与错误码（`round19-protocol.md`）。
- 第二阶段（填实、中日译文）等协调会话通知。
