# 第十九轮：MCP 的协议与内核接口（内核会话 `r19-kernel` 定；名字死，要改先问协调会话）

依据：`docs/redesign/ai-interface.md`、D415、D447、D448。协议类型在 `crates/protocol`（只增），TS 由 `pnpm gen:types` 生成。

## 0. 总体：谁是 `ai`

- 一个请求是不是 AI 的，由**请求信封**决定：`Request` 新增可选字段 `actor?: string`，取值 `"ai:<客户端名>"`（客户端名 `[A-Za-z0-9._ -]`，最长 64，其余字符换成 `_`，空则 `unknown`）。别的取值 → `invalidParams`。
  - **只有主进程和 `onedesk-mcp` 会写这个字段**；窗口连接的请求由主进程转发，主进程**不得**把 AI 连接的请求转成没有 `actor` 的（`r19-mcp` 负责；连接哪个套接字就固定盖哪个章，不信任对端自己写的 `actor`）。
  - 无界面工作进程：`onedesk-worker` 新增启动参数 `--ai-client <名字>`；带了它，这个工作进程上**所有**请求都当 `ai:<名字>` 处理（无视信封里写什么）。`onedesk-mcp` 没开应用时就这样自己起工作进程，不需要自己盖章。
- 内核里：`Actor::Ai { client: String }`，`as_text()` = `"ai:<client>"`，审计的 `source` 因此是 `ai`（`AuditRow.source` 本来就取冒号前）。
- **对 `ai` 默认全部拒绝**，只放行下面的白名单方法；其余任何请求（含一切写入、删除、安装、改设置、`config.*`、`secrets.*`、`files.*`、`run.start`、`page.*`…）一律 `denied/aiNotAllowed`（`params: { method }`）并记一条审计（`op = mcp.refused`，`object` = 方法名）。白名单：
  `hello`、`workspace.info`、`mcp.status`、`mcp.tools`、`mcp.call`。
- 管线层再拦一道（不靠上面的方法表）：`Actor::Ai` 提交的任何写命令 → `denied/aiReadOnly`；唯一例外是内核替它写审计行（`Stopped`/`Refused`，不改数据）。内核替它跑动作时，写运行记录用的是 `Actor::Core`。
- `mcp.*` 的三个方法**只给 `ai`**；别的操作者调用 → `denied/aiOnly`。

## 1. 数据：`ai_visible`（D448①）

- 新迁移 `0014_ai_visible_default_off.sql`：`UPDATE resources SET ai_visible = 0`（已有数据全置 0），并建触发器 `resources_ai_visible_off AFTER INSERT ON resources WHEN NEW.ai_visible <> 0` 把新行置 0（SQLite 改不了列默认值；0001 不动）。之后只有 `resource.setAiVisible` 能打开。
- 协议新增（外壳用，操作者 `user`）：
  - 请求 `resource.setAiVisible`，入参 `SetAiVisibleParams { id: string, visible: boolean, withChildren?: boolean }`（`withChildren` 对分组：连同所有未删除的下级一起设）；返回 `{ changed: number }`（改了几条）。只能对用户在树里看得到的资源用（隐藏树、环境、配置节点、已删除的 → `notFound/resource`）。审计 `resource.aiVisible`，`summary { visible, count }`。发 `tree:<tree>` 与 `audit` 事件。
  - `Resource`（`resource.get` 的返回）新增 `aiVisible`（TS 里是可选 `aiVisible?: boolean`，内核总是给；缺省当 false，所以 mock 可以先不写）。`ResourceInfo` 不加。
- AI 永远看不到：`ai_visible = 0`、已删除、`state = missing`、不在“存储树”里（环境、配置、插件状态）的资源——搜不到、`describe` 读不到（一律 `notFound/resource`，不泄露存在）、`run` 跑不了。

## 2. 清单

### 2.1 动作的 `ai`

`contributes.actions[]` 每项新增可选 `ai`：

