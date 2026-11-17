# 第十轮外壳：完成记录

分支 `claude/r10-shell-96a0bb`（不推送、不合并）。内核这一轮没有合并，外壳按 `round10-plan.md` 里定死的名字和可选字段、本地类型写；假数据（mock）补了对应的东西。**没有对真内核走过**，合并后要对一遍（见“假设”）。

## 改了什么

1. **虚拟滚动（D373，§3）**
   - `src/design/components/virtual.ts`：`computeWindow`（纯函数：行数、行高、滚动位置、视口 → 要画的范围与上下空白）、`scrollTopFor`、`useVirtualWindow`（读滚动容器的 `scrollTop`/`clientHeight`，行高取自 token `--tree-row-height` / `--grid-row-height` / `--table-row-height`，不写死）。上下各缓冲 8 行；没量出大小（第一次渲染、jsdom）时只画前 300 行。
   - `Tree`：只画窗口内的行，上下用 `od-tree__gap` 空白撑出同样的高度；键盘上下/Home/End 用 `reveal` 滚到位（行没画出来也行）；选中的行（跟随当前页、“在树里显示”）自动滚到可见。拖放、右键、重命名、过滤高亮不变（它们只依赖画出来的行和 `data-tree-key`）。
   - `DataGrid`：同样窗口化（`autoHeight` 的不窗口化）；行高和表头高是量出来的（边框不会让空白漂移）；行号是在整个结果里的位置；排序对整个结果；`↑/↓` 在行间移动，下一行没画出来时先滚再聚焦。
2. **按需分批（§3）**：`protocol/children.ts` 去掉 5000 上限，新增 `loadBatch/loadLevel/loadMore`（`Level = {nodes, next?}`）。侧栏每层先只读第一批；一层还有后续批次时，末尾多一行“正在读取更多…”（`TreeRow.more`），它进入窗口才读下一批；树事件刷新时每层读到原来读到的位置，所以画面和滚动位置不变；读失败只报一次，不循环重试（滚开再滚回来会再试）。
   - **过滤**（计划让外壳二选一）：选**只过滤已读到的节点**。过滤时按原来的办法把各层读进来（总数封顶 3000，每层读到封顶），读不完的层有后续批次时，列表上方出现一条说明“只在已读取的节点里查找……”。“全部展开”同理。
   - mock 的 `tree.children` 也按 200 一批给 `next`。
3. **未保存内容的合并（D374，§4 外壳）**
   - `state/merge.ts`：`mergeDraft(before, after, draft)` 逐字段（绑定路径）比较“页面上次显示的已保存值”和现在的；`staleFields(error)` 读 `conflict` + `params.reason === "stale"` 的 `params.fields`/`rev`。
   - 状态：`UiState.bases[tabId]`（草稿所依据的已保存值）、`UiState.merge[tabId] = {conflicts, keep}`。
   - `ViewPage`：页面被重新取回（资源变化通知本来就会触发）时比较——别处改了而草稿里没有的字段：静默更新显示；草稿里有且值不同：页面顶部出现 `Banner`（警告色，列出字段标签，按钮“保留我的”“采用新的”）；改成和草稿一样的值：丢掉那一项草稿。没有草稿的页面直接刷新。
   - “保留我的”：草稿不动，字段记入 `keep`，保存时作为 `overwrite` 发给 `page.save`（`ProtocolClient.page.save` 多了第五个参数 `overwrite?: string[]`；真客户端、混合客户端都转发）。“采用新的”：丢掉冲突字段的草稿，显示新值，页面的 `basis` 前进到当前的。
   - 出现冲突、或保留着“保留我的”时，页面的 `basis` 不前进（`page-host.tsx`），这样内核仍看得见别处的修改，由选择决定写什么；没有冲突时 `basis` 照常前进（别处只改了别的字段，保存会照常带上新 `basis`）。
   - 保存：提示条没来得及出现的竞态里内核回 `conflict/stale` → `markStale`：把字段放进待处理、重新取页面、草稿不丢、不弹错误提示（`actions.save` 返回 false）。提示条上有未回答的冲突时，保存不发给内核（直接按同样的方式拒绝）。保存成功清掉待处理并把写下去的值记为新基准（不会把自己刚存的当成“别处改的”）。
