# 第十八轮：协议与宿主接口的名字（协调会话先定死；内核会话可以补细节，但**不改已写的名字**）

所有会话照这里写。内核会话第一次提交就把本文件里它认为需要补充或改的地方改好并告诉协调会话（只能补细节、补错误码，名字变动要先问）。协议类型 `crates/protocol` 只增不改。

## 1. X5 结果区动作 `resultActions`

清单 `contributes.resultActions`：

```jsonc
"resultActions": [
  { "id": "analyze", "label": "action.analyze", "icon": "sparkles",
    "outputTypes": ["table", "text"],      // 对哪些结果类型出现
    "action": "analyze" }                  // 本插件导出的动作名
]
```

- 外壳用 `result.actions`（新请求，入参 `{ runId }`）取这次运行结果上可用的结果区动作：`[{ plugin, id, label, icon, enabled, disabledReason? }]`（label 已按该插件语言本地化）。内核按 `outputTypes` 过滤，并排除已被策略禁用的（`enabled: false` + `disabledReason` 码）。
- 用户点了才调用：现有的“调用动作”请求（`action.call`），入参里 `args.runId`；内核把该运行的结果交给目标插件的 `ctx.host.runs.read(runId)`（**只有被点击的那一次动作期间、且只有被点击的那个运行**能读；平时读不到，`denied/notInResultAction`）。读到的是 `{ output, meta: { plugin, kind, resource?, at } }`，表格最多 `MAX_ROWS` 行。
- 动作按普通动作返回（可以返回页面引用 `{ page: … }` 打开预览页，沿用已有的“动作打开页面”）。

## 2. X6 搜索

`search` 请求（已有）增加可选入参：

```ts
mode?: "all" | "any";          // 默认 "all"（现状）；"any" = 任一词命中
rank?: "none" | "relevance";   // 默认 "none"；"relevance" = 按相关度（命中词数、词频；标题/名称命中加权）
kinds?: string[];              // 限定资源类型 id（完整限定名 `plugin/kind` 或插件内 id，沿用现有的写法）
limit?: number;
```

另给插件宿主接口 `ctx.host.resources.search({ query, mode, rank, kinds, limit })`，返回 `[{ id, kind, name, snippet, score }]`；插件只能搜到自己有权读的资源（同现有 `resources.*` 的规则）。全文索引仍是三字符分词；不足 3 字符的词走模糊匹配（同 L7）。

## 3. X15 插件接口

清单：

```jsonc
// 实现方
"implements": { "onedesk.ai.chat/1": { "actions": ["chat", "models", "test"], "kind": "connection" } },
// 使用方
"uses": ["onedesk.ai.chat/1"]
```

- `implements.<接口>.kind` = 该插件里“连接资源”的类型 id；`actions` = 必须导出的动作名（清单检查：必须出现在 `exports.actions`）。
- 内核只认字符串：`name/version`，不理解内容。使用方没声明 `uses` 调用 → `denied/notUsed`。
- 宿主接口：`ctx.host.interfaces.call(接口, 动作, 输入, { resource })` → 返回动作的返回值（等同 `actions.call` 的审计、权限、`denied/notInRun` 规则）。`resource` 是资源 id；内核按该资源的类型找到声明了 `implements` 且 `kind` 相符的插件，调它的动作。找不到 → `invalid/noImplementation`；资源类型不实现该接口 → `invalid/wrongInterface`。
- `ctx.host.interfaces.list(接口)` → `[{ plugin, kind, label }]`（有哪些实现；用来做“连接”下拉）。
- 清单里用一个资源引用参数选默认连接时，该参数的 `kinds` 可写 `{ "implements": "onedesk.ai.chat/1" }`，表示“任何实现了这个接口的类型”（外壳的资源选择器按它列出）。
- 调用在使用方的运行里发生，运行期限和取消沿用；被调用方在同一次运行中执行（不新开运行），它推出的部分输出（`runs.partial`）作为使用方这次运行的部分输出显示。

## 4. X16 长请求与流式

`ctx.host.network.request(opts)` 增加：

| 字段 | 说明 |
|---|---|
| `timeoutMs` | 在**运行中**（动作执行期间）上限提到 `600000`（10 分钟）；事件处理函数里仍是 60 秒 |
| `idleTimeoutMs` | 可选，默认 `120000`：流式时两块数据之间超过它没有新数据 → 结束，抛 `invalid/timeout` |
| `stream: true` | 响应按块交回，见下。`stream` 请求的 `maxBytes` 上限仍有效（默认 8MB，可提到 64MB） |
| `onChunk(text)` | 回调，**仅 `stream: true`**：每收到一块响应正文就同步调用一次，`text` 是按 UTF-8 解码的字符串（不会把一个字符切成两半）。回调里可调 `runs.partial`。回调抛错 → 中断请求并把错误抛给 `request` 调用 |

- `stream: true` 时 `request` 在响应结束后返回 `{ status, headers, text: "" , bytes, streamed: true }`（正文已经交给 `onChunk`，不再整块返回；**错误状态码（4xx/5xx）的正文也走 `onChunk`**，插件自己解析错误；另外返回值里 `text` 对非 2xx 响应保留前 8KB 方便报错）。
- 用户取消运行 → 立即断开连接，`request` 抛 `denied/cancelled`。
- 密钥占位符、本机地址放行、主机白名单、审计、抹除全部沿用；`onChunk` 收到的文字已抹除密钥。
- 审计行不变（不记正文）。

## 5. 部分输出（已有）

沿用 `ctx.host.runs.partial(output)`（第十七轮 §2.2）。AI 服务商把已生成的文字作为 `{ type: "text", text }` 推；每次推全文（不是增量）。**第十八轮不新增协议字段。**外壳在运行进行时显示 `Run.partial`；若是 Markdown 文字（`format: "markdown"`，已有则用，没有就按纯文字）。

## 6. 新错误码

| 码 | 来自 | 含义 |
|---|---|---|
| `denied/notInResultAction` | `runs.read` | 不在结果区动作的调用里 |
| `denied/notUsed` | `interfaces.call` | 使用方没声明 `uses` 该接口 |
| `invalid/noImplementation` | `interfaces.call` | 找不到实现 |
| `invalid/wrongInterface` | `interfaces.call` | 资源的类型没实现该接口 |
| `invalid/badImplements` | 安装 | 清单 `implements/uses` 写错（动作没导出等） |

## 7. AI 对话接口 `onedesk.ai.chat/1`

输入输出同 `docs/redesign/ai-plugins.md` §3。流式：服务商在 `chat` 里用 `stream: true` 读，边读边 `runs.partial({ type: "text", text: 目前全文 })`。

## 8. AI 工作台导出的动作（供别的插件调用）

- `generate`：输入 `{ kind: "sql", instruction: string, resource?: string /*数据源或映射*/, context?: { tables?: string[] } }` → 输出 `{ text, model, usage }` 或出错（`{ error }`）。本动作自己做 K8 检查（SQL 只能单条 SELECT/WITH）并在返回里带 `check: { ok: boolean, reason?: string }`。
- `analyze`：结果区动作（见 §1），打开预览页。