```jsonc
"ai": {
  "readOnly": true,              // 必须是 true；插件对“只读”负责
  "description": "ai.runDesc",   // 可选，文字键（本插件 locales），给 AI 看的动作说明
  "params": [                    // 可选，静态参数声明（见 2.3）
    { "name": "limit", "type": "number", "required": false, "description": "ai.p.limit" }
  ],
  "describe": "describeParams"   // 可选：本插件另一个动作 id，动态给出参数（见 2.4）
}
```

- 没有 `ai`（或 `readOnly` 不是 `true`）的动作，AI 一律不能运行（`denied/notAiAction`）。
- 只有带 `kinds`（作用于资源）的动作能被通用工具 `run` 运行；不带 `kinds` 的动作只能经 `aiTools` 运行。
- 带 `confirm` 的动作不能有 `ai`（写错 → 安装拒绝 `badAiAction`）。`ai.describe` 指向的动作必须存在、`kinds` 包含同类型或不带 `kinds`，且**自己不能再有 `ai.describe`**。
- 写错（`readOnly` 不是 true、参数声明不合 2.3、`describe` 指向不存在/有链条）→ 安装拒绝 `badAiAction`，`detail` 说明；`ai` 里缺 `readOnly` 是清单格式错（`schema`）。文字键不存在时显示键本身（不拒绝）。插件要在 `contributes.locales` 里声明语言文件，给 AI 的说明才有英语文字。

### 2.2 `contributes.aiTools`

```jsonc
"aiTools": [
  { "name": "list_tables",                       // [a-z][a-z0-9_]{0,39}，本插件内唯一
    "description": "ai.tool.listTables",          // 文字键（必填）
    "inputSchema": { "type": "object", "properties": { "source": { "type": "string" } },
                     "required": ["source"], "additionalProperties": false },
    "action": "aiListTables",                     // contributes.actions 里的动作 id，不带 kinds，
                                                  // 且自己有 ai: { readOnly: true }
    "freeQuery": false }                          // true = 只有 mcp.allow_free_query 开着才可用
]
```

- **对外的工具名** = `<前缀>__<name>`，`前缀` = 插件 id 里每个不是 `[a-z0-9]` 的字符换成 `_`（`org.onedesk.sql` → `org_onedesk_sql`，工具 `org_onedesk_sql__list_tables`）。总长超过 64 或与别的工具重名 → 这个工具不提供（`mcp.tools` 里没有）。通用工具的名字（`search` `describe` `run` `get_run`）不含 `__`，不会撞。
- `inputSchema` 是 JSON Schema 的**子集**：`type`（`object`/`string`/`number`/`integer`/`boolean`/`array`）、`properties`、`required`、`additionalProperties`（布尔）、`enum`、`minimum`/`maximum`、`minLength`/`maxLength`、`items`、`description`、`default`（不会自动补）。出现别的关键字（`$ref`、`oneOf`…）或顶层不是 `type: "object"` → 安装拒绝 `badAiTools`。
- 内核先按它校验入参，不过 → `invalidParams`，`params: { reason: "badArguments", path: "/source", rule: "required"|"type"|"enum"|"minimum"|"maximum"|"minLength"|"maxLength"|"additionalProperties" }`，**不调用插件**。通过后，参数对象原样作为动作的 `input`，并且 `ctx.ai = { client }`（运行里可见，插件可据此识别）。
- 运行方式同通用的 `run`（有运行记录，`actor = ai:<client>`，`source = "ai"`，`in_task_panel = false`；环境 = `mcp.env`），也受行数截断。

### 2.3 参数声明 `ParamDecl`（`ai.params`、`describe` 的返回、`describe` 工具的输出共用）

`{ name: string, type: "text"|"number"|"boolean"|"enum", required: boolean, description?: string(已本地化), options?: string[](enum 时), default?: string }`。`name` 为 `[A-Za-z_][A-Za-z0-9_]{0,63}`，单个动作最多 32 个。