4. **类型自供子节点（D375，§5 显示）**：外壳没有为它新开代码路径——节点照常由 `tree.children` 给出，带 `target` 的点击就打开（原有逻辑），展开、分批、右键菜单、可拖动与否都用内核给的 `expandable/menu/draggable`（计划里“右键只有打开、不可拖动”由内核在节点上给出，外壳不再另行判断）。“加载失败”节点：内核给 `state: "broken"`，标签为空时外壳显示“加载失败/Could not load”（`tree.loadFailed`）；有 `stateReason` 照旧作为提示。
5. **通知入口（D376，§6）**：`ToastProvider` 多一个 `onToast` 回调；`state/notices.ts` 把每条 toast（外壳的、经 `ui` 事件来的插件通知，都走同一个 `toast()`）记进 `UiState.notices`（最多 200，最新在前，不落库）；状态栏加铃铛（`bell`，有未读时显示数字和强调色），点开 `NoticePanel`（`FloatingPanel`，和任务面板互斥）：时间、级别图标、文字、详情，可清空；打开时视为已读。
6. **“只弹提示”的入口清点**（`grep` 了 `src/workbench` 里所有 `toast(` 和“原型/未实现”文字）：
   | 位置 | 原来 | 处理 |
   |---|---|---|
   | 顶栏工作区菜单：别的工作区 | 点了弹“原型里没有” | 隐藏（只列当前这个）；多工作区属下一轮 |
   | 顶栏工作区菜单：“新建工作区…” | 同上 | 隐藏，缺：多工作区（下一轮） |
   | 顶栏工作区菜单：“在新窗口打开工作区…” | 同上 | 隐藏，缺：多窗口（下一轮） |
   | 插件页“主页”链接 | 点了弹“原型里没有” | 做实：普通外链（`target=_blank`），不再弹提示。**Tauri 窗口里点它会不会打开系统浏览器没验证**（主进程没有“打开链接”的方法；若不行，需要给 `client.app` 加 `openUrl`，是接口变更，归协调会话） |
   | `protocol/mock` 里“`X` 在原型里没有实现” | 只有假数据模式 | 不动（只在 mock 的演示命令里出现，真内核没有这条路径） |
   其余按钮都已调用内核方法；没有再发现只弹提示的。i18n 里 `common.notInPrototype`、`topbar.newWorkspace`、`topbar.openInNewWindow` 现在没有用到，留着（下一轮多工作区要用）。
7. **小修（§7 外壳）**：插件页的标题、面包屑最后一段、标签页标题按界面语言显示插件名（`tx(p.name)`，切换语言后更新；`page-host` 不再用页面描述里固定的标题覆盖它）；没有 `files` 权限的插件不显示“已授权的文件夹”一节。
8. **文字**：英、中：`tree.loadingMore/loadFailed/filterPartial`、`merge.*`、`notices.*`；内核文字表加 `conflict.stale`（键 `conflict.stale`，带 `{fields}`）。

