# 第十二轮 外壳：完成情况

## 改了什么
1. **`dropAny` 放置**（`src/workbench/parts/side-panel.tsx`）：节点带 `dropAny`（目前按可选字段读，`DropAwareNode`）时，放到它**上面**（inside）接受任何资源节点；放到前后仍走原来的 `accepts` 规则；祖先环检查保留在前。放下仍调 `client.tree.move`。
2. **内核提示文字**：`tree.move` 的返回由 `void` 改为 `{ message?: Label } | void`（`protocol/client.ts`、`real/real-client.ts`）；外壳用 toast 显示 `tx(message)`。
3. **`resourcesAll` 权限文字**：`en-US.ts` 新增 `permission.resourcesAll`；`i18n/index.tsx` 的 `permission()` 在内核表里找不到时回落到 `permission.<id>`（先当前语言覆盖，再英语）。**没动 `kernel-texts.ts`**。安装确认框和插件页（权限表、升级确认）都走 `permission()`，自动生效。
4. **自供子节点“失效”**：核对结果——节点 `state: "broken"`（及 `stateReason` 提示）本来就经 `side-panel` → `Tree` 画出（unlink 图标 + `od-tree__row--broken` 样式），无需改；补了测试。
5. **视图表格行内动作**：原来表格只支持 `rowTargets`（点行打开）。新增最小实现：表格节点可选 `rowActions: [{ event, label, icon?, danger? }]`（本地类型 `TableViewNode`，`protocol/types.ts`）；`ViewNodes` 多画一列图标按钮（`IconButton`，点按钮不触发打开行），点击回调 `onRowAction(event, rowIndex)`；`view-page.tsx` 用 `client.page.event(target, event, { ...上下文, row: 行号 })` 发出，结果的 `changes`/`message` 与普通页面事件同样处理。结果页签（`result-area`）里不画按钮。无新 CSS。
6. 测试 `src/workbench/parts/round12.test.tsx`（6 条）：权限文字、行按钮、放到 dropAny 节点上（含提示显示）、普通节点仍拒绝、broken 节点。

## 测试结果
- `pnpm typecheck`、`pnpm lint` 通过；`cargo test -p onedesk-host`（无用例，编译通过）、host clippy `-D warnings` 通过。
- `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts`：23 通过、1 跳过（原本就跳过的截图用例），截图已 `git checkout -- docs/screenshots`。
- `pnpm test`：全量跑时 `plugins/_testing/lang-check.test.ts` 的 4 条失败——**预期**：新增了英语键 `permission.resourcesAll`，两个语言插件的 JSON 还没有（计划里归插件与测试会话第二阶段补；中文：“读取本工作区所有内容的名称、类型和位置（不含正文）”）。另有 3 个用例在满载时超时（audit-page、field-control、round6），单独重跑全过，判断为负载抖动。

## 我做的假设（等内核合并后对）
- `tree.move` 的结果 JSON 里提示字段叫 `message`（Label）。
- 节点字段 `dropAny` 在 `TreeNode` 上（生成类型出来后可去掉 `DropAwareNode`）。
- 放到 `dropAny` 节点上用的 position 是 `inside`，移动方法仍是 `tree.move`；拖动只在同一棵树的面板内发生（跨树放置没做）。
- 内核在 drop 被插件处理后会发 `tree:<id>` 事件，使展开的综合节点重新读子节点；若不发，需要在 `drop()` 里手动刷新目标层。
- **行内动作协议是外壳自定的**：表格 `rowActions` 与上下文 `row`（行号，从 0 起）不在计划里定死的名字中；`PageContext` 生成类型也没有 `row`。需要主会话决定并记入 decisions.md，插件会话照此写（`rowTargets` 已有）。
- `permission.resourcesAll` 的 `PluginPermission.detail` 为空时不显示明细。

## 没做/没验证
- 没连真内核走过拖放、行按钮（内核还没合并）；假数据（mock）里没有 `dropAny` 节点和 `rowActions` 表，所以截图基准里看不到这些。
- 行按钮点击后表格是否刷新取决于内核对 `page.event` 后资源变更的推送，未验证。
- 日语/中文文字未加（不归外壳）。

## 合并后对齐（对着真内核走过，合并了 `claude/onedesk-coord-3-f0c048` 之后）
做法：`cargo build -p onedesk-worker -p onedesk-host`；devhost（`ONEDESK_SECRET_STORE=memory`、临时数据目录、随机端口）+ vite 1434；一份临时 Playwright 脚本（没提交，不属于 `e2e/` 的交付）用真鼠标拖放、协议调用核对。截图在合并前删除，没入库。

