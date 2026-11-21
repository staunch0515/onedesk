# 第十七轮 外壳 — 交接

分支 `claude/r17-shell-e32344`。最后提交号见文末。

**协议对齐（更新）**：内核的 `round17-protocol.md`（r17-kernel 分支 9efb119）后来才到，外壳已改成按它的名字：
- X10：文字节点/运行输出的 `lineTones`（按 `\n` 分行）、`appearance: "terminal"`；表输出的 `appearance`、`toneColumn`、`lineColumn`（`parts/terminal-lines.ts`）。没有 `info` 语气，没有 stream 字段（stderr 是语气）。
- X17：运行中读 `Run.partial`（整份输出，替换上一份；`result-area.tsx` 里用 `terminalLinesOf`），没有 partial 时仍用旧的进度消息日志。完成后的 `appearance:"terminal"` 输出也按终端样式画。
- X18：`pick-folder` 的 `replace` → `plugin.replaceFolder`（客户端、真实、mock、混合客户端都加了）；新原因码文字：`conflict.exists`、`invalid.intoItself/isRoot/trashUnavailable/badOutput`、`notFound.grant`。
- **仍是我自拟、需主会话决定（规则 10）**：`confirm` 效果的 `choices`/`choiceArg`/`irreversible`。内核没加。外壳已实现（`ConfirmState`），若不采纳，同名冲突需由插件用已有 `Confirm` 效果问一次、再带 `conflict` 参数调 `files.copy/move`，永久删除的“不可撤销”写进插件的确认文字；那样外壳这几行可删（`command-dialogs.tsx`、`context.tsx`、`store.ts`）。

## 做了什么
1. **X10 终端样式**：新 token `--term-bg/-fg/-muted/-border/-info/-success/-warning/-danger/-stderr`（浅色、深色主题各一套，终端底在两个主题里都是深色；`tokens.test.ts` 加了对比度检查，全部 ≥4.5）。新设计组件 `TerminalText`（`src/design/components/terminal-text.*`）。带 `lines` 的普通文字节点按行用 TextBlock 的语气色；`style:"terminal"` 用 TerminalText。无这些字段的文字节点外观不变。
2. **X17 部分输出**：运行中读 `Run.partial` 用 `TerminalText` 显示，stderr 行是另一种颜色（来源标在语气里，无单独 stdout/stderr 小栏）。
3. **X18 外壳部分**：确认对话框支持“覆盖 / 跳过 / 保留两份”三选一（取消不执行）；`irreversible` 时说明“This cannot be undone.”；永久删除沿用 `confirm` 效果 + 危险按钮（两步）。文件树与列表本身是 `org.onedesk.files` 插件通过通用树/视图画的，外壳无专用代码。
4. **L 组核对**（测试在 `parts/round17-layout.test.tsx`）：
   - L1 活动栏/侧边树/标签/底部面板：已有，e2e 基准覆盖。通过。
   - L2 展开全部/折叠全部、折叠状态记住（`expanded` 随布局保存与恢复）：已有；补了测试。通过。悬停只改背景：沿用 tree.css，未改。
   - L3 标签前类型图标：已有（标签 icon 来自页面描述）。通过。
   - L4 编辑页面包屑/工具栏/参数区/编辑区：已有。通过。
   - L5 信息面板：名称、位置、说明、标签都在；`Sized` 固定宽度，不随内容变；补测试。通过。
   - L6 分割线可拖动并记住（侧栏、信息面板、结果区；双击复位；还原时夹在范围内）：补测试。通过。
   - L7 ⌘K 聚焦搜索：已有，补测试（⌘K 后焦点在搜索框，输入发 `search.query`）。“3 字符走索引、短词模糊、多词同时满足”是内核（X6），外壳只传原文。外壳部分通过，内核部分待内核测。
   - L8 收藏标记、标签可编辑：补测试。“收藏排前面”是内核树顺序。通过（外壳）。
   - L9 吐司浮在角上、自动消失：补测试。通过。
   - L10 设置页的文件夹授权：插件页有“已授权文件夹”区与测试（`plugin-page.test.tsx`）。通过。

## 新增文字键（只有英语）
`confirm.irreversible`、`confirm.choice.overwrite`、`confirm.choice.skip`、`confirm.choice.keepBoth`、以及内核新错误码的 `kernel.error.*` 六条（见 en-US.ts）。

## 测试
新增 vitest：`design/components/text-components.test.tsx`（TerminalText）、`design/tokens.test.ts`（终端对比度）、`parts/round17-layout.test.tsx`（L2/L5–L9）、`parts/round17-confirm.test.tsx`（冲突三选一、不可撤销）、`parts/round17-terminal.test.tsx`（行标色、逐行输出）。
`pnpm typecheck`、`pnpm lint` 通过；`pnpm test` 只剩 4 个 `plugins/_testing/lang-check.test.ts` 失败（缺中日译文，按任务书只加英语，由测试会话补，上一轮同样）。没跑 Playwright（本机无浏览器）；基准页面用到的组件外观没改（只新增 token 与新组件）。没有对真内核验证，因为内核端字段尚未存在。

## 范围外 / 还缺
- 终端样式只在 `style:"terminal"` 时使用；已完成的 text 运行输出（`RunOutput::text`）仍用普通代码块，待内核给行信息后可换。
- 文件冲突与永久删除实际由哪个动作发 `confirm` 要看 `org.onedesk.files` 与内核 X18。
- 外壳新键的中日译文由测试会话补。

最后提交：`bfc8e22`