### 2.4 动态参数 `ai.describe`

`describe` 工具要列一条资源可用动作的参数时：有 `ai.describe` 的，内核以 `pure`（写类宿主调用被拒）、不带环境、无网络的方式调用那个动作，`ctx.resource` 是该资源，`input = {}`，期望返回 `{ output: {type:"none"}, data: { params: ParamDecl[], description?: string } }`（用已有的 `data` 字段，同 `actions.call`）；格式不对或抛错 → 该动作的参数返回空数组并带 `paramsError: <码>`，不让整个 `describe` 失败。只有静态 `ai.params` 的就用静态的。

## 3. 工作区策略 `mcp.policy`（内核读，D448④）

存在**工作区配置节点的参数**里（`config` 树，沿用 `config.get`/`config.set`，最深的定义者生效），同时登记进 `params.known`：

| 参数名 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `mcp.enabled` | boolean | `false` | 总开关。关 → 所有 `mcp.*` 调用 `denied/aiOff`（`mcp.status` 例外，照常返回） |
| `mcp.rate_per_minute` | number | `30` | 每个 AI 客户端名每 60 秒滑动窗口内最多多少次 `mcp.call`；取值夹在 1..=600；非数字用默认 |
| `mcp.max_rows` | number | `200` | 单次结果最多返回多少行（表格）；夹在 1..=2000 |
| `mcp.allow_free_query` | boolean | `false` | 允许 `freeQuery: true` 的插件工具 |
| `mcp.env` | ref | 空 | “AI 用的环境”：一个环境资源的 id（`kinds: ["core:env"]`）。空 = 不带环境运行；指向不存在/已删除的环境 → `run` 报 `invalid/aiEnvMissing`。AI 的入参里**没有**环境，也选不了 |

`protection.no_export` 对 AI 照样有效：该环境（含祖先）或工作区配置禁止导出时，`run`、`get_run` 和所有 `aiTools` 拒绝，`denied/noExport`（带 `layer`、`layerName`，同现有）。`protection.readonly` 同样拦 AI 的运行（`denied/readonly`，带 `layer`、`layerName`）：运行要写运行记录，规则同 D327；`search`/`describe` 不受影响。

只读请求 `mcp.status`（AI 和用户都可调）：返回 `McpStatus { enabled: boolean, ratePerMinute: number, maxRows: number, allowFreeQuery: boolean, envId?: string, envName?: string, tools: number }`，让外壳 AI 设置页和 `onedesk-mcp` 启动时探测；不记审计、不计限流。

## 4. 方法与工具

协议方法常量在 `onedesk_protocol::method19`：`MCP_STATUS = "mcp.status"`、`MCP_TOOLS = "mcp.tools"`、`MCP_CALL = "mcp.call"`、`RESOURCE_SET_AI_VISIBLE = "resource.setAiVisible"`。（不再有 `mcp.search` 等单独方法：所有工具都经 `mcp.call`，限流、审计、截断在一处。）

### 4.1 `mcp.tools`

入参 `{}`；返回 `McpTool[]`，`McpTool { name: string, description: string, inputSchema: object }`（`description` 是英语，`inputSchema` 就是 MCP `tools/list` 要的）。总开关关 → `denied/aiOff`。内容 = 4 个通用工具 + 所有已启用、已确认版本的插件的 `aiTools`（`freeQuery` 的在 `mcp.allow_free_query` 关时不列出）。不计限流。

通用工具的 `inputSchema`（`description` 文字内核自带英语）：

| name | 入参 |
|---|---|
| `search` | `{ query: string(1..200, 必填), kinds?: string[](≤8, 完整类型名), limit?: integer(1..50, 默认 20) }` |
| `describe` | `{ id: string(必填) }` |
| `run` | `{ id: string(必填), action?: string, params?: object(值为 string/number/boolean) }` |
| `get_run` | `{ runId: string(必填), offset?: integer(≥0, 默认 0), limit?: integer(1..2000) }` |

