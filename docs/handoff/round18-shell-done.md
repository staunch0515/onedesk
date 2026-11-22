# 第十八轮 外壳 — 交接

分支 `claude/r18-shell-e48c3e`。最后提交号见文末。内核尚未提交协议，类型与请求形状**按 `round18-protocol.md` 写**，之后要对着真内核对齐。

## 做了什么
1. **结果区动作（X5）**：`ProtocolClient` 新增 `result.actions(runId)` → `ResultAction[]`（`{plugin,id,label,icon,enabled,disabledReason?}`）和 `action.call(plugin, action, args)`。`ResultAction`、`ActionCallResult` 暂写在 `protocol/types.ts`（生成的 TS 到位后换成生成类型）。真客户端请求名 `result.actions`（入参 `{runId}`）、`action.call`（入参 `{plugin, action, args}`）；混合客户端按运行归属转发；mock 对成功的表/文字运行给一个 Analyze 按钮（工作区禁导出时为禁用，原因码 `noExport`），`action.call` 返回 `{page:"core:audit"}`。
   外壳（`parts/result-area.tsx` 的 `ResultActions`，放在结果区工具栏）：成功的运行上取列表，带图标的按钮；禁用的按钮旁用文字写原因（`noExport`、`policy` 有专门文字，其它码 “Not available”）；点击调 `action.call(plugin, id, {runId})`，答案里有 `page`（字符串或 `{target}`）就打开；进行中重复点击被禁用。
2. **Run.partial（X17）**：运行中已有的终端/纯文字/表格部分输出沿用；新增：部分输出或最终输出是文字且 `format: "markdown"` 时用阅读渲染（`MarkdownText`，链接走 `openExternal`）。生成的 `RunOutput` 的 text 里还没有 `format` 字段，所以松读（`markdownOf`）：有就用，没有按纯文字。进行中显示 “{time} elapsed”（新键 `result.elapsedFor`）与取消按钮；结束后切到 `output`。mock 新增 `generate` 动作：3 秒内流出 Markdown 文字。
3. **预览页视图节点检查**：见下。

## 验证
- vitest：`parts/round18-result.test.tsx`（13 个）：按钮列表与图标、无动作不显示、禁用与原因文字、点击带 runId 并打开页面、答案无页面时不开、页面引用解析、Markdown 部分输出逐次替换、纯文字不当 Markdown、已用时间与取消、结束切到最终输出、mock 的 partial 流。
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过；`pnpm test` 只剩 `plugins/_testing/lang-check.test.ts` 的 4 个失败（新键缺中日译文，按任务书由 tests 会话补）。没对真内核跑（内核端还没有）。

## 缺口：预览页需要的视图节点（给协调会话，我没改协议）
现有节点：`form`（字段 kind：text/longtext/code/number/boolean/date/datetime/enum/secret/time/ref）、`text`（plain/markdown、mono、tone、lineTones、terminal）、`table`（rowActions、rowTargets）、`link`。页面动作按钮在页头工具栏（`ActionDecl`）。
- **多行可编辑文本**：够用——`form` 里的 `longtext` 字段（`fill` 可占满）。但**结果区页签的视图（`run.render`）里 `form` 节点现在只画一行标签**（`view-nodes.tsx`），不画字段；只有页面主体（view page）画表单。预览页若放在结果区页签里需要外壳加表单渲染，请说明预览页是页面还是结果页签。
- **复选列表**：**不够**。只有单个 `boolean` 字段，没有“一组条目 + 每条一个复选框 + 可增删”的节点。可行替代：每项一个 `boolean` 字段（条目数固定），或表格 + `rowActions`。建议新节点 `checklist`（`items:[{id,label,checked}]`，勾选发页面事件）。
- **按钮**：**视图里没有按钮节点**；只有页头动作（`ActionDecl`）、表格行按钮（`rowActions`，≤4）、`link`（只能打开目标）。预览页里“应用/复制”等放页头动作可行；要在内容中间放按钮则缺。
- **文字节点**：够用（Markdown、等宽、语气色）。预览页里 “AI 生成的 SQL” 可用 `text` + `mono` + `language:"sql"`。

## 范围外 / 待后续
- 生成的 TS 到位后：把 `ResultAction` 换成生成类型；`RunOutput.text.format` 若加入，`markdownOf` 去掉松读。
- 新文字键只有英语：`result.elapsedFor`、`result.action.disabled.noExport/policy/other`（中日待 tests 会话补）。旧键 `result.elapsed` 现在无人使用（未删，避免动语言文件）。
- 禁用原因码目前只有 `noExport`、`policy` 两条专门文字；内核最终的原因码集合定下后补。
- `action.call` 的真实请求名/入参是我按任务书猜的（仓库里目前没有这个外壳请求，只有宿主接口 `actions.call`）；内核定好后若不同，只需改 `real-client.ts` 两行。

## 对齐更新（按 round18-protocol §9.1，r18-kernel 分支文档）
- 没有 `action.call`：点击结果区动作 = `run.start`，`action` = `ResultAction.action`（完整名），`resultRun` = 被点击的运行 id，`target` = `run:<id>`，`envId` 用该运行的环境；成功后打开新运行的标签页。`ProtocolClient.action`、`ActionCallResult`、`pageRefOf` 已删。
- `RunRequest.resultRun?` 新增，真客户端透传。`ResultAction` 多 `action`，`icon` 可选，仍是手写类型（内核生成类型提交后再换）。
- 禁用原因码改为 `pluginDisabled`/`readonly`/`noExport`（新键 `result.action.disabled.readonly/pluginDisabled`，去掉 `policy`）。
- mock：`result.actions` 返回 `org.onedesk.ai:analyze`；`run.start` 带 `resultRun` 时检查该运行已成功，`org.onedesk.ai:analyze` 与 `generate` 一样流出 Markdown 部分输出。
- 仍待：内核生成类型到位后换 `ResultAction`/`RunStartParams`。

## 合并 claude/onedesk-r18 后
- `ResultAction` 换成生成类型（`protocol/types.ts` 只再导出）；`RunStartParams.resultRun` 与外壳 `RunRequest.resultRun` 一致；mock 形状与生成类型相符（typecheck 通过）。
- `@implements:…` 的 ref 字段：内核在页面里已把它展开成 `options`，外壳只按 `options` 画下拉、从不读 `kinds`，无需改动；补了测试。
- 新内核原因码文字（英语）：`notUsed`、`notInResultAction`、`noImplementation`、`wrongInterface`、`notResultAction`、`badResultRun`（`kernel-texts.test` 要求）。
- 新键中日译文待 tests 会话补：`result.elapsedFor`、`result.action.disabled.*`、`kernel.error.reason.*`（上面 6 条）。
- 权限 id `uses`：英文 "Use other plugins' interfaces"（键 `kernel.permission.uses`，中日待 tests）；接口名由已有的 detail 列显示，不另配。
