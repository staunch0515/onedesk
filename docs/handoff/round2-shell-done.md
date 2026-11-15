# 第二轮外壳（claude/week1-shell-74b52c）：框架部分接真数据

## 做了什么
- 已合并 `claude/week1-slice-3b4ae5`（85c8b64）。
- `types.ts`：`EnvParam/EnvView/EnvOption/EnvLayer/ResolvedParam/ParamType/HistoryEntry/SearchHit/AuditRow/AuditFilter/AuditFacets/…` 改为从生成类型再导出；假实现的审计行保留自己的 `operationLabel`（`MockAuditRow`，演示专用），历史条目补 `op`，环境视图补 `rev`。
- `ProtocolClient`：新增 `resource.setFavorite`。真客户端（`real-client.ts`）新增 `workspace.getConfig/setConfig`、`params.*`、`resource.history/restore/listDeleted/undelete/purge/setFavorite`、`search.query`、`audit.list/facets`。
- 混合客户端：上述方法走内核；`environments` 演示树去掉（`config/favorites/deleted` 与内核同 id，自动以内核的为准）；`core:*` 目标（审计、已删除）算内核页面；演示页面解析时不带环境（演示页只认假环境）；演示的 `env`、`tree:environments` 主题订阅映射到内核的 `tree:env`。
- 界面：审计页按操作 id 取字（`i18n.operation`，`AUDIT_OPERATIONS` 英中，含内核与演示的操作名，未知原样显示）；`source` 是字符串，未知原样显示；标签页选的环境被删后在页面顶部提示重新选择（`page.envDeletedTitle/Body`；只在真有此情况时才出现提示区，纯演示外观不变）；错误文字支持 `code.reason`（`invalid.duplicateName` 等）。
- 文字（`i18n/kernel-texts.ts`，英中）：内核命令 `env.newChild`、`node.favorite/unfavorite`、`deleted.restore/purge`、`open.audit/deleted`；树 `env/config/favorites/deleted`；类型 `core:env/config/audit/deleted`；审计操作名；错误原因。
- 语言、主题、密度本来就经 `client.workspace.getConfig/setConfig` 读写，混合模式下它们现在落在内核；`app.tsx` 已订阅 `config` 事件。

## 测试与检查
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（96+）通过；新增混合客户端 3 项（配置/环境/搜索/审计走内核且去掉演示环境树、历史按归属、`core:` 页面）、审计操作名中英对齐。`cargo test -p onedesk-host`（3+11）、`cargo clippy -p onedesk-host -p onedesk --all-targets -- -D warnings` 通过。
- 纯假数据 `e2e/workbench.spec.ts`：22 过 1 失败 1 跳过。失败项是“tree: drag onto a group …”，**它在没有我这轮改动的干净提交上也同样失败**（连跑“typing :name”+“tree: drag”两项，干净提交 6 次失败 4 次；单独跑它则通过）：移动后树里同一个节点出现两次（`Encountered two children with the same key`），看起来是树刷新与移动的竞态，与这轮无关，也与第一轮时的偶发失败同类。没有修（不属于本轮范围，也许在 `side-panel.tsx` 的 `refresh` 与 `commit` 之间；需要的话可单独立项）。截图已还原。

## 我做的决定
- 演示页面一律不带环境（避免假页面拿到内核的环境 id 后出错）。代价：混合模式下演示 SQL 页的环境参数值为空。
- 演示树里删除的资源在内核的“已删除”页看不到（它只列内核的）；演示资源的恢复要用“Reset demo data”。
- 内核没有 `tree:environments`，用主题别名映射；若内核主题名不同，改 `mixed-client.ts` 的 `TOPIC_ALIASES`。

## 没做或没验证
- **没有用真内核（本轮内核另一会话在写）实跑**：环境页、配置页、已删除页、审计页、历史与恢复、搜索、语言/主题/密度落内核，都只按生成类型和文档写，用假内核客户端测。
- 配置节点的页面（`stack` 表单、`autosave`）沿用现有 `ViewPage`，没有为它改任何东西；`params.<名字>` 绑定路径经 `page.save` 发出，是否正好对得上内核，要合并后看。
- 内核的 `config` 事件之外，主题/语言切换仍有“先立即应用再等事件确认”的行为（沿用）。