**对齐改动**
- `TreeNode.dropAny`、`TreeMoveResult` 改用生成类型，去掉本地假类型（`DropAwareNode`）。
- `tree.move` 多带一个 `locale`（内核交给插件 `drop` 的 `ctx.locale`；否则“已加入 N 项”会按默认语言）。`mixed-client` 里原来丢掉了这个参数，已补。
- 文字：`kernel-texts.ts` 加映射 `reason.badDropAnswer`、`dropWithoutTree`、审计 `tree.drop`、`resources.search`、权限 `resourcesAll`；`en-US.ts` 加对应 `kernel.*` 键（`kernel.permission.resourcesAll` 取代我早先的 `permission.resourcesAll`）。`kernel-texts.test.ts` 全过。`permission()` 恢复成只查内核映射（回落键已不需要）。**两个语言插件要补这 6 个 `kernel.*` 键**：`kernel.error.reason.badDropAnswer`、`kernel.label.dropWithoutTree`、`kernel.audit.tree.drop`、`kernel.audit.resources.search`、`kernel.permission.resourcesAll`（5 个；全量 `lang-check` 以 en-US.ts 为准）。
- 页面布局（真内核才暴露）：HTTP 请求页有多个表单段，其中一段 `fill`，原来“查询参数”文本框被压扁、与“令牌”重叠。改 `view-page.tsx`：多段且有 fill 时，非 fill 段 `fixed`（不收缩）、外层可滚动；fill 段 `fillMin`（最小高度）。`src/design` 新增 `Pane` 的 `fixed`、`fillMin` 与 token `--stacked-fill-min-height`。单段页面不变（`workbench.spec.ts` 23 通过、截图未变）。

**实际走通的（真内核）**
- 综合：拖笔记、网址、提示词到“综合”上 → `items` 三项、三个资源仍在顶层、出现“Added 1 item”提示；展开后三个引用（`@<综合>/ref-<id>`），名称取自基本信息；删掉其中的笔记后重新读：那一条显示“(no longer exists)”和断链图标；把另一个综合拖进去 → 真移动（成为子节点，`items` 不变）。`dropAny` 只出现在综合节点上。
- 集合：只填类型 → 空库时无子节点，新建一条笔记后重新读出现；三项都空 → 0 个子节点（页面上的“至少填一项条件”提示没单独核对）；结果表有“1 result(s)”。
- HTTP：方法下拉（POST）、地址、发出后 `200 OK · 耗时 · 29 bytes`（状态栏）、JSON 自动排版、响应头表。查询参数/请求头/正文/令牌分区都显示。
- `resourcesAll`：`app.inspectPlugin` 对内置综合插件给出 `{id:"resourcesAll", detail:"", required:true}`。

**发现的缺陷（不是我的文件，没改）**
1. **表格行内按钮没有协议**：生成的 `ViewNode::Table` 只有 `rowTargets`，没有 `rowActions`，综合插件页上看不到“移除/上移/下移”（我数过，0 个按钮），且插件的 `onEvent` 约定的事件名 `remove:<id>`、`up:<id>`、`down:<id>` 没有任何入口能触发。需要主会话决定：给 `Table` 加 `rowActions`（外壳已按 `{event,label,icon?}` + `context.row` 写好，名字可改），或改插件用页面动作。**这一块在真内核上没走通。**
2. **综合页和集合页“类型”列显示 `[object Object]`**：插件把 `ResourceInfo.kindLabel`（`Label`，可能是对象）直接放进表格单元格（`plugins/org.onedesk.composite/main.js` 的 `info.kindLabel || info.kind`，集合插件同理）。需要在插件里按 `ctx.locale` 取字符串。
3. 失效的引用节点：节点 `state` 仍是 `ok`（只是名称“(no longer exists)”和 unlink 图标）；计划说“用节点已有的状态字段”（应为 `state: "broken"`）。外壳对 `broken` 已有显示，插件的 `children` 没设。
4. 综合页打开着时删除被引用的资源，页面表格没有刷新（仍显示已删的行），重新打开才对；没查是外壳缓存还是内核没推事件——未定位。

**没做/没验证**：拖到综合节点的**前/后**（普通规则）没在真内核上走；集合页的“至少填一项条件”文字；`resourcesAll` 在安装确认对话框里的实际画面（只核对了协议返回，对话框文字由单元测试覆盖）；中文、日文界面。

