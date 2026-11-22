# fake-ai：本机假 AI 服务（测试与 e2e 用）

在 `127.0.0.1` 的一个端口上同时说 Anthropic Messages（SSE）和 Ollama（NDJSON）。**不联网、不校验密钥**（任何 `x-api-key` 都收，只记录下来）。绝不要把测试指向真服务。

```ts
import { startFakeAi } from "../_testing/fake-ai/server";
const fake = await startFakeAi();          // 端口随机；fake.url 形如 http://127.0.0.1:53123
// 连接资源里 baseUrl（Anthropic）或地址（Ollama）填 fake.url
fake.set({ kind: "ok", pieces: ["你", "好"] });
fake.once({ kind: "error", status: 429, headers: { "retry-after": "7" } }); // 只影响下一次
// …跑被测的东西…
fake.requests;                              // 每个请求的 method/path/headers/body，可断言
await fake.close();
```

## 路由
| 路径 | 说明 |
|---|---|
| `POST /v1/messages` | SSE：`message_start`、`content_block_delta`（每个 piece 一个）、`message_delta`（`stop_reason`、`usage.output_tokens`）、`message_stop` |
| `GET /v1/models` | `{ data: [{ id }] }`，用 `setModels` 改 |
| `POST /api/chat` | NDJSON：每个 piece 一行 `message.content`，最后一行 `done: true`、`prompt_eval_count`、`eval_count` |
| `GET /api/version`、`GET /api/tags` | 版本号；已下载模型（`setModels([])` = 一个都没有） |

## 行为 `Behavior`（`set` 常驻，`once` 只一次）
| kind | 效果 |
|---|---|
| `ok` | 正常。可选 `pieces`、`inputTokens`、`outputTokens`、`model`、`delayMs` |
| `error` | 直接返回 HTTP 错误：`status`、`body`、`headers`（如 401、429+`retry-after`、529、400 太长） |
| `refusal` | 正常流，但 `stop_reason: "refusal"`（Anthropic） |
| `streamError` | HTTP 200，流里出现错误事件（Anthropic `error` 事件；Ollama `{error}` 行） |
| `drop` | 发出一半 piece 后直接断开连接 |
| `slow` | 每个 piece 前等 `delayMs`（用来测取消、两块之间超时） |

`setLoading(true)`：Ollama 下一次 `/api/chat` 先发一行空内容（模拟载入模型），再发文字。

## 注意
- `fake.requests` 里 `headers` 是 Node 的小写键。
- 插件的 `requires.network.fromResources` 只放行连接里写的主机；e2e 里连接地址要写 `fake.url`（本机地址明确写出才放行，D308）。
