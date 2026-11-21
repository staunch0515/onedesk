# 第十七轮 外壳 — 交接

分支 `claude/r17-shell-e32344`。最后提交号见文末。

**协议对齐（最终）**：已合并集成分支 `claude/onedesk-r17`，全部用内核生成的类型，没有局部类型断言：
- X10：文字节点/文字输出的 `lineTones`、`appearance`（plain/terminal）；表输出的 `appearance`、`toneColumn`、`lineColumn`（`parts/terminal-lines.ts`）。`LineTone` 六个值；未知值（如 `stdout`）= default。
- X17：运行中读 `Run.partial`（整份输出，替换上一份），完成后读 `output`；没有 partial 时仍用旧的进度消息日志。
- X18：`pick-folder.replace` → `plugin.replaceFolder`（四个客户端都有）；新原因码文字：`conflict.exists`、`invalid.intoItself/isRoot/trashUnavailable/badOutput`、`notFound.grant`。
- **冲突对话框与不可撤销提示：已恢复（D428）**。`confirm` 效果的 `choices`（每项 `id`、`label?`）、`choiceArg`（默认 `conflict`）、`irreversible`：对话框列出各选项，点选项即以 `args = {…原 args, confirmed: true, [choiceArg]: id}` 重新调同一命令；取消不执行；`irreversible` 加一行 “This cannot be undone.”，无选项时确认钮用危险色。id 是 overwrite/skip/keepBoth 且没给 label 时用外壳自带英文。字段暂用局部类型读取（`state/context.tsx` 一处），内核生成类型出来后去掉那处断言。

## 第二批（D428 入口、D429）
1. **树里拖放**（`side-panel.tsx`）：插件自供树（`source !== "stored"`）里，菜单里有以 `:move` 结尾命令的节点可拖；只能放到同树的文件夹节点“里面”（不能放到自己或自己的下级）；放下调该节点的 `…:move`，按住 ⌥ 调 `…:copy`，`args.destination` = 目标节点 key，并展开目标。`Tree`（设计组件）的 `onDrop` 多了第四个参数 `{ alt }`。
2. **右键“移动到…/复制到…”**：菜单命令以 `:move`/`:copy` 结尾时，不直接执行，弹文件夹选择框（`parts/folder-picker.tsx`，只列该树里的文件夹，自己不列出；插件的树本身只显示授权文件夹内的内容，所以选不到授权之外），选好后调命令并带 `args.destination`。
3. **重命名**：菜单命令以 `:rename` 结尾时进入就地改名（`renaming.command`），提交后调该命令并带 `args.newName`；不再走 `tree.rename`。
4. **D429 页面按钮运行命令**：页面动作声明里带 `command` 时（与 role 无关），点击调 `command.execute(command, { target, tabId, tree/nodeKey（页面所在节点）, args: 页面输入框当前值（含未保存的）})`，不启动运行；返回效果照常处理（含 choices 重新调用）。字段暂用局部类型读取（`pages/view-page.tsx` 一处），生成类型出来后去掉。
5. 判断“是 move/copy/rename 命令”的规则在 `parts/file-ops.ts`：命令 id 匹配 `:(move|copy|rename)$`。

**对真内核走的结果（重要缺口，不在外壳）**：内核给插件自供树的节点只发 `node.open` 一个菜单项，且 `draggable: false`（`crates/kernel/src/kernel.rs` 的 `provided_page`）。所以 Files 树里右键只有 Open，拖放、移动到、复制到、重命名都**到不了**，同名复制的流程在真内核上没能走。要让这些入口出现，需要内核让插件自供树的节点带上插件声明的 `menu`（命令 id 列表，如 `org.onedesk.files:move`）——文件夹节点还要 `accepts`/可放——并由 `org.onedesk.files` 的 `children` 返回它们。外壳这边已经按这个约定做好并有 vitest（`parts/round17-files-ui.test.tsx`，用替身 Tree 直接调 `canDrop`/`onDrop`/菜单/改名）。
另：授权文件夹后，Files 树不自动刷新（要切到别的树再回来才出现新根）——内核似乎没在授权后给 `tree:files` 事件，或外壳没订阅到，待查（范围外）。

## 做了什么
1. **X10 终端样式**：新 token `--term-bg/-fg/-muted/-border/-info/-success/-warning/-danger/-stderr`（浅色、深色主题各一套，终端底在两个主题里都是深色；`tokens.test.ts` 加了对比度检查，全部 ≥4.5）。新设计组件 `TerminalText`（`src/design/components/terminal-text.*`）。带 `lines` 的普通文字节点按行用 TextBlock 的语气色；`style:"terminal"` 用 TerminalText。无这些字段的文字节点外观不变。
2. **X17 部分输出**：运行中读 `Run.partial` 用 `TerminalText` 显示，stderr 行是另一种颜色（来源标在语气里，无单独 stdout/stderr 小栏）。
3. **X18 外壳部分**：见上（`replaceFolder`、新错误文字；永久删除沿用 `confirm` 效果 + 危险按钮，有测试）。文件树与列表本身是 `org.onedesk.files` 插件通过通用树/视图画的，外壳无专用代码。
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
`confirm.irreversible`、`confirm.choice.overwrite/skip/keepBoth`、`folderPicker.move/copy/choose/empty/label`，以及内核新错误码的 `kernel.error.*` 六条（见 en-US.ts）。

## 对真内核走了一遍
devhost（`ONEDESK_SECRET_STORE=memory`，临时数据目录，`target` 用共用的 `/Users/chloe/onedesk/repo/target`）+ vite + 浏览器面板：连上真内核；“Grant a folder…”（路径框）授权临时文件夹 → Files 树出现 files、sub、a.txt；打开 a.txt 得到编辑页，页内有“If the name exists”下拉；⌘K 后焦点在搜索框；吐司浮在角上。**没走到**：同名复制/移动、永久删除（文件插件页没有对应按钮可点，菜单里只有 Open）、`partial` 运行输出、终端样式文字（没有插件在本机返回这些）。
- 范围外（r17-files）：点“Authorized folders”（`org.onedesk.files` 的授权树）时弹出“That did not work / The plugin failed to produce this page.”，授权成功后立即出现，Files 树本身正常。

## 测试
新增 vitest：`design/components/text-components.test.tsx`（TerminalText）、`design/tokens.test.ts`（终端对比度）、`parts/round17-layout.test.tsx`（L2/L5–L9）、`parts/round17-confirm.test.tsx`（冲突三选一、不可撤销）、`parts/round17-terminal.test.tsx`（行标色、逐行输出）。
`pnpm typecheck`、`pnpm lint` 通过；`pnpm test` 只剩 4 个 `plugins/_testing/lang-check.test.ts` 失败（缺中日译文，按任务书只加英语，由测试会话补，上一轮同样）。没跑 Playwright（本机无浏览器）；基准页面用到的组件外观没改（只新增 token 与新组件）。没有对真内核验证，因为内核端字段尚未存在。

## 范围外 / 还缺
- 终端样式只在 `style:"terminal"` 时使用；已完成的 text 运行输出（`RunOutput::text`）仍用普通代码块，待内核给行信息后可换。
- 文件冲突与永久删除实际由哪个动作发 `confirm` 要看 `org.onedesk.files` 与内核 X18。
- 外壳新键的中日译文由测试会话补。

最后提交：`2e262ba`（之后只有写入此行的文档提交）
