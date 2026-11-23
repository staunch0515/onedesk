# AI 辅助生成的统一模式（ai-assist）

状态：**用户已确认（2026-11-23，D462）**，§8 全部按推荐。第一版的实际做法见 §9（与 §3–§5 的草案有出入时以 §9 为准）。

依据：`ai-plugins.md`（AI 工作台、`onedesk.ai.chat/1`、`ai.policy`、预览与脱敏、审计，D426）、`ai-interface.md`（MCP，D415）。

## 1. 目标

- 系统里**所有能写内容的地方**都能“让 AI 帮我写”：新建内容、表单字段、编辑器正文、说明和标签、插件自己的页面（tab）。
- **同一个入口、同一套界面、同一条安全链**：插件只“声明”哪里可以辅助、给 AI 什么上下文；不画 AI 界面、不直接调服务商插件。
- 新插件**零代码**就有基本的 AI 辅助（按字段类型自动获得）；想要更好的结果再加声明。

## 2. 现状（问题）

- 只有 `org.onedesk.ai` 的 `generate` 动作，且只认 `kind: "sql"`；SQL 插件自己画了“用 AI 写”按钮。照此发展，每个插件都会各写一套按钮、预览和接收逻辑。
- 外壳不知道哪些地方可以辅助，也没有统一的“提议 → 接受”界面。

## 3. 三层分工

```
外壳（唯一的 AI 界面）  ✨ 按钮 · 辅助面板（说明输入、预览要发送的内容、结果作为“提议”、接受/放弃）
   │  assist.run { target, instruction }
内核（不认识 AI 服务商）  按声明收集上下文 → 按接口名找到实现者 → 套用策略、审计
   │  interfaces.call("onedesk.ai.assist/1", "assist", 请求)
AI 工作台插件（org.onedesk.ai）  脱敏、拼提示词、选连接、经 onedesk.ai.chat/1 调服务商
```

- 内核只认一个**接口名字符串**（X15 已有机制），不出现任何服务商名字。没有实现该接口的插件时，✨ 按钮不显示。
- 服务商插件（Anthropic、Ollama）不变。

## 4. 辅助的对象（target）

| 对象 | 外壳在哪里显示 ✨ | 结果怎么落地 |
|---|---|---|
| 新建内容 `create` | “新建”菜单每一项旁、新建对话框 | AI 按该类型的 `fields` 生成一份初始内容（JSON），作为未保存的新内容打开 |
| 字段 `field` | 表单里 `text` / `longtext` 字段、说明、标签 | 提议替换或插入，接受后成为未保存的修改 |
| 正文 `editor` | 编辑器页（代码、Markdown）的工具栏 | 提议以差异显示，接受后成为未保存的修改 |
| 页面 `page` | 插件页面工具栏（插件声明 `role: "assist"` 的动作） | 交给插件的 `apply` 处理（插件决定落到哪里） |
| 结果 `result` | 运行结果区（已有 `resultActions` 的“分析”） | 作为分析保存（现有做法） |

**一律是“提议”**：AI 的输出从不直接写入，必须用户按“接受”；接受后走原来的保存流程（可撤销、有审计）。

## 5. 清单声明（插件要做的全部）

默认：每个 `text`、`longtext` 字段**自动**可辅助，上下文 = 类型名、字段名、内容名称、说明、当前值。下面的声明都是可选的，用来提高质量或关闭：

```jsonc
"fields": {
  "text": {
    "type": "longtext",
    "assist": {                      // 省略 = 默认开；false = 关闭
      "hint": "assist.text.hint",    // 本地化键：告诉 AI 这个字段该写什么（如“SQL 查询，只读”）
      "format": "markdown",          // text | markdown | code:<语言> | json
      "context": "schema"            // 可选：插件导出的动作名，返回额外上下文（如表名列名），不含数据行
    }
  }
},
"kinds": [{ "id": "query", "assist": { "create": "assist.create.hint" } }],   // 新建时的说明
"pages": [{ "id": "editor", "actions": [{ "id": "ai", "role": "assist", "label": "action.ai" }] }]
```

插件**不许**：自己画 AI 按钮或预览、直接调用 `onedesk.ai.chat/1`、把数据行塞进上下文（`context` 动作的返回值由 AI 工作台再脱敏一次）。

## 6. 安全链（沿用 D426，不新增规则）

- `ai.policy`（环境参数）：`off` 全部 ✨ 灰掉并说明原因；`preview`（默认）先在辅助面板里显示要发送的完整内容，按“发送”才发；`allow` 直接发。
- 脱敏：AI 工作台对上下文统一处理（敏感列名、邮箱、长数字串打码、截断）。
- 密钥：上下文里的 `{{secret:…}}` 原样保留，不代入。
- 审计：每次发送一条（谁、对象、连接、模型、字数、用量），不记内容。
- “对 AI 可见”（`ai_visible`）只管 MCP 外部客户端；用户自己在界面里发起的辅助不受它限制，但预览让用户看清发什么。

## 7. 要做的东西（确认后排期）