## 测试结果（全部实际跑过）
- `pnpm typecheck`、`pnpm lint`（架构 + 界面规范）通过。
- `pnpm test`：48 个文件 392 例，通过。新增：`virtual.test.ts`（窗口算术）、`tree.test.tsx`（2 万行只画可见的、随滚动移动、`more` 行只在进入视野时要下一批且只要一次、End 键滚到底）、`data-grid.test.tsx`（1 万行只画可见的、行号是整体位置、排序对整体、短表不加空白）、`tree-batches.test.tsx`（侧栏：只读第一批、滚到末尾才读下一批、读到最后一批后没有占位行、2 万个节点读过旧上限 5000、失败的一批不循环重试）、`merge.test.ts`、`save.test.ts`（stale 的处理、未回答的冲突不发出去、`overwrite`、保存成功清理）、`merge-bar.test.tsx`（四种情形：不相交静默、相交出提示条、保留我的、采用新的、改成同一个值）、`notice-panel.test.tsx`（计数、列表、清空、打开时来的算已读）。
- `cargo test -p onedesk-host`：24 单元 + 21 集成通过；`cargo clippy -p onedesk-host --all-targets -- -D warnings` 通过（主进程这一轮没有改动，只是按完成标准跑了）。
- 假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts`：22 过、1 跳过、1 败。败的是“tree: drag onto a group”（已知的负载下偶发，`todo.md` 已记）：整套跑时败，之后单独跑 5 次里 1 次败（那次 cargo 在后台编译，机器很忙）、4 次过。跑完已 `git checkout -- docs/screenshots`。**注意**：跑完 env/plugin/sql/tasks/tree-menu 五组（明/暗）截图文件有变动，和第九轮同一批；我没有逐张比对，**不能**据此说“截图不变”——原因没查（第九轮猜是抗锯齿）。新增的状态栏铃铛在这些截图的状态栏里会出现，这是预期的改变（见下），所以这批截图本来就会不同。
- 没有跑完整 `pnpm check`、`pnpm e2e`。

## 外观上的变化（给协调会话）
- 状态栏右侧多一个铃铛（在“任务”和“密度”之间）。这会让所有带状态栏的截图有一块小差别；我没有更新基准截图（任务书要求跑完还原）。
- 顶栏工作区菜单只剩标签和当前工作区。
- 其余（树行、表格行高、间距）都取自原来的 token，窗口化不改变盒子；小于一屏的树和表格画出来的东西和以前相同。

## 假设（等内核合并后要对）
- 错误的形状：`conflict`，`params.reason === "stale"`，`params.fields` 逗号分隔的绑定路径（`name`、`description`、`tags`、`body.<字段>`——与表单字段的 `bind` 一致才能对上标签），`params.rev`。`PageSaveParams.overwrite` 字段名与类型 `string[]`。生成类型合并后 `overwrite` 要进 `real-client` 的类型检查。
- `tree.children` 的 `next` 是下一批的偏移，且“从头读到至少 N 个”的刷新靠重复调用（`loadLevel`）实现；若内核给总数，可以让滚动条更准（现在滚动条随已读取的部分增长）。
- 类型自供节点：可展开、`target`、`menu`（只有“打开”）、`draggable: false`、`accepts: []` 都按内核给的字段画；“加载失败”节点按 `state: "broken"` 且 `label` 为空识别（若内核给了文字或另一个状态，要改 `side-panel.tsx` 的行映射和 `tree.loadFailed`）。插件节点键带内核加的前缀，外壳不解析。
- `plugin:<id>` 页的 `name` 是 `Label`，用 `tx()` 取当前语言。

## 没做 / 没验证
- 没有对真内核走一遍；`e2e/round10.spec.ts` 属测试会话。
- 真窗口（Tauri）里的滚动流畅度没有量过，只有 jsdom 里的行数断言；2 万行/1 万行在真浏览器里的实际表现要在合并后看。
- 浏览器里实际点“保留我的/采用新的”走完整的保存（带 `overwrite`）没有走过（单元测试覆盖了每一步，但没有端到端）。
- 插件页主页链接在 Tauri 里是否打开系统浏览器（见上表）。
- 键盘 Home/End/上下在窗口化的树里只有 jsdom 测试（End）。

## 合并后对齐（协调分支 `e30b9d9` 合并之后）

**类型**：内核的 `NodeState` 多了 `"load-failed"`：`frame.tsx` 两张文字表和色调表、设计组件 `TreeNodeState`（图标 `circle-alert`、`od-tree__row--load-failed` 用 `--danger-text`）都认了；`stateReason` 是错误码字符串，用 `error({code})` 配文字（“The plugin failed to produce this page.”）。`node.open` 的菜单命令现在带 `target`（插件节点的键 `@…` 内核按资源找会 `notFound`）。`kernel-texts` 测试通过。

**对着真内核走了一遍**（devhost：`ONEDESK_SECRET_STORE=memory`、数据目录在会话 scratchpad、用 Playwright 驱动一个临时脚本，脚本没有提交，副本在 `/private/tmp/claude-501/walk/zz-r10-walk.spec.ts.txt`）：
- **nested 夹具**：装好，`count = 5` 的 shelf 展开后 5 个节点；第一个节点右键只有“Open”、点击打开该资源的标签页；第二个节点右键**没有菜单**；`count = -1` 的 shelf 展开后是一个“Could not load”（`data-state="load-failed"`）。✔
- **长层（用存储的资源代替，因为夹具的大 shelf 在内核里失败，见缺陷 1）**：根下 6000 个资源：展开前 DOM 里 34 行，滚到底（读完全部批次）后 DOM 里 43 行，最后一个节点可见；Home 回到第一个；过滤时出现“只在已读取的节点里查找”说明。✔　`End` 键只到**已读取**的最后一行（不会替用户读完整层）——这是有意的，记在此。
- **合并**（note 资源）：① 编辑正文不保存，别处改名称 → 没有提示条，保存后名称和正文都在（`["Renamed elsewhere","my edit one"]`）✔；② 再改正文不保存，别处改正文 → 顶部出现“Changed elsewhere”，点“Keep mine”再保存 → 库里是我的（`my edit two`）✔；③ 同样再来一次点“Use the new one” → 编辑框显示别人的值（`their edit two`）、提示条消失 ✔。**用 nested 的 `touch`（插件改 `text`）出提示条这一条没有走**（脚本没写到）。
- **通知入口**：保存两次后铃铛 `Notices (2 unread)`，点开列出两条“Saved”并带时间，“Clear”后显示“Nothing has been shown in this session.” ✔
- **示例插件的 `big` 动作**：页面上没有这个按钮（页面动作只有 Run/Save/Save & run/Explain），我用 `run.start` 启动再从任务面板打开：结果表 DOM 里 16 行，滚到底也是 16 行，排序（点 customer 表头）、拖列宽（176px → 264px）正常。✔ 但表的 `aria-rowcount` 是 **1000**，不是 1 万（见缺陷 2）。
- **插件页标题随语言、没声明 `files` 不显示“已授权的文件夹”**：这次没在真内核上走成（我写的临时脚本选择器不对，放弃了）；只有单元测试（`plugin-page.test.tsx` 新增 3 例：无 `files` 无该节、有 `files` 有该节、`name` 为 Label 时标题和标签页标题取当前语言）。
- 启动速度：6000 个资源时页面要十几秒才起来（每个请求排队，`tree.children`（资源树第一批 200 个）单次约 2 秒，`workspace.info` 约 1.7 秒）——见缺陷 3。

**缺陷（不是我的文件，没改）**
1. 内核/夹具：`e2e/fixtures/plugins/com.example.nested` 的 shelf，`count` > 500（第一批 500 个、带 `next: 500`）时 `tree.children` 整层变成“加载失败”（`pluginError`）。复现：装夹具，`page.save new:com.example.nested:shelf` 带 `body.count: 501`，`tree.children {tree:"resources", parent:<id>}`。`count` 在 200…500 之间（不带 `next`）正常，一批超 200 个被截成 200 个并给 `next:200`。推测是内核在“插件一批超过 200 个且插件自己给了 `next`”时判错（和审查 #3 的 `next` 规则有关）。所以夹具不能产生“2 万个自供子节点”，这一条验收我用 6000 个存储资源代替了。
2. 内核或示例插件：`big` 动作返回 1 万行，任务摘要说 10,000 rows，但结果表（`run.get` 的 `output.rows`）只有 1000 行（`aria-rowcount` 1000）。可能是内核把表输出截到 1000 行（`rowLimit`？）而插件注释说“不受 rowLimit 影响”。要 1 万行真的送到界面，这里要查。
3. 内核：根资源树有 6000 个资源时每个请求（`workspace.info`、`tree.children` 第一批）要 1.7–2 秒，页面启动 >15 秒（Playwright 的 15 秒断言超时就过不了）。可能是 `tree.children` 对整层排序/统计，且读连接被占着；`workspace.info` 也慢说明不只是这一个方法。

## 基准截图（10 张假数据模式）
重新生成后逐张对照提交里的旧基准（像素差异 + 肉眼看并排对比图）。**旧基准本来就已过期**，所以差别不只来自本轮：
- 本轮有意的变化：状态栏右侧多了铃铛（“任务”和“密度”之间）。`workbench-{light,dark}-tree-menu` 只有这一处（差异区域在状态栏 879–1063 × 782–796 像素）；`tasks` 里铃铛上有“1”（任务面板打开时弹了一条通知）。
- 不是本轮造成的（来自前几轮，旧基准没跟上）：`env`：环境页参数区多了“Add parameter”按钮（过滤框旁）、说明文字换行不同；`plugin`：假数据模式下“Check for updates”“Open plugin folder”按钮隐藏（第九轮）；`sql`、`tasks`、`env` 里的时间、运行记录（“Executing…”进度、结果表有了数据）、历史表的日期是随时间变的（演示数据按“现在”生成），所以每次重跑都不同。
- 没有看到错位、间距或行高的变化（树、表格、栏的盒子位置都对得上）。dark 版与 light 版的差别同上。
新基准已提交。

## 审查后的修改（`round10-review.md` 中处理人含“外壳”的条目）
- **#1**：认 `load-failed`（文字“加载失败”、图标、样式、`frame.tsx` 的表）；测试 `tree-batches.test.tsx`“a node that fails to load is drawn with words”。
- **#2**：`Tree` 的“更多”行在批次读完、行数变了、行仍在视野里时再要下一批（失败时行数不变，不重试）；测试 `tree.test.tsx`“still in view after its batch arrived”、`tree-batches.test.tsx`“small batches”。
- **#3（外壳一半）**：`children.ts` 新增 `appendBatch`：空批次、或 `next` 没有超过本批的偏移就当到头；`loadLevel/loadMore/loadChildren` 都走它；测试 `children.test.ts`、`tree-batches.test.tsx`“keeps answering the same next”。
- **#4（外壳一半）**：行的遍历和过滤带祖先集合和“已画过的键”集合：重复键只画一次，节点不会成为自己的祖先；测试“a key repeated … does not make the tree loop”。
- **#5**：跟随活动标签页时，沿路径逐层按需读后续批次直到找到目标（到头或 2 万个为止），读到后选中并滚到可见；`load` 不再用较短的第一批覆盖更长的已读层；测试“the node of the active tab is found even when it sits in a later batch”“a node that never turns up stops…”。
- **#6**：只在选中的键变了（或第一次能量出大小）时滚动；`useVirtualWindow.reveal` 返回是否生效；测试 `tree.test.tsx`“rows opening above the selected row do not pull the view back”。同时修了一个我自己引入的问题：第一次渲染时量不出大小，`reveal` 什么也没做却被记为“已滚动”。
- **#8**：窗口计算加了容器上内边距（`inset`，取自 `paddingTop`）；测试 `virtual.test.ts`。
- **#9**：`isSyntheticKey`（`@…`、`!…`、“更多”行）既不能拖、也不是放置目标（前后、里面都不行）；右键“更多”行没有菜单；测试“the placeholder row has no menu … plugin nodes are no drop targets”。
- `reveal` 在设置滚动位置后立刻重新量，不等 `scroll` 事件。
- 测试缺口三条：`load-failed` 显示、小批次连续取批、打开第 200 个以后的节点时定位——都在上面。

检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`（50 文件 422 例）通过；假数据模式 `E2E_PORT=1433 … workbench.spec.ts`：23 过、1 跳过、0 失败（本次没有再出现拖放用例的偶发失败）。
