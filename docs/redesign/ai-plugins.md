# AI 插件设计（Anthropic 与 Ollama）——待你确认

状态：用户已确认（2026-11-21，D426）。排进第十八轮。依据：`sqlpool-parity.md` K 组（K1–K10）、`kernel-design.md` 9.5（结果区动作）与 §10（搜索）、`ai-interface.md`（MCP，已确认 D415，另排一轮）。

## 1. 现状检查

| 项 | 现状 |
|---|---|
| AI 插件 | **没有**。仓库里没有任何 AI 插件，也没有接 Anthropic 或 Ollama 的代码 |
| K1 别的插件给结果区加“分析”按钮（X5） | 设计里有（`resultActions`，9.5），**内核没做** |
| K2 资料索引按相关度挑文档（X6） | 设计里有，**内核没做**：现在的搜索只有“全部词命中”，没有“任一词命中 + 按相关度排序 + 限定类型” |
| K5、K10 密钥只在钥匙串、表单的密钥字段（X3） | **已有**：表单密钥字段由框架写进钥匙串，请求头里用占位符由宿主代入，插件拿不到原值 |
| 网络请求 | **已有**，但单次最长 60 秒、只能整块读回。大模型回答常超过 60 秒 → 需要补（X16） |
| 本机地址（Ollama 在 `127.0.0.1:11434`） | **已有**：本机地址默认拒绝，资源里明确写了这个主机和端口才放行（D308）。Ollama 连接正好是这种情况 |
| 运行进度 | **已有**（`RunProgress`），可以用来显示“正在生成…已用 12 秒” |
| `ai.policy` | 设计里预留了位置，**没做** |

## 2. 插件拆分

```
org.onedesk.ai               AI 工作台：分析、预览与脱敏、保存分析、资料索引、生成 SQL 的界面；不含任何服务商的代码
  ├─ 经“AI 对话接口”调用 ↓
org.onedesk.ai.anthropic     Anthropic 连接（API 密钥、模型、档位）
org.onedesk.ai.ollama        Ollama 连接（地址、模型、上下文长度）
（以后：别的服务商只要实现同一个接口就能用，AI 工作台不改）
```

- 三个都是普通插件，走同一条加载路径；内核里不出现 `anthropic`、`ollama`、`claude`、`ai` 这些插件专有的词（并入 `pnpm lint`）。
- SQL、服务器命令等插件要“用 AI 生成”（K7）时，调用 AI 工作台导出的动作，不直接调服务商插件。

## 3. AI 对话接口（`onedesk.ai.chat/1`）

服务商插件导出一个动作 `chat`，输入输出固定：

```jsonc
// 输入
{
  "system": "…",                         // 可选
  "messages": [{ "role": "user" | "assistant", "text": "…" }],
  "maxTokens": 16000,                    // 可选，服务商有默认
  "effort": "low" | "medium" | "high",   // 可选，服务商不支持就忽略
  "format": "text" | "json"              // 可选；json 时服务商尽量让回答是 JSON
}
// 输出
{
  "text": "…",
  "model": "实际用的模型",
  "usage": { "input": 1234, "output": 567 },   // 拿不到就省略
  "stop": "end" | "maxTokens" | "refusal" | "other"
}
// 出错：{ "error": { "code": "auth" | "rateLimit" | "overloaded" | "timeout" | "tooLong" | "refusal" | "network" | "other", "message": "…", "retryAfter": 秒 } }
```

另外两个导出动作：`models`（列出可选模型）和 `test`（测试连接）。“连接”是服务商插件自己的资源类型，用户可以建多个（例如“公司 Anthropic”“本机 Ollama”）。

**AI 工作台怎么找到服务商**（需要内核补 X15，见 §6）：服务商在清单里声明自己实现了 `onedesk.ai.chat/1`；AI 工作台声明“使用”这个接口。用户在 AI 设置里选“默认 AI 连接”（像数据源的 `datasource.default`，是一个资源引用参数，可以按环境覆盖）。调用时内核按连接资源的类型找到对应插件的 `chat` 动作。