| 层 | 内容 |
|---|---|
| 协议 | `AssistTarget`、`AssistRequest`、`AssistProposal` 类型；命令 `assist.run`、`assist.fetch`（预览后取回答） |
| 清单 | 字段 `assist`、类型 `assist.create`、动作 `role: "assist"`；严格校验 |
| 内核 | 收集上下文（字段声明 + 调插件 `context` 动作）、按接口找实现者、策略检查、审计 |
| AI 工作台 | 实现 `onedesk.ai.assist/1`：通用提示词模板（按 target 和 format）、脱敏、预览草稿、取回答；SQL 的现有 `generate` 改为它的一种情况，旧动作保留兼容 |
| 外壳 | ✨ 按钮（字段、编辑器、新建、页面工具栏）；一个辅助面板组件（说明、预览、提议差异、接受/放弃） |
| 插件 | SQL 改用统一模式并删掉自己的按钮；其他插件按需补 `hint` |
| 测试 | 假 AI（`plugins/_testing/fake-ai`）跑每种 target；策略 off/preview/allow；脱敏；提议未接受不写入 |

## 8. 需要你决定的

1. **字段默认开还是默认关？** 推荐：默认开（插件零代码就有 AI 辅助；不合适的字段写 `assist: false`）。
2. **默认策略** 是否维持 `preview`（每次先看要发送的内容）？推荐维持；熟悉后可在环境里改 `allow`。
3. **“新建内容”用 AI 生成** 第一版做不做？推荐做：这是“所有地方都用 AI”最显眼的入口。
4. **用 AI 生成插件本身**（在 OneDesk 里描述需求 → 生成插件包）：推荐第一版不做，先用 `docs/plugins/ai-prompt.md` 交给 Claude Code 等外部 AI 生成，稳定后再考虑做成插件。

## 9. 第一版的实际做法（D462）

**与草案的不同**：辅助提示不写在清单里，而是写在插件返回的视图里——表单字段（`ViewField`）新增可选属性 `assist: { off?, hint?, format? }`。这样插件零改动就有辅助，要调整也只是在 `render` 里多写一个属性；清单格式不变。新建内容的“用 AI 生成”就是在新建页上用“用 AI 填写”。插件的 `context` 动作、信息面板的说明/标签、结果区之外的其他位置留待下一版。

**内核**（不认识任何 AI 服务商）：
- 接口名 `onedesk.assist/1`（`onedesk_protocol::ASSIST_INTERFACE`），实现者声明 `implements: { "onedesk.assist/1": { "actions": ["assist"] } }`，不带连接类型。
- `assist.provider` → `{ available, plugin?, label? }`：外壳据此决定显不显示 ✨。
- `assist.start { target, tabId, envId?, locale?, input }` → 运行 id：把实现者的 `assist` 动作当作普通运行启动（只读策略、保护、取消、历史、审计都按运行处理）。没有实现者 → `invalid/noProvider`。

**外壳**：
- 页面上每个可编辑的 `text` / `longtext` / `code` 字段（非运行参数、非只读、未 `assist.off`）的标签旁有 ✨ 按钮（“用 AI 写”）。
- 页面操作栏有“用 AI 填写”：页面只有一个可辅助字段时等于它的 ✨，多个时一次生成全部（新建页上就是“用 AI 生成新内容”）。
- 一个对话框走完全程：写说明 → 准备（`prepare`）→ 策略为 `preview` 时显示将发送的完整内容，按“发送”才发（`allow` 直接发）→ 显示**提议**（可再改）→ “接受”后作为未保存的修改写进字段，照常保存/撤销。

**接口约定 `onedesk.assist/1`**（外壳 ↔ 实现者；输出是文本运行结果，文本是 JSON）：

```jsonc
// 输入（运行的 input）
{
  "step": "prepare" | "send",
  "mode": "field" | "fill",
  "instruction": "用户写的说明",
  "page": { "title": "页面标题", "kind": "类型名" },
  "field": "body.text",                 // mode=field：要写的字段（bind）
  "fields": [ { "name": "body.text", "label": "正文", "kind": "longtext", "language": "sql", "hint": "…", "format": "markdown", "value": "当前值（含未保存的修改）" } ]
}
// prepare 的输出
{ "step": "prepare", "policy": "off|preview|allow", "mode": "…", "connection": "名称", "model": "…", "tokens": 123, "system": "…", "request": "…" }
// send 的输出
{ "step": "send", "mode": "field", "field": "body.text", "text": "提议的内容", "model": "…", "usage": { … } }
{ "step": "send", "mode": "fill", "values": { "body.text": "…", "name": "…" }, "model": "…" }
// 出错（两步都可能）
{ "error": { "code": "policyOff|noConnection|chat|badField|noFields|badAnswer", "message": "给用户看的话" } }
```

实现者必须：`send` 时**按输入重新组装**请求（不接受外壳给的请求文本）、再查一次策略；脱敏（邮箱、长数字串；名字像密码/令牌/邮箱的字段不发值）；截断（目标字段 4000 字、其他 500 字、最多 30 个字段）；审计（不记内容）。第一版的实现者是 AI 工作台（`org.onedesk.ai`，`assist.js`）。

**插件作者要做的**：通常什么都不用做。字段需要说明用途时写 `assist: { hint: ctx.t("…") }`；内容有固定格式时写 `format`（如 `code:sql`、`json`）；不适合 AI 写的字段（编号、密钥以外的机器值）写 `assist: { off: true }`。不要自己画 AI 按钮或调用服务商插件。
