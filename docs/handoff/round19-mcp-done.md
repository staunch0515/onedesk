# 第十九轮 · r19-mcp 完成记录

分支 `claude/cranky-chandrasekhar-e48477`。

## 做了什么

- **`crates/mcp`（新，`onedesk-mcp`）**：自己实现的最小 MCP（JSON-RPC 2.0，一行一条消息）：`initialize`（版本协商 2025-06-18 / 2025-03-26 / 2024-11-05）、`ping`、`tools/list`、`tools/call`，通知不回；其余 `-32601`。**无新依赖**（没用现成 MCP 库；所以不需要在 decisions.md 里登记，规则 9 不触发）。不认识任何插件：`tools/list` = 内核 `mcp.tools`，`tools/call` = 内核 `mcp.call { name, arguments }`（`names.rs` 是命令名唯一出处，与 `round19-protocol.md` §4 一致）。
  - 工具结果：`content` 的 JSON 文本 +（对象时）`structuredContent`；内核说 `truncated` 时多一段说明文字；内核错误 `{code, params}` → `isError: true`，文本就是这个 JSON（不是 JSON-RPC 错误）。`tools/list` 遇 `denied/aiOff` → JSON-RPC 错误并说明“在工作区 AI 设置里打开”。
  - 启动参数：`--workspace <id|名字|文件夹>`（默认=最近打开的那个，即应用默认）、`--data-dir`、`--print-config`（打印 `claude_desktop_config.json` 条目）。环境变量 `ONEDESK_MCP_IDLE_MS`（无界面工作进程的空闲退出，默认 5000）。
  - 不开网络端口，只用标准输入输出和本机套接字。
- **应用开着**：`crates/host/src/mcp_socket.rs`：`<数据目录>/mcp.sock`（路径过长则 `/tmp/onedesk-<uid>-<hash>.sock`），权限 0600 + 每个连接校验对端 uid == 本用户。第一行握手 `{hello:"onedesk-mcp", protocol, workspace?, clientName?}`；之后只放行 `mcp.*` 方法（其余 `denied/mcpOnly`）。连接的 `client` 由主进程自己定（`ai:mcp-<n>`，不信对端写的），并用 `Host::mark_ai_client` 登记；主进程转发时给请求盖操作者章（见下“待接”）。`src-tauri` 启动时 `bind`+`serve`，退出时删除套接字文件。
- **应用没开**：`headless.rs` 自己起 `onedesk-worker --workspace … --plugins … --socket … --ai-client <名>`（同一内核、同一工作区锁规则）；第一次请求时起，空闲 5 秒（可配）后关连接让它退出，下一次请求再起；退出码 3（锁被占）→ 最多等 30 秒重试。`Auto` 每次请求先试应用套接字，通了就用它并让自己的无界面进程放手。
- **“AI 正在用时打开应用”**：主进程 `spawn_worker` 遇到退出码 3 现在会重试最多 30 秒（`LOCK_WAIT`，原先立刻失败），所以应用等 AI 的无界面进程空闲退出后再起；反过来 `onedesk-mcp` 遇到锁忙也等。
- **打包**：`tauri.conf.json` 的 `externalBin` 加 `binaries/onedesk-mcp`（装进 `.app/Contents/MacOS/onedesk-mcp`，与 worker 同处）；`scripts/prepare-bundle.sh` 一并编译、复制；`src-tauri/build.rs` 对两个 sidecar 同样处理（stand-in）。
- **给外壳的路径**：主进程方法 `app.mcpInfo`（不转给工作进程，在 `Host::request` 里处理）→ `{ path, exists, config }`，`config` 是可直接粘进 Claude Desktop 配置的 JSON 文本；`ONEDESK_MCP_BIN` 可覆盖路径（测试/开发）。**这是协议新增，需协调会话按规则 10 决定并通知外壳与 mock**（我没动 `crates/protocol`；方法名常量在 `onedesk_host::mcp_socket::APP_MCP_INFO`）。
- **测试**：`crates/mcp/tests/mcp.rs`（假工作进程 `fake-mcp-worker`）：握手与错误、无界面启动/参数/默认工作区/空闲退出后重起、内核错误→isError 与截断提示、未知工作区、锁等待与等待上限、应用开着走套接字且只放行 `mcp.*`（含 hello 错误、对端写的 client 被忽略）、应用等无界面进程放锁、套接字路径。

