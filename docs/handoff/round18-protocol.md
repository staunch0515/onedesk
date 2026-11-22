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

---

## 9. 内核会话补充（第一版，名字不变；只补精确字段、错误码、边界）

下面各条以内核实现为准；与上文冲突处以这里为准。**有三处写法与上文字面不同（名字没变，只是落在已有类型里的形式），请相关会话照这里写：**
- (a) 结果区动作的触发是现有的 `run.start`（这个代码库里没有叫 `action.call` 的请求），多一个可选入参 `resultRun`；
- (b) 资源引用字段的 `kinds` 里写 `"@implements:onedesk.ai.chat/1"` 这样的字符串项（`ViewField.kinds` 仍是 `string[]`，协议类型不改），不写对象；
- (c) 现有 `resources.search` 已存在（入参 `text`，返回 `{items,total,next}`），新写法用 `query`，返回数组，两种按入参名区分（见 9.2）。
- 另：内核里“插件的资源类型”完整名是 `<pluginId>:<kind>`（冒号，不是斜杠）。

### 9.1 X5 结果区动作

**清单** `contributes.resultActions`，每项只许这些键：`id`（必填，同一插件内唯一，`[a-z0-9_-]`）、`label`（必填，文字键）、`icon`（可选）、`outputTypes`（必填，非空，取值 `table`/`text`/`link`/`none` 的子集，不重复）、`action`（必填，必须是本插件 `contributes.actions` 里的动作 id，且该动作**不带 `kinds`**——它作用于一次运行的结果，不作用于某个资源）。写错 → 安装拒绝，`badResultActions`。

**协议新增**（`crates/protocol`，只增）：
```ts
// 请求 result.actions
type ResultActionsParams = { runId: string; locale?: string };
type ResultAction = {
  plugin: string;          // 提供它的插件 id
  id: string;              // 清单里的 resultActions[].id
  action: string;          // 完整动作名 "<plugin>:<action>"，直接作 run.start 的 action
  label: string;           // 已按 locale（缺省 en-US）本地化的文字
  icon?: string;
  enabled: boolean;
  disabledReason?: string; // 码：pluginDisabled | readonly | noExport
};
// result.actions 返回 ResultAction[]
// RunStartParams 新增可选字段
//   resultRun?: string     // 点击结果区动作时填：被点击的那次运行的 id
```
- `result.actions`：运行不存在 → `notFound/run`；运行没结束、不是 `success`、或没有输出（`output` 为空）→ 返回 `[]`。否则列出所有已启用插件里 `outputTypes` 含该运行输出类型（`output.type`）的结果区动作，顺序＝插件 id、清单顺序。插件被禁用或版本未确认不列出（不是 `enabled:false`，直接没有）。**`enabled:false` 的情形**：运行所在环境（含祖先）的 `protection.readonly`（点击会写运行记录；`disabledReason: "readonly"`）或 `protection.no_export`（结果交给插件处理等同导出；`"noExport"`）为真。
- 点击：外壳调 `run.start`，`action` = `ResultAction.action`，`resultRun` = 那次运行 id，`env_id` 用被点击运行的 `envId`，其余同普通动作。内核检查：`resultRun` 给了，则该动作必须是某个 `resultActions` 声明的目标，否则 `invalid/notResultAction`；运行不存在 → `notFound/run`；运行不是 `success` 或没有输出或输出类型不在 `outputTypes` → `invalid/badResultRun`；环境禁止 → `denied/readonly`、`denied/noExport`（带 `layer`，同现有）。通过后内核把 `input.runId` 设为 `resultRun`（覆盖外壳传的同名项），动作收到 `(ctx, input)`，`input.runId` 即被点击的运行。
- `ctx.host.runs.read(runId)`：**只**在这次被点击的运行（动作执行期间）里、**只**读 `runId === 被点击的那个运行`、**只**由这个动作所属的插件读（该动作调用的别的插件，包括经 `interfaces.call` 的服务商，一律读不到）。其余一律 `denied/notInResultAction`（不在运行里也是它）。返回 `{ output, meta: { plugin, kind, resource, at } }`：`output` 是运行的 `RunOutput`（表格最多 `MAX_ROWS` 行，已抹除密钥；`paged` 的表只有头 200 行），`meta.plugin` 产出它的插件 id，`meta.kind` 运行的 `resourceKind`（可无），`meta.resource` 资源 id（可无），`meta.at` 运行结束时间（毫秒）。
- 审计：`runs.read` 一行（actor＝读取的插件，object＝运行 id，摘要 `{ rows? }`，不含内容）。被拒的同样记 `failed:denied`。