### 4.2 `mcp.call`

入参 `McpCallParams { name: string, arguments?: object }`；返回 `McpCallResult { content: any (JSON), truncated: boolean, rows?: number }`；任何失败都是**协议错误**（`{code, params}`，见 §6），`onedesk-mcp` 把它译成 MCP 的 `isError: true`。顺序：①总开关（`aiOff`）②限流（`aiRateLimit`）③工具存在（`notFound/tool`）④策略 ⑤参数校验 ⑥执行。**每一次 `mcp.call`（成功或失败，含被限流的）都写一条审计**（§5）。

- `search` → `content = { items: [{ id, kind, kindLabel, name, description, tags, score }], total }`（D450④：没有正文 snippet）。只搜 `ai_visible = 1`；`mode: any`、`rank: relevance`；`kindLabel` 是英语。`description` 截 400 字符。
- `describe` → `content = { id, kind, kindLabel, name, description, tags, actions: [{ action, label, description?, params: ParamDecl[], paramsError? }] }`。`actions` = 该类型上所有 `ai.readOnly` 的动作（`action` 是短 id，`run` 入参里就写它）；不返回资源 `body`（正文里可能有连接串，AI 不需要；要看内容就运行它）。
- `run` → 先校验：资源存在且 `ai_visible`；`action` 缺省时若只有一个 AI 动作就用它，多个而没给 → `invalidParams/needAction`；动作必须在 `describe` 列出的里面（`denied/notAiAction`）。`params` 里的值一律转成字符串交给 `RunStartParams.params`；**`input` 恒为空对象**（AI 不能改写资源正文，只能跑保存好的东西）。环境 = `mcp.env`。等运行结束，最多等 `KernelConfig.mcp_wait`（默认 30 秒）。`content = McpRun`：
  ```ts
  McpRun = { runId: string, status: "success"|"error"|"cancelled"|"running",
             output?: McpOutput, error?: { code: string, message?: string }, durationMs?: number }
  McpOutput = { type: "table", columns: string[], rows: any[][], total: number, offset: number, truncated: boolean }
            | { type: "text", text: string, truncated: boolean, totalChars: number }
            | { type: "link", label: string, target: string } | { type: "none" }
  ```
  `status: "running"`（没等到）时给 `runId`，让 AI 用 `get_run` 再取。
- `get_run` → 只能读**自己（同一客户端名）起的** AI 运行（`source = "ai"` 且 `actor` 相同），别的运行 → `notFound/run`。同 `McpRun`；表格从 `offset` 起最多 `min(limit, mcp.max_rows)` 行，`truncated` 表示后面还有。只读运行记录里保存的行（运行记录本身存多少由现有机制定，`paged` 的大结果只有头 200 行，`total` 照实给）。
- 插件工具（`<前缀>__<name>`）→ 同 `run` 的返回（`McpRun`）。

### 4.3 截断规则（在离开内核前做，`truncated` 如实标）

- 表格：行数 ≤ `mcp.max_rows`（`run`）/ `min(limit, mcp.max_rows)`（`get_run`）；单元格文字超过 2000 字符截成前 2000 字符并加 `…`（`truncated` 也置 true）；每次结果的 JSON 总量 ≤ 1 MiB，超了再减行。
- 文字：超过 65536 字符截断，`totalChars` 给原长。
- `search`：`limit` ≤ 50。
- 密钥值：内核不从结果里“认”密钥，靠已有的两道：①`{{secret:…}}` 只在宿主里代入，插件拿不到值；②运行结束时按该运行用过的密钥值抹除输出（`secrets::scrub`，同现有）。`McpRun` 在抹除之后才生成；审计与日志从不含参数的原值（§5）。

## 5. 审计

每次 `mcp.call` 一条，`actor = ai:<client>`，`op = "mcp.call"`，`object` = 工具名，`result` = `ok` / `failed:<错误码>`（`denied` 的是 `failed:denied`），`summary` 是 JSON：

