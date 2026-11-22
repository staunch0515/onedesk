# 第十八轮 r18-providers 完成记录

## 做了什么
- `plugins/org.onedesk.ai.anthropic`：连接资源（地址 `baseUrl` 默认 `https://api.anthropic.com`、API 密钥=密钥字段、模型默认 `claude-haiku-5-5`、`effort` 默认 medium、`maxTokens` 默认 16000 上限 32000、备用模型开关）；清单 `implements onedesk.ai.chat/1`（`chat`/`models`/`test`，kind `connection`）；`POST /v1/messages` 流式 SSE（`content_block_delta` 取字、`message_delta` 取 stop_reason 与用量、`error` 事件按出错）；头 `x-api-key: {{secret:…}}`、`anthropic-version: 2026-10-21`；不发 thinking/temperature；仅 Sonnet/Opus 且开关开着才发 `anthropic-beta: server-side-fallback-2026-07-01` + `fallbacks:"default"`；错误映射 401/403→auth、429→rateLimit(+retryAfter)、529/503→overloaded、400 太长/413→tooLong、拒答→`stop:"refusal"`；每块 `runs.partial({type:"text",text:全文})`。
- `plugins/org.onedesk.ai.ollama`：连接资源（地址默认 `http://127.0.0.1:11434`、模型、`numCtx`、`keepAlive` 默认 5m、认证头名 + 密钥字段）；`POST /api/chat` NDJSON，逐行取 `message.content`，`done` 行取 `prompt_eval_count`/`eval_count`；`test` 用 `/api/version` + `/api/tags`，无模型提示 `ollama pull <模型>`；404 模型未下载也提示 pull；载入模型时 `ctx.progress` 显示“正在载入模型…”，第一段文字到了换成“正在生成…”。
- 两者都带 `locales/`（英中日，通过 `locale-check`）；网络 `requires.network.fromResources`，地址字段 `grants: "network"`。
- `plugins/_testing/fake-ai/`：`server.ts`（本机随机端口、Anthropic SSE + Ollama NDJSON；行为 ok/error/refusal/streamError/drop/slow、`once`、`setModels`、`setLoading`、记录请求）+ `README.md`。

## 怎么验证
`npx vitest run plugins/org.onedesk.ai.anthropic plugins/org.onedesk.ai.ollama plugins/_testing/locale-check.test.ts`（99 通过）；`pnpm lint`、`pnpm typecheck` 通过。测试里 fake host 的 `network.request` 用 `fetch` 真的连假服务、按块调 `onChunk`，覆盖：增量全文、头与占位符、错误映射、流内错误、中途断开、取消（rethrow `denied/cancelled`）、拒答、models/test。没有调用真 Anthropic/Ollama，没有任何真实密钥。

## 需要协调会话/其他会话注意（接口约定）
1. **动作返回值的形状（D441）**：`chat`/`models`/`test` 返回 `{ output:{type:"text",text:<可读文字>}, data:<结构化结果或 {error:{code,message,retryAfter?}}> }`；`data` 经 `interfaces.call` 原样交给调用方。`data` 需要内核先支持（否则动作结果校验会拒绝多余字段）；只改 `finish()`。
2. 流式响应状态码在 `onChunk` 时还不知道，所以插件总是同时把块喂给解析器并保留前 8KB 原文；非 2xx 时用原文（或返回的 `text`）解析错误。若内核另给“状态码先到”的钩子可简化。
3. `network.request` 返回的非流式响应正文，已有插件读 `res.body`，协议写 `text`；两个插件两者都认。
4. 清单里额外声明的 `chat`/`models` 放进了 `contributes.actions`（带 label/icon）和 `exports.actions`；若内核要求接口动作不必出现在 `contributes`，可去掉。字段 `presets`、`number`、`boolean` 字段类型照 `view-check.ts` 用；`boolean` 的存储是字符串 `"true"/"false"`（假设，页面里没验证）。
5. Ollama 认证头：密钥字段存整个头的值（如 `Bearer …`）。

## 范围外
- 未在真内核里加载过这两个插件（内核 X15/X16 在另一会话）；清单里的 `implements`、`stream`、`onChunk`、`idleTimeoutMs`、`timeoutMs: 600000` 照 `round18-protocol.md` 写，合并后需要跑一次真加载。
- 外壳的“资源选择器按 implements 列出”由别的会话做。

## 审查修改 #10（地址规则）
两个插件的地址（Anthropic `baseUrl`、Ollama 地址）统一用 `checkBase`（手写解析，沙箱里没有 URL）：非本机（`127.0.0.1`/`localhost`/`[::1]`）必须 `https://`，否则 `error.insecure`；地址含用户信息（`https://api.anthropic.com@evil.com`，包括 `user:pw@`）一律拒绝 `error.userInfo`；空白、反斜杠、控制字符、空主机 `error.badUrl`。`chat`/`models`/`test` 在发请求前检查；`test` 抛出可读错误；编辑页下方说明行显示真实解析出的主机（含端口），地址不合规时改成红色原因。Ollama 的认证头只会发往通过检查的地址（远程必须 https）。新增 locale 键 `error.userInfo`、`error.insecure`（英中日）。注意：连接“保存”时没有插件可挂的校验钩子，所以现在是在编辑页即时显示红色原因、测试和使用时报错；若要保存时就拒绝需要内核提供校验入口。
