# 第十八轮 r18-workbench 完成记录

范围：`plugins/org.onedesk.ai`（新）、`plugins/org.onedesk.sql`（“用 AI 写”）。全部对着 `round18-protocol.md` 写，用假 host 测试；内核未合并前不能在真内核上跑。验证命令：`pnpm vitest run plugins`（28 个文件 703 个测试）、`pnpm typecheck`、`pnpm lint`、各 JSON 过 `python3 -m json.tool`。

| # | 结论 | 怎么验证 |
|---|---|---|
| K1 分析 | 通过（待内核 X5 实测） | 清单 `contributes.resultActions`（table/text → `analyze`）；`analyze` 用 `host.runs.read(runId)` 取结果，建一个 `analysis` 资源（草稿）并返回 link 打开；测试“analyze reads the run's result…”，确认此时不调服务商 |
| K3 预览 | 通过 | `analysis` 页：连接/模型/token 估算、可编辑 `body.request`、每个参考文档一个勾选框、完整发送文本；取消勾选和编辑立即改变全文与估算；只有“发送”动作（`send`）才调 `interfaces.call`；策略 off 时红字提示 |
| K4 脱敏 | 通过 | 敏感列名（password/token/secret/email/phone/api_key… 按词和驼峰，设置里可加）整列 `***`；邮箱→`[email]`；≥9 位数字串→`[number]`；前 20 行；单元格 200 字；行数/字数可在设置里改；请求里写明截了什么、遮了哪些列。测试“masking (K4)” |
| K2 资料索引 | 通过（搜索待内核 X6 实测） | `syncDocs` 把授权文件夹里的 .md/.txt 同步成 `doc` 资源（`upsertByKey`，只在 files.roots 内）；分析时用语句里 FROM/JOIN 的表名+结果列名调 `resources.search({mode:"any",rank:"relevance",kinds:["org.onedesk.ai:doc"],limit:8})`，按 `docBudget` token 预算取，最后一篇可截断 |
| K6 保存分析 | 通过（待内核 D442 实测） | “保存分析”事件调 `ctx.host.runs.saveArtifact(runId,{name,kind:"analysis",data})`（D442）；没有该函数就报错，不再退回存储。没有来源运行 id 时提示不保存 |
| K7–K9 生成 SQL | 通过 | 导出动作 `generate`（输入 §8；返回 `{text, model, usage, check}`，出错 `{error:{code,message}}`），只带说明、表名/列名、相关文档，**不带数据**；K8 检查 `checkSql`：单条 SELECT/WITH，去掉注释和字符串后看，多条/写入/`INTO` 都拒绝。SQL 插件：“用 AI 写”输入框 + 动作 `aiWrite`/`aiSend`，提议显示在编辑器下面，**接受前不改编辑器**；“接受”事件返回 `changes: {"body.sql": …}`（未保存修改），检查不过不能接受。测试 “sql: write with AI” |
| K10 设置 | 通过（待内核实测） | 默认连接是资源引用：分析页顶部有 `ref` 字段，`kinds: ["@implements:onedesk.ai.chat/1"]`、`bind: body.connectionId`，选项来自 `interfaces.list` + `resources.list`；选择顺序：页面所选 → 环境参数 `ai.connection` → 工作区默认 `params.config("ai.connection.default")`（同 SQL 的 `datasource.default`）。**工作区默认的设置入口**：我没有在清单里声明它（清单设置项没有资源引用类型），沿用 datasource.default 的做法；若外壳没有给它的界面，需要内核/外壳补。清单 `settings` 只剩：更多敏感列名、行数、字数、文档文件夹、文档预算 |
| `ai.policy` | 通过 | 环境参数 `ai.policy`：`off`（analyze/send/generate 都拒绝）、`preview`（默认；`generate` 第一次只返回 `{needsPreview, request, tokens…}`，调用方显示后带 `confirm:true` 再发）、`allow`（`generate` 直接发）。无效值按 preview |
| 审计 | 通过（部分） | 每次发送记 `{at, kind, connection, model, chars, usage}`，不含内容，最近 200 条存在插件存储；内核对 `interfaces.call` 自己有审计 |

