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