## 已补（合并 claude/onedesk-r19 后）

- `Conn::send` 把 `actor`（`ai:<名>`，由 `mark_ai_client` 登记）写进 `Request.actor`；窗口连接永远不带 actor。
- 真内核测试 `real_kernel_headless_is_the_ai_operator`、`real_kernel_through_the_app_socket_is_the_ai_operator`：总开关默认关 → `aiOff`（不是 `aiOnly`）证明两条路径上都是 AI 操作者；窗口自己调 `mcp.tools` 得 `aiOnly`。需要先 `cargo build --workspace`（要 target 里的 onedesk-worker）。

## 需要协调会话 / tests 会话处理

- **`pnpm lint`（check-arch）现在会失败**：`crates/host`（`lib.rs:790`、`mcp_socket.rs:29`）里有字符串 `"ai:"`，命中禁用词 `ai`。内核/协议里同样会出现这个操作者前缀，需要 r19-tests 在 `scripts/check-arch.mjs` 里给 `"ai:`/`ai:` 前缀（或这两处）开例外；我不改 `scripts/check-*.mjs`。
- `app.mcpInfo` 要不要进 `crates/protocol` 的 `method19`（外壳 `ProtocolClient` 才能调）。

## 范围外
- 应用的“退出时删套接字”只在正常退出；崩溃留下的陈旧文件由下次 `bind`/连接（拒绝连接即视为没开）处理。

## D450 审查修项（合并 claude/onedesk-r19 后）

| # | 做法 | 测试 |
|---|---|---|
| ① | 客户端名 = `initialize.clientInfo.name`（按内核规则清理、≤40）+ `-<进程随机后缀>`，只取第一次 `initialize`；套接字握手和 `--ai-client` 都用它 | `session_is_named_after_the_mcp_client_with_a_suffix` |
| ② | 去掉主进程的全局 client 表；新 `Host::request_as(client, actor, …)`，套接字每个请求直接带 `ai:<名>`；带 actor 的请求只进工作进程（不碰 `app.*`）；`ai:` 开头的 client id 无 actor → `denied/reservedClient`；WebSocket 带这种 client → 403 | host `d450_the_ai_client_namespace_belongs_to_the_mcp_socket` |
| ③ | `Host::bind_ai_client`：不 `touch_last_opened` | host `d450_an_ai_connection_does_not_become_the_last_opened_workspace` |
| ④ | `src-tauri` 先 `bind` 套接字再 `Host::start`（等锁期间客户端在套接字上排队，握手最多等 90 秒）；`bind_client`/`switch_workspace` 在拿 ops 锁**之前**用 `wait_unlocked` 探测等锁（已在运行的工作区不等），不再持 ops 锁等 | host `d450_waiting_for_a_locked_workspace_does_not_block_other_operations`；mcp `a_client_arriving_while_the_app_is_still_starting_queues_on_the_socket` |
| ⑤ | 无界面启动前像应用一样 `install_builtin` + 刷新 `.index`，并带 `--builtin`（来源 `plugins::bundled_dir()`：`ONEDESK_BUILTIN_PLUGINS` 或 `.app/Contents/Resources/plugins`） | `headless_worker_is_told_the_built_in_packages` |
| ⑥ | 按字节读行，上限 4 MiB；超长/非 UTF-8/非 JSON → `-32700` 后继续 | `a_bad_line_does_not_end_the_session` |
| ⑦ | `BackendError::Lost`（已发出后连接断）：`mcp.call` 不重发，只读的 `mcp.tools` 重试一次；`notifications/cancelled` 未做（可选） | `a_tool_call_lost_in_flight_is_not_sent_again` |
| ⑧ | `src-tauri` 只在自己 `bind` 成功时记录路径，退出只删它；第二次 `bind` 失败不动第一个 | `binding_twice_keeps_the_first_socket_and_paths_are_per_user` |
| ⑨ | 回退路径 = `$TMPDIR/onedesk-<hash>.sock`（每用户目录）；`SocketConn::connect` 校验服务端 uid（`peer_is_me`） | 同上（路径）；uid 校验只测了“自己通过”，别的 uid 的对端没法在测试里造 |