## 4. 两个服务商插件

### 4.1 `org.onedesk.ai.anthropic`

| 项 | 内容 |
|---|---|
| 连接资源的字段 | 名称；API 密钥（密钥字段，只进钥匙串）；模型（从 `GET /v1/models` 取列表，也可手填）；档位 `effort`（默认 `medium`）；最大输出 `maxTokens`（默认 16000）；失败时改用备用模型（默认开，见下） |
| 网络 | 只放行 `api.anthropic.com:443`（资源声明，安装时列给你看） |
| 请求 | `POST https://api.anthropic.com/v1/messages`；请求头 `x-api-key: <钥匙串里的密钥，宿主代入>`、`anthropic-version: 2026-10-21`、`content-type: application/json` |
| 默认模型 | `claude-haiku-5-5`（用户选定，D426）；列表里还有 `claude-sonnet-5-5`、`claude-opus-5-5`，用户在连接设置里自选 |
| 思考 | 不发 `thinking` 字段（当前模型默认自适应思考，发 `disabled` 会被拒）；深浅用 `output_config.effort` 控制。不发 `temperature` 等采样参数（这个 API 版本会拒绝） |
| 拒答 | 回答 `stop_reason` 为 `refusal` 时返回 `stop: "refusal"`，界面说明“模型拒绝回答”。选 Opus 5.5 或 Sonnet 5.5 时默认带上服务端备用模型（请求头 `anthropic-beta: server-side-fallback-2026-07-01`，正文 `fallbacks: "default"`），被拒时服务端自动换模型重答，设置里可以关掉；Haiku 5.5 没有服务端备用，不发这两项 |
| 出错 | 401→`auth`；429→`rateLimit`（带 `retry-after`）；529→`overloaded`；400 且是上下文太长→`tooLong` |
| 流式 | 第一版**就用流式**（D426）：请求带 `"stream": true`，按 SSE 事件读 `content_block_delta` 里的文字，边生成边显示在结果区；`message_delta` 里取 `stop_reason` 和用量；`error` 事件按“出错”处理。流式时 `maxTokens` 默认可提到 32000 |
| 测试连接 | `GET /v1/models`，成功显示可用模型数 |

### 4.2 `org.onedesk.ai.ollama`

| 项 | 内容 |
|---|---|
| 连接资源的字段 | 名称；地址（默认 `http://127.0.0.1:11434`）；模型（从 `GET /api/tags` 取已下载的模型）；上下文长度 `num_ctx`（可选）；模型常驻时间 `keep_alive`（默认 5 分钟）；可选的认证请求头（密钥字段，给放在反向代理后面的远程 Ollama 用） |
| 网络 | 只放行地址里写的那个主机和端口。本机地址按 D308 必须明确写出才放行 |
| 请求 | `POST <地址>/api/chat`，正文 `{ model, messages, stream: true, options: { num_ctx }, keep_alive }`；回答是一行一个 JSON（NDJSON），逐行取 `message.content` 拼接、边生成边显示，最后一行 `done: true` 里取 `prompt_eval_count`、`eval_count` |
| 档位 | Ollama 没有，忽略 `effort` |
| 第一次调用 | 模型要先载入内存，可能要几十秒到几分钟，所以同样依赖 X16 的长时限；进度里显示“正在载入模型” |
| 测试连接 | `GET <地址>/api/version` 和 `/api/tags`，显示版本号和已下载的模型；一个模型都没有时提示 `ollama pull <模型>` |
| 不做 | 不在 OneDesk 里下载、删除模型（用 Ollama 自己的命令） |

## 5. AI 工作台 `org.onedesk.ai`（K1–K10）

