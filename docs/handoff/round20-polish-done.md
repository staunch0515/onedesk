# 第二十轮 r20-polish 完成报告

## 做了什么

1. **分诊**：`round20-todo-triage.md`（todo.md 全条目；1.0 前 / 1.0 之后 / 已做掉 / 需协调会话派发），1.0 之后的项写进 `post-1.0.md`。
2. **逐页截图检查**（浅/深 × en-US/zh-CN/ja-JP；树、信息面板、SQL、环境、配置、插件、运行记录、设置、AI 设置、审计、任务面板、工作区菜单、市场、欢迎页），图在 `docs/screenshots/review20/`。方法：真内核（临时数据目录、内存密钥库）+ Playwright，并用脚本扫界面里的裸键（`a.b.c` 形、`core:…`）和被截断的文字，控制台的 `[i18n] no text` 警告也查了。
3. 查出并修的外壳问题：
   - **配置页字段名显示裸键 `ui.language`**（也是控制台警告的来源）：补 `kernel.label.ui.language`（en/zh/ja），测试里去掉对它的豁免。
   - **审计页、已删除页的标签页/标题/面包屑显示 `core:audit`**：新增 `I18n.pageTitle`，`core:` 开头的内核页名按界面语言显示（用户资源即使叫 `env` 也不会被换名，有测试）。
   - **资源树工具栏有 14 个“新建 X”按钮**，把树标题和展开/折叠按钮挤出窄面板：多于 4 个时只留“新建分组”，其余收进一个“新建”菜单（`side-panel.tsx`；有测试）。
   - **运行失败横幅**以英文错误码开头（“pluginError — …”）：只显示译好的文字。
4. 译文：中日语言包补 `kernel.label.ui.language`；其余页面的中日译文没发现缺失或明显错误（未经母语者审阅这一点沿用 todo 里的说明）。

## 检查结果

`pnpm typecheck`、`pnpm lint`、`pnpm test` 通过（见提交说明）。没有改 `crates/**`、`src-tauri/**`、`e2e/**`。

## 交给协调会话 / 其他会话的

- **假数据树（需决定）**：连真内核时混合客户端仍把 mock 的树拼进活动栏（“Demo resources / 演示资源”、“Data sources”下的“生产 Production / 测试 Test”，这个树的标题在日文界面里还是英文全大写），状态栏显示“部分为演示数据”。发布版会让用户看到假资源。建议 `mixed-client.ts` 的 `listTrees` 连真内核时丢弃 mock 的树；e2e 里若有依赖这些假树的用例由 r20-tests 跟进。我等协调会话回复后再改（未改）。
- **欢迎页（r20-package 评估，我没改）**：四个“新建 …”链接之间的纵向间距过大（约 64px 一项，像分开的段落），可压成紧凑的列表。
- **内核**：`core:audit` / `core:deleted` 的页面 `title` 是目标字符串（外壳已兜底）；配置页“外观”是自由文本框；运行错误里会带插件的堆栈行 `at <anonymous> (main.js:549:65)`（SQL 插件抛出的 `Error` 带 stack）——建议内核或 SQL 插件不要把堆栈放进用户可见的 `detail`。
- **未验证**：`new:`（未保存）SQL 直接运行时的“实际发出的 SQL”（需要真 PostgreSQL，留给 r20-parity）。
- e2e 提示（r20-tests）：运行失败横幅不再以错误码开头；资源树工具栏的“新建 X”按钮现在在“新建”菜单里（`round2.spec.ts:56` 用的是“新建分组”，仍在外面）。

## 第二轮（协调会话回复后）

- 已合并 `claude/onedesk-r20`（快进）。
- **假数据树已去掉**：`mixed-client.ts` 的 `listTrees` 连真内核时只返回内核的树；因此“Demo resources”“Data sources（生产/测试）”不再出现，状态栏“部分为演示数据”只在纯 mock 模式或打开了假页面时出现（树这一项恒为否）。单元测试改为“只列内核的树”。**受影响的 e2e**：没有找到（`workbench.spec.ts:338` 点 “Data sources” 的用例跑在纯 mock 外壳上，不连内核，不受影响；连内核的用例没有引用假树）。请 r20-tests 跑一遍确认。
- **插件堆栈行**：不是插件加的——内置插件的 `main.js` 里没有 `.stack`，是内核沙箱把插件抛出的异常（message + stack，`sandbox.rs:65`）原样放进了运行错误的 `detail`。**需要内核派发**：detail 里只留 message。
- A2（psql NULL/空串）按指示等 r20-parity，没动。

## 第三轮（r20-parity 的 sqlpool 验收缺陷，来自 `round20-parity.md` §2）

提交号见本节末（同一个提交）。缺陷 3（内核）不在我范围。

1. **K11 自由查询放行系统目录（已修）**：`plugins/org.onedesk.table/main.js` 新增 `systemName()`，`freeQueryProblem` 对 `pg_catalog`、`information_schema`、`pg_toast`、`pg_temp*`、`pg_stat_*`，以及不带 schema 也能找到的目录表/视图（`pg_user`、`pg_shadow`、`pg_roles`、`pg_class`、`pg_database` 等）返回 `systemSchema`，三种语言文件补 `ai.sql.systemSchema`。`pg_typeof` 等函数仍可用。测试在 `main.test.ts`（`SELECT usename FROM pg_catalog.pg_user` 修之前放行，现在拒绝）。
2. **G2 拖到没有子节点的环境上没反应（已修）**：根因是树组件（`src/design/components/tree.tsx`）对不可展开的行把上下各一半都算作“之前/之后”，没有“放进”这一区。现在若该行按 `canDrop(…, "inside")` 接受被拖节点，就留出中间一半作“放进”。测试 `round12.test.tsx`“dropping a node into a leaf that accepts it”（修之前失败）。
3. **配置页 datasource.default 显示原始 id（已修，外壳侧折中）**：根因在内核——配置页是内核用 `param_form` 画的，引用型参数被压成普通文本框（`pages.rs:197` 的 `Ref → FieldKind::Text`），外壳无从知道它是引用。外壳现在对“`params.` 开头、值是 32 位十六进制且能查到资源”的文本框，在框下面用小字显示资源名（框仍显示 id，可编辑）。测试在 `field-control.test.tsx`。**更干净的做法在内核**：`param_form` 对 `Ref` 输出 `FieldKind::Ref` 并给出 `options`（外壳已支持，D414），建议内核会话顺手改；改了之后外壳这段兜底可以删。
4. **F6 导入连接串偶发不填（未复现）**：在同一页面里先建第一个数据源（分别用“保存”和“保存并测试”，间隔 0–750 ms），再 New → Data source 填连接串点“Import connection string”，三种节奏共 48 次，全部填进了库/用户。读了 `view-page.tsx` 的事件路径（`pageParams(now.tab.params)` → `page.event` → `setDraft`）和 `run-refresh.ts`，没有发现按标签页之间共享的状态。没有足够线索改代码，留作未复现；若 r20-parity 再遇到，请记下当时第一个数据源的运行是否还没结束。

## 范围外

见 `post-1.0.md` 末尾“逐页检查新增”四条。