## 审查后的修改
- 已合并 `claude/week1-slice-3b4ae5`（84b66f5）。
- #6 归属：`ownerOf` 只缓存某一边明确给出的肯定答案。内核出错就把错误抛出去（写操作不会发给假实现）；内核说没有再问假实现，假实现有才缓存为“演示”；两边都没有就交给内核（它会答 notFound），不缓存否定结果。测试：`mixed-client.test.ts` 的“内核出错/说没有时不把写操作发给假实现”。
- #3 并发：`params.set/unset/acknowledge` 带可选 `basis`（`String(EnvView.rev)`）；环境页用它，失败（含 `conflict`）时提示并重新读取环境。测试：`real-client.test.ts`（有 basis 时发送、没有时不发送）。环境页对 conflict 的刷新没有单独的界面测试。
- #8 `setConfig`：失败不再被吞——`onSetting` 返回 Promise，失败时把存着的设置读回来恢复界面，并弹出错误提示。没有专门测试。
- #12 默认名：`env.newChild`、`config.newChild`、`node.newGroup` 在 `args.name` 里带当前语言的默认名（`default.newEnv/newConfig/newGroup`，英中）；调用方给了名字就不覆盖。演示实现忽略 `args`，纯演示外观不变。
- 文字：审计操作名 `params.set/unset/acknowledge` 早已有；新增错误原因 `invalid.secretUnsupported`（英中）。
- 检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`（99）通过；纯演示 e2e 22 过 1 失败 1 跳过，失败项仍是上一节说的、干净提交上也会失败的“tree: drag onto a group”。截图已还原。

## 界面检查后的修改（G1、A1）
- G1：信息面板（`parts/info-panel.tsx`）底部新增“修改记录”区，默认折叠（一个“查看修改记录”幽灵按钮）。展开后才调 `resource.history`（新的在前），每条显示 时间·操作者、字段、`改前 → 改后`（各截到 40 字加省略号）、已恢复标记、“恢复”按钮（`resource.restore`，只读资源不显示）；订阅 `resource:<id>` 刷新。只用 `Pane/Text/Badge/Button/InfoField` 与 toast，没有新样式。演示资源经混合客户端照旧走假实现。
- A1：`StatusItem`（`src/design/components/workbench.tsx`）在没有文字、只有 `title` 时把 `title` 作为 `aria-label`（调用方传的 `aria-label` 优先）；状态栏里只有主题按钮是这种情况，其余都有文字或已有 `aria-label`。
- 测试：`parts/info-panel.test.tsx`（默认折叠且不读历史、新的在前+截断+恢复、空记录），`design/components/status-item.test.tsx`。`pnpm typecheck`、`pnpm lint`、`pnpm test`（104）通过；纯假数据 `e2e/workbench.spec.ts` 23 过 1 跳过（这次连“tree: drag”那个偶发项也过了）。
- 基准截图：信息面板底部多了一行“修改记录 / 查看修改记录 ›”（在“版本”之后），所以带信息面板的页面会有这点变化：`workbench-{light,dark}-sql.png`、`-tasks.png`（SQL 资源页）、`-env.png`（环境页）。`-plugin.png`、`-tree-menu.png` 不应有变化；e2e 重新生成它们时有些字节差异，我没有提交任何截图（已还原），请协调会话决定是否更新基准。

## 确认框与文字键（验收后）
- `deleted.purge.confirm`：`kernel-texts.ts` 里有英中全文（不可撤销；清除这条资源及其全部历史；启动快照 `backups/` 里可能仍保留到被轮换掉）；`KERNEL_CONFIRMS` 给这个键配标题“永久删除？”和确认按钮“永久删除”（危险样式，来自效果的 `danger`）。别的 `confirm` 消息仍用通用标题“确定吗？”和“确定”。另补了 `config.newChild`、审计操作 `workspace.startup`、`resource.move`，以及错误原因 `changedOnDisk/helloFirst/notLoaded/providedTree/unknownKind`（`reason.<名>` 键；`error()` 先找 `code.reason` 再找 `reason.<名>`）。
- 键名不再悄悄显示：`tx` 遇到像键的字符串（`a.b`、`core:x`）又没有文字时，开发构建在控制台警告一次（仍原样显示）。
- 测试：`i18n/kernel-texts.test.ts` 列出内核会发出的全部命令/树/类型/确认键、审计操作名、错误原因，要求英中都有；还会扫描 `crates/kernel/src` 里出现的新命令键、审计操作名，没配文字就失败（逼着改这个测试的清单）。`parts/command-dialogs.test.tsx` 检查确认框不显示键名、写明不可撤销与 backups、按钮叫“永久删除”。
- 检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`（111）通过；纯假数据 e2e 见提交时的结果（下一行）。
- 纯假数据 e2e：23 过 1 跳过。