## 审查后的修改（合并 `claude/onedesk-coord-4-3ac9ba` 之后）
- **#1 行动作（D393）**：外壳自定的 `RowAction{event}` / `TableViewNode` 删掉，改用生成的 `TableRowAction {id,label,icon?}`；点按钮发页面事件 `id`，`context.row` = `rowKeys[行]`，没有 `rowKeys` 时是行号文字；点行按 `rowTargets`（可为 `null`，null 的行不打开）。测试：`round12.test.tsx`（按 rowKeys 回调、无 rowKeys 回行号文字、null 目标不开、按钮点击不触发打开行）。
- **#5 locale**：`tree.move` 带当前语言（`real-client`、`mixed-client`、`side-panel`），测试断言 move 调用带语言串。
- **#10 列宽**：行按钮列不再写像素：`DataGridColumn.actionCount`，宽度由网格按按钮数 × token `--grid-action-width`（32px，新增于 `tokens.css`）算出。
- **原因码 `inDrop`**：`kernel-texts.ts` 映射 + `en-US.ts` 键 `kernel.error.reason.inDrop`，`kernel-texts.test.ts` 列表补上（`badDropAnswer` 之前已有）。语言插件要补 `kernel.error.reason.inDrop`（及 `badDropAnswer` 等，见 lang-check 输出）。
- **第十一轮遗留：语言切换后页面文字不变**：`view-page.tsx` 在界面语言变化时把标签的 `reload` +1，重新取页面。测试 `pages/view-page-language.test.tsx`（`renderInShell` 的 `rerender` 新增可选语言参数）。**已对着真内核验证**：把 `e2e/round11.spec.ts` 的 `test.fixme` 临时改成 `test` 跑（不入库），欢迎页中、日、英切换通过——测试会话可以去掉 fixme。
- 结果：typecheck、lint 通过；`pnpm test` 仅 `lang-check` 4 条失败（等译文）；`workbench.spec.ts` 23 通过、截图未变。

### 验收后补的修改（行按钮的 `row` 没到插件）
- 原因：`real-client.ts` 的 `pageContext()` 只挑 `envId/draft/params/locale`，把 `row` 丢了（`view-page` 本来就传了）。已修；测试：`real-client.test.ts`「sends the row of a row action with page.event」（抓得到这个问题：丢掉 `row` 就失败），以及 `view-page-language.test.tsx` 里从行按钮到 `client.page.event` 的一条。
- 顺带加固：行键随行数据走（`view-nodes.tsx` 的 `Indexed.key`），按钮不再在点击时回头查 `node.rowKeys`，避免表格刷新时按钮拿到旧行键。
- 真内核：把 `e2e/round12.spec.ts` 的行按钮用例临时改成 `test` 跑（不入库）。上移/下移/移除**能工作**（加等待后稳定通过）；但该用例原样跑会不稳定——它在 `items()` 轮询看到已保存后**立刻**点下一行按钮，此时页面还没按新顺序重新取（保存与页面刷新之间有几十到几百毫秒），点到的仍是旧顺序的行。**用例需要在每次点击之间等表格行顺序变成新的**（例如 `expect(rows.nth(1)).toContainText("One")`）再点下一个；这是用例的竞态，不是协议或外壳丢参数。

### round11.spec.ts:187（关掉欢迎页后重载又出现欢迎页）的确切原因
- **外壳的真问题**：布局保存有 200 ms 的安静期（`createStore` 的 `scheduleSave`）。用户关了标签、页面在这 200 ms 内重载，这次保存就丢了，重载读到的是旧布局（还有欢迎页）。修：`Store.flush()`（立即写出还在等的改动），`main.tsx` 在 `pagehide` 和 `visibilitychange→hidden` 时调用。测试：`state/store-flush.test.ts`（关标签后 flush 写出且不重复写）。
- **测试自身的问题（请测试会话改）**：用例里“等布局已不含 welcome”的轮询是空的——`rpc()` 用的是另一个客户端（`client=e2e-rpc`），而布局是按客户端存的，所以 `ui.get layout` 一直返回 `null`，`not.toContain("org.onedesk.welcome")` 立刻成立，等于没等。应改成等页面自己的布局：例如先 `await page.waitForTimeout(400)`，或在页面里调用 `page.evaluate` 读 `localStorage`/等待保存，或让 `rpc` 带上页面的客户端名。外壳现在即使不等也不会丢，但这条等待仍应修正。
- 验证：该用例 `--repeat-each=10`：修前 10/10 失败，修后 10/10 通过（真内核）。