| # | 做法 |
|---|---|
| K1 分析 | 清单 `resultActions` 给表格和文字结果加“分析”按钮（X5）。点了才把这一次运行的结果交给插件 |
| K3 预览 | 点“分析”先打开预览页：要发送的完整内容（Markdown），可编辑，可勾选、取消勾选参考文档，显示用哪个连接和模型、大约多少 token；按“发送”才发 |
| K4 脱敏 | 发送前默认处理：敏感列名（password、token、secret、email、phone 等，可在设置里加）整列打码；邮箱、长数字串打码；只带前 20 行；单元格截到 200 字。预览里看得到处理后的样子 |
| K2 资料索引 | 用户授权一个文档文件夹（同查询目录的做法），文档同步成资源；分析时按结果里的表名、列名用“任一词命中、按相关度排序”找文档（X6），总量控制在预算内 |
| K6 保存分析 | 回答可以保存：名称、发送的内容、回答、连接、模型、用量；挂在那次运行下面（`run_artifacts`），删运行时一起删 |
| K7–K9 生成 SQL | SQL 插件的“用 AI 写”调 AI 工作台导出的 `generate` 动作：带上说明、相关文档、映射里的表名列名，**不带数据**；回答先检查（只能是单条 SELECT/WITH）；是“提议”，按“接受”才放进编辑器，作为未保存的修改 |
| K10 设置 | 默认 AI 连接（资源引用参数，可按环境覆盖）；脱敏规则；文档文件夹 |
| `ai.policy` | 环境参数，三档：`off`（不许用 AI）、`preview`（必须先预览再发，默认）、`allow`（生成 SQL 这类不带数据的请求可直接发）。被环境禁止时按钮灰掉并说明原因 |
| 审计 | 每次发送记一条：谁、哪个连接和模型、发了多少字、用量；**不记内容本身**（内容在保存的分析里，由用户决定存不存） |

## 6. 内核要补的

| 编号 | 内容 | 说明 |
|---|---|---|
| X5 | 结果区动作 `resultActions` | 已有设计（9.5），照做 |
| X6 | 搜索加“任一词命中、按相关度排序、限定类型” | 已有设计（§10），照做；全文索引已经是三字符分词 |
| X15 | **插件接口**：清单 `implements: { "onedesk.ai.chat/1": { "actions": ["chat", "models", "test"] } }`，使用方声明 `uses: ["onedesk.ai.chat/1"]`；宿主给使用方 `interfaces.call(接口, 动作, 输入, { resource })`，按资源的类型找实现插件。接口名由插件约定，内核只认字符串，不知道 AI | 新的清单字段和宿主接口，按规则 10 由协调会话定、记 decisions |
| X16 | 长请求与流式（第一版就做，D426）：运行中的 `network.request` 时限上限从 60 秒提到 10 分钟，另有“两块数据之间最长 2 分钟无数据即超时”；加 `stream: true`，宿主按块把响应文字交回插件（插件自己解析 SSE 或 NDJSON），插件把已生成的文字作为运行的部分输出推给外壳实时显示；用户取消运行时立即中断请求 | 部分输出的协议字段由协调会话定死后写进任务书 |

## 7. 安全的底线

- API 密钥只在钥匙串；插件、数据库、日志、导出文件里都没有原值（规则 7）。
- 每个连接只能访问它自己声明的主机；Ollama 的本机地址必须明确写出。
- 发出去的内容用户先看得到（`preview` 是默认）；数据默认脱敏、限行。
- 生成的 SQL 只是提议，走原来的只读执行，不因为来自 AI 就放宽。
- MCP（外部 AI 客户端用 OneDesk）照 `ai-interface.md` 另做，规则不变。

## 8. 用户的决定（2026-11-21，D426）

1. 服务商经 **X15 插件接口**接入（不写死依赖）。
2. Anthropic 默认模型 **`claude-haiku-5-5`**，设置里可改 Sonnet 5.5 / Opus 5.5。
3. **第一版就做流式**（X16 含流式）。
4. 其余按推荐：`ai.policy` 默认 `preview`；选 Opus/Sonnet 时拒答自动换备用模型默认开。
5. 完成版**包含 MCP**（第十九轮）；`.app` **本机自签名**。