## 对协议的假设（内核合并时核对）

- `ctx.host.runs.read(runId)` 返回 `{output, meta:{plugin,kind,resource?,at}}`；分析动作的 `runId` 取 `input.runId`，没有再取 `ctx.args.runId`。
- `ctx.host.interfaces.call("onedesk.ai.chat/1","chat",input,{resource})`；`invalid/noImplementation`、`invalid/wrongInterface` 当作“这不是 AI 连接”。
- 连接资源的 `body.model`（字符串）若有，用来在预览里显示模型；没有就显示“连接里设的默认模型”。
- 清单新字段：`uses`、`contributes.resultActions`、`depends[].optional`（SQL 对 AI 是可选依赖）。内核当前清单严格校验，所以现在内核上装不上；等 X5/X15 合并。
- D441：`generate` 返回 `{ output: {type:"text", text}, data: {text,model,usage,check} | {error} | {needsPreview,…} }`；读服务商 `chat` 也读 `ret.data`（没有 data 时退回整个返回值）；SQL 插件读 `ret.data`。
- 协调会话对齐：搜索入参用 `query`、类型写 `org.onedesk.ai:doc`（已是）；`runs.read` 取 `input.runId`（已是）；预览页的勾选用现有的 boolean 字段，没用按钮节点或结果页签里的 form。
- 预览页用普通资源（种类 `analysis`）而不是独立页面：已有的“动作返回 link → 打开资源”路径最稳；代价是每点一次“分析”多一个草稿资源，用户可自己删。

## 范围外 / 需要别人决定

1. `run_artifacts` 的宿主接口名与形状（见 K6）。
2. 清单“资源引用参数”及 `{implements}` 的设置项类型（见 K10）；外壳的灰按钮提示：`ai.policy` 是插件的环境参数，内核不认识，所以现在只能在点击时报错，不能把“分析”按钮提前灰掉。
3. 文档文件夹授权用文字设置 + 已授权的 `files.roots`，没有“选择文件夹”的专用界面。
4. 中日文案由我写，没经母语审校。
5. 事件处理函数里不能 `network.request`（D336）：所以“发送”和“用 AI 写”都是动作（run），不是页面事件。

## D443 之后的结构

- SQL 对工作台不再 `depends`（内核没有 `optional`）：SQL 清单 `uses: ["onedesk.ai.generate/1"]`、`requires.resources: true`；工作台清单 `implements: {"onedesk.ai.generate/1": {actions:["generate"], kind:"settings"}}`。
- `interfaces.call` 必须带一个实现方类型的资源，所以工作台加了资源类型 `settings`（“AI 工作台设置”，页面里用 `ref` 字段 `@implements:onedesk.ai.chat/1` 选默认连接，存在 `body.connection`）。SQL 用 `interfaces.list` 取实现方的 kind，再 `resources.search({kinds:[kind],limit:1})` 找到设置资源，带着它调 `generate`。
- 没有实现方 → SQL 页面不显示“用 AI 写”输入框，改显示一行说明；没有设置资源 → 点“用 AI 写”时提示先新建“AI 工作台设置”。**用户需要手动新建一份**（新建菜单里有）；若希望自动建，需要内核/协调会话定（例如激活时创建）。
- 默认连接读取顺序：页面所选 → `params.get("ai.connection")` → `params.config("ai.connection.default")` → 设置资源里选的。选错类型时 `interfaces.call` 给 `wrongInterface`，界面报“不是 AI 连接”。

## 默认连接的最终做法（设置项）

- 清单 `contributes.settings` 有 `connection`：`type:"resource"`、`kinds:["@implements:onedesk.ai.chat/1"]`、`default:""`（内核 §9.8）。读取顺序：页面所选 → `params.get("ai.connection")` → `params.config("ai.connection")` → `settings.get("connection")`。
- `settings` 资源类型保留，只作为 `interfaces.call(generate)` 的调用锚点：工作区打开时自动建一份（用户不需要操作），页面只有一行说明，不在“新建”菜单里，里面不存任何东西。内核若以后允许不带资源的接口调用，可以删掉它。