### 9.2 X6 搜索

- `search.query`（`SearchQueryParams`，外壳用）新增可选：`mode?: "all"|"any"`、`rank?: "none"|"relevance"`、`kinds?: string[]`（与旧的 `kind` 同时给则两者都要满足）。`kinds` 项：完整名 `<pluginId>:<kind>`；不含冒号的是“插件内 id”，只在**宿主接口**里按调用方插件解析。外壳的搜索结果顺序在 `rank: "relevance"` 时按相关度。
- 宿主接口 `ctx.host.resources.search(opts)`：
  - 旧写法（入参有 `text`，返回 `{ items, total, next }`）**不变**；新增可选 `mode`、`rank`（对它同样生效，`rank:"relevance"` 时 `items` 按相关度）。
  - 新写法：入参有 `query`（与 `text` 二选一，都给 → `invalid_params`）→ 返回数组 `[{ id, kind, name, snippet, score }]`（`kind` 完整名；`snippet` 是命中处前后各约 40 字符的正文片段，没有正文命中则空串；`score` 数字，越大越相关，`rank:"none"` 时恒为 `0`）。`limit` 默认 20，最大 200。
  - `kinds` 项不含冒号时＝调用方插件自己的资源类型；其余同 `reach.rs` 现有规则（`requires.resources` 才能搜，只搜用户在树里看得到的资源，不含已删除/缺失的）。
- **分词与匹配**：按空白切词，小写。≥3 字符的词走三字符索引，更短的词走模糊匹配（同 L7）。`mode:"all"`（默认）＝每个词都要命中；`mode:"any"`＝至少一个词命中。词数上限 16。
- **相关度**（`rank:"relevance"`）：每个命中的词得 `1 + min(正文出现次数, 10) × 0.1`，名称里出现再加 `3`；各词相加＝`score`。同分按名称、id。`rank:"none"` 时顺序同现状。
- 候选上限 2000（超出的按名称截掉）。

### 9.3 X15 插件接口

- 清单两个**顶层**字段（与 `depends`/`exports` 同级）：
  - `implements`: `{ "<接口>": { "actions": ["chat", …], "kind": "connection" } }`。接口名只能含 `[a-z0-9._-]` 加一个 `/` 和版本 `[0-9]+`（`onedesk.ai.chat/1`）。`actions` 非空，每个必须在本插件的 `exports.actions` 里（所以导出的动作不能带 `confirm`）；`kind` 必须是本插件自己的资源类型（短 id）。同一接口只能声明一次。
  - `uses`: `["<接口>", …]`，格式同接口名，不重复。
  - 写错 → 安装拒绝 `badImplements`（`detail` 说明哪里）。
- `ctx.host.interfaces.call(接口, 动作, 输入, { resource })`：**只在运行里**（否则 `denied/notInRun`；事件处理函数里同样）。顺序检查：
  1. 调用方清单没有 `uses` 该接口 → `denied/notUsed`。
  2. `resource` 缺或不是字符串 → `invalid_params`；资源不存在 → `notFound/resource`。
  3. 资源的类型所属插件没有声明实现该接口，或声明了但 `kind` 不是这个资源的类型 → `invalid/wrongInterface`。
  4. 该插件被禁用、或没有任何已启用插件实现该接口，或 `动作` 不在该接口的 `actions` 里 → `invalid/noImplementation`（动作不在时多一个 `action` 参数）。
  5. 同 `actions.call`：嵌套最多 4 层，回到已在链上的插件 → `denied/callDepth`。
  - 被调用方**以自己的身份**在同一次运行里执行（自己的沙箱、网络授权、密钥；**资源由内核交给它**当作 `ctx.resource`，并可用资源里保存的密钥引用，D318）；调用方这次运行的环境策略（`network.allow`、`process.allow`）照样约束它；调用方的动作预算在等待期间暂停（同长请求，最多 1 小时）；被调用方有自己的动作时限（60 秒，不含它等网络/程序的时间）。取消沿用同一次运行的取消。
  - 被调用方推的 `runs.partial` 就是这次运行的部分输出（类型按调用方的动作声明的输出类型检查）。
  - 返回动作的返回值（JSON，原样；数据文件 `output.file` 的交接规则同 `actions.call`）。
  - 审计：一行 `interfaces.call`，actor＝被调用方插件，object＝`<接口>:<动作>`，摘要 `{ caller, ms, ok }`。被拒的记 `failed:denied`（object＝接口名）。