```jsonc
{ "tool": "run", "args": { /* 参数摘要：见下 */ }, "rows": 12, "ms": 83,
  "ok": true, "code": null, "reason": null, "runId": "…", "resource": "…" }
```

- 参数摘要：字符串值截 80 字符（超出加 `…`），数组只记长度（`"[3 items]"`），对象深度 ≤ 2；名字像密钥的键（`password`、`secret`、`token`、`key`、`authorization`，不分大小写、包含即算）的值一律 `"***"`；整个摘要 ≤ 1 KiB。
- 被限流、总开关关着、白名单外方法（`op = "mcp.refused"`，`object` = 方法名）也记；失败时 `code`/`reason` 填错误码和原因，`rows`、`ms` 照实（`ms` 是内核从收到到答复的毫秒）。
- 审计页过滤：`AuditFilter` 新增可选 `source?: string`（取 `ai` 即只看操作者类型为 `ai` 的行：`actor = 'ai' OR actor LIKE 'ai:%'`）；`actor` 原有的精确匹配不变。`AuditFacets.actors` 里会出现 `ai:<client>`。
- 日志（stderr）：内核不打印参数、结果、密钥值。

## 6. 错误码（`ProtocolError { code, params }`，文字由外壳配）

| code / params.reason | 来自 |
|---|---|
| `denied` / `aiOff` | 总开关关 |
| `denied` / `aiRateLimit`，`limit`、`retryAfterMs` | 限流 |
| `denied` / `aiNotAllowed`，`method` | AI 调了白名单外的方法 |
| `denied` / `aiReadOnly` | 管线收到 AI 的写命令 |
| `denied` / `aiOnly` | 非 AI 调 `mcp.call`/`mcp.tools` |
| `denied` / `notAiAction` | 动作没声明 `ai.readOnly`，或不在该类型上 |
| `notFound` / `tool`（`what=tool`） | 自由查询工具在 `mcp.allow_free_query` 关着时不列出、也不泄露存在性，调用得到这个；`denied/aiFreeQuery` 只是内核里的纵深防御，正常到不了 |
| `denied` / `noExport`、`readonly`，`layer`、`layerName` | 环境/配置禁止导出；工作区只读时的运行 |
| `notFound` / `resource`、`run`、`tool` | 对象不存在、不可见、不是自己的运行 |
| `invalidParams` / `badArguments`，`path`、`rule` | JSON Schema 校验失败 |
| `invalidParams` / `needAction` | `run` 没给动作而有多个 |
| `invalid` / `aiEnvMissing` | `mcp.env` 指向的环境不在了 |
| 安装时 `badAiAction`、`badAiTools` | 清单写错（`detail` 说明） |

## 7. 其它协议增补

- `Request.actor?: string`（§0）。
- `KernelConfig.mcp_wait: Duration`（默认 30 秒；测试可改小）。
- `onedesk-worker --ai-client <名字>`（§0）；其余启动参数不变，`--socket` 仍只接受一个连接。**确认**：`crates/worker` 已是独立进程，不依赖任何窗口/Tauri，`onedesk-mcp` 可直接起它（`--workspace`、`--plugins`、`--socket`、`--builtin`、`--ai-client`）；退出时机仍是“连接关闭即退出”；工作区锁忙 → 退出码 3。
- 新增的 `resource.setAiVisible`、`mcp.status`、`AuditFilter.source`、`Resource.aiVisible`（外壳、mock 同步这几处）。

## 8. 给 tests 会话：内核禁用词

- **新增**（内核/协议/主进程源码里不许出现）：`run_sql`、`list_tables`、`sqlpool`、`search_queries`、`describe_query`、`run_query`（都是具体工具/插件的名字；通用工具名 `search`/`describe`/`run`/`get_run` 不禁，它们是内核的）。
- **不要**把 `mcp` 加成内核禁用词：`mcp.*` 是内核自己的方法名和参数名。