- `ctx.host.interfaces.list(接口)`：同样需要 `uses`（否则 `denied/notUsed`），不限运行；返回 `[{ plugin, kind, label }]`——已启用的实现方，`kind` 完整名 `<pluginId>:<kind>`，`label` 是该插件的 `name`；顺序按插件 id。
- 资源选择器：`ViewField`（`kind:"ref"`）的 `kinds` 里可写字符串项 `"@implements:<接口>"`，内核（`fill_ref_options`）展开成所有实现了该接口的插件的连接类型；要求页面所属插件声明了 `uses` 该接口（没声明则该项被忽略）。可以与普通项混写。
- 内核不知道接口里写的是什么，名字当字符串。

### 9.4 X16 长请求与流式

- `timeoutMs`：运行中（动作执行期间，含被 `interfaces.call`/`actions.call` 调用的动作）上限 `600000`；页面/事件处理函数里仍是 `60000`（超过按上限处理，不报错，同现状）。**`stream: true` 且没给 `timeoutMs` 时默认 `600000`（运行中）/`30000`（别处，但 `stream` 本来只许运行中）；不流式的默认仍 `30000`。**
- `stream: true` **只许在运行里**，否则 `denied/notInRun`。
- `idleTimeoutMs`：整数 `1…600000`，默认 `120000`，**只对 `stream: true`**：响应头到了之后，两块数据之间超过它没有新数据 → `invalid/timeout`（`request` 抛）；响应头本身在 `timeoutMs` 内到。不带 `stream` 时给了也忽略。
- `onChunk(text)`：回调；`text` 是 UTF-8 解码后的字符串，**绝不把一个字符切成两半**（不完整的尾巴留到下一块；响应结束时剩下的非法字节按 U+FFFD 交出）；内核按块到达的顺序一个一个等回调返回（`await`）才交下一个，所以回调可以是异步的；回调里能调 `runs.partial` 等一切宿主接口。回调抛错 → 立刻断开连接，`request` 抛同一个错误。一块可能是网络上的一个或几个片段（不保证与服务器的 `write` 一一对应）。
- 密钥抹除：每块里已代入的密钥值（及编码形式）按 `***` 抹掉；为不漏掉被切在两块之间的密钥，只在这次请求用了密钥时内核会把每块的末尾最多 `最长密钥长度 − 1` 个字符先留一下，随下一块或结束时交出（不用密钥则无延迟）。
- 返回值（`stream: true`）：`{ status, headers, body: "", text: "", bytes, streamed: true, truncated }`——`body` 与 `text` 同值（现有名是 `body`，文档里的 `text` 也给），2xx 时为空串；**非 2xx 时 `body`/`text` 保留前 8KB（已抹除）**，同时正文照样全部经 `onChunk`。`bytes` 是收到的总字节数；`truncated` ＝是否因 `maxBytes` 停止。`maxBytes` 默认 8MB，最大 64MB（只对 `stream: true` 可提；到了就立即断开连接并按 `truncated: true` 返回，已交出的块不收回）。不带 `onChunk` 的 `stream: true` 也可以（只要 `bytes`/前 8KB）。
- 取消：运行被取消时立刻丢弃连接（不等下一块），`request` 抛 `denied/cancelled`；运行结束时仍在跑的流同样被丢弃。
- 总时限：运行的动作预算在 `network.request` 等待期间暂停（同 `process.run`/`transfer.*`，最多 1 小时），所以 10 分钟的请求不会被 60 秒的动作预算打断；`timeoutMs` 是它自己的总时限（含等响应头和全部正文）。
- 审计、主机白名单、本机地址、重定向、密钥代入、`network.allow`：全部沿用；审计摘要多一个 `"stream": true`（有流时），仍不记正文。**不记 `idleTimeoutMs` 以外的任何内容。**
- 新增错误码：无（超时是已有的 `invalid/timeout`，取消是已有的 `denied/cancelled`）。

### 9.5 错误码总表（本轮新增）

| 码 | 来自 |
|---|---|
| `denied/notInResultAction` | `runs.read` |
| `denied/notUsed` | `interfaces.call`、`interfaces.list` |
| `invalid/noImplementation` | `interfaces.call` |
| `invalid/wrongInterface` | `interfaces.call` |
| `invalid/notResultAction` | `run.start`（带 `resultRun` 但动作不是结果区动作） |
| `invalid/badResultRun` | `run.start`（来源运行不能用） |
| `notFound/run` | `result.actions`、`run.start` |
| 安装拒绝 `badImplements`、`badResultActions` | 清单 |

（`denied/readonly`、`denied/noExport`、`denied/notInRun`、`denied/cancelled`、`denied/callDepth`、`invalid/timeout`、`notFound/resource` 是已有的码。）