## 9. 实现备注（内核会话补）

- 搜索：`mcp.call search` 内部用 `mode: any`、`rank: relevance`，并在 SQL 里加 `ai_visible = 1`（`SearchOpts.ai_only`，不能从线上设置）。
- `Request.actor` 在主进程转发时由主进程盖章；`onedesk-worker --ai-client` 时内核无视信封。
- 工作区策略的 `mcp.env` 在 `params.known` 里登记为 `ref`；AI 设置页读写用 `workspace.getConfig` / `workspace.setConfig`。
- `crates/host/src/lib.rs` 里 `Request { … }` 字面量被迫加了 `actor: None`（一行，`r19-mcp` 合并时注意）。
- lint：`scripts/check-arch.mjs` 的禁用词 `ai` 会拦内核里的操作者 `ai`，需 tests 会话放行（已报协调会话）。

## 9. `app.mcpInfo`（D449，r19-mcp 补）

主进程自己回答（不转给工作进程；窗口和测试连接都能调，操作者 `user`）。常量 `onedesk_protocol::method19::APP_MCP_INFO = "app.mcpInfo"`（不在 `method19::ALL` 里，因为不是内核方法）。

- 请求：无参数。
- 响应 `McpInfo { path: string, exists: boolean, config: string }`：
  - `path`：`onedesk-mcp` 程序的绝对路径（发布版是 `.app/Contents/MacOS/onedesk-mcp`；环境变量 `ONEDESK_MCP_BIN` 可覆盖，供开发/测试）。
  - `exists`：此刻该路径上有没有文件（开发版没打包时为 false，外壳可提示）。
  - `config`：可直接复制进 Claude Desktop `claude_desktop_config.json` 的 JSON 文本：`{ "mcpServers": { "onedesk": { "command": "<path>" } } }`。要指定工作区，用户在 `command` 旁自己加 `"args": ["--workspace", "<名字或 id>"]`。
- 外壳 mock 需要同步这一个方法。

## 10. D450 审查后的补充（内核会话）

- **AI 运行里的宿主调用**（`run`、插件工具、`describe` 的动态参数，经 `actions.call`/`interfaces.call` 传递，`CallInfo.ai`）：只放行 `resources.get/list/search`（只返回 `ai_visible=1`）、`files.roots/list/stat/readText/find`、`settings.get`、`storage.*`、`process.*`、`interfaces.*`、`actions.*`、`params.*`、`util.*`、`runs.partial/progress`、`network.request`（只 GET、不带 body/file）与 `network.output/stop`；其余（资源写、文件写/移/删、`settings` 写、`plugins.*`、`ui.*`、`secrets.get`、`transfer.*`、成品写入）一律 `denied/aiRun`（`params.method`）。
- **限流**按审计表算：最近 60 秒内 `op='mcp.call'` 且 `actor=ai:<客户端>` 的行（不含 `aiRateLimit`/`aiOff` 拒绝行）加上正在进行的调用数；跨进程、跨无界面重启仍然有效。
- **审计**：`object`/`resource`/`runId`/`tool` 截到 80 字符；`aiOff`、`aiRateLimit`、`aiNotAllowed`、未知工具这几类拒绝，同一客户端同一原因每秒最多写 1 行，被省掉的次数记在下一条的 `summary.suppressed`。
- **`run` 参数**：一律按动作声明（静态 `ai.params` 或 `ai.describe` 的答复）校验：名字、类型、枚举、必填（没给 `params` 也检查）、≤ 32 个键、值 ≤ 1000 字符；没有声明的动作不接受任何参数。插件 `describe` 的答复按 §2.3 清理并截断（描述 400、选项 ≤ 50 个每个 ≤ 200），格式不对 → `describe` 里 `paramsError`、`run` 里 `pluginError/badOutput`。
- `get_run` 再查一次资源可见性（用户关掉后读不了，`notFound/run`）；`run` 等结束用事件通知，不轮询。
