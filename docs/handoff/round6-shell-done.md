# 第六轮 外壳：完成记录

分支 `claude/r6-shell-96639c`。只改了 `src/workbench/**`（含新测试），没动 host/src-tauri/design（外观不变，没有新增 CSS）。

## 做了什么
1. **外部程序的单独一段**（`parts/programs-notice.tsx`）：安装确认框和插件页“允许版本 X？”确认框里，`programs` 权限不再把 `detail` 当小字，而是一条警告横幅“它会运行外部程序，这些程序可以访问这台电脑上你能访问的一切”+ 程序名列表，带 `(plugin)` 的标“插件自带”。
2. **文字**（`i18n/kernel-texts.ts`）：`reason.undeclaredProgram`、`reason.notInRun`、`reason.notExecutable`、`notFound.program`、审计 `process.run`、`events.failed`，中英文；`blockedByPolicy` 的文字改为同时说明 network.allow / process.allow。`error()` 在没有 `reason` 时按 `params.what` 找 `<code>.<what>`（为 `notFound`+`what: program`）。`process.allow` 进“添加参数”：来自 `params.known`，核对过，不需要改代码。
3. **`plugin:<id>` 主题**（`parts/page-host.tsx`）：页面所属插件（目标 `plugin:<id>`、页面动作 `<pluginId>:<name>` 的前缀、资源 `kind` 的前缀）收到主题就 `page.reload`→重新 `page.resolve`，草稿（`drafts[tab.id]`）随请求带上，未保存输入不丢。
4. **流式输出**（`parts/result-area.tsx` `useLiveLog`）：运行中把 `run.progress.message` 逐条累积成日志（最多 2000 条）显示在代码块里；只有一条消息时仍是原来的单行，所以现有外观/截图不变。结束后显示插件的完整输出。
5. **小项**：插件页版本表上方 `switchFailure` 提示（版本、原因、时间）；已删除页“永久删除”确认框写被引用数（`refs.incoming`，无引用则原文）；引用面板用 `fieldLabel`，没有标签就不显示“位于…”。假实现的引用补了 `fieldLabel`。

## 测试结果（我实际跑过）
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（34 文件 217 用例，含新的 `parts/round6.test.tsx` 6 条）通过。
- `cargo test -p onedesk-host`、`cargo clippy -p onedesk-host --all-targets -- -D warnings` 通过。
- `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts`：23 通过、1 条原本就跳过；已 `git checkout -- docs/screenshots`，截图无改动。

## 等内核合并后要对的假设
1. `PluginPermission.id === "programs"`，`detail` 是逗号分隔的名字，插件自带的以 ` (plugin)` 结尾。
2. `PluginDetail.switchFailure?: { version, reason, at }`，`at` 为毫秒时间戳；`reason` 按 `reason.<reason>` 在错误文字表里找，找不到就原样显示（可能要补 `migrateFailed` 之外的原因文字）。插件树节点的“状态原因”由内核给 `stateReason`，外壳已有显示，未单独改。
3. `RefInfo.fieldLabel?: Label`；合并后可去掉 `protocol/round6.ts` 里的 `switchFailureOf`/`fieldLabelOf`/`RefInfoR6`，改读生成类型。
4. 运行里外部程序被拒的 `RunError`：`code` 为 `denied`/`invalid`，`reason` 为上面几个原因码，已能出字；找不到程序的 `RunError` 若 `code: notFound` 且没有 `reason`，只会显示“它已经不存在了”或插件自己的消息——`RunError` 目前没有 `what`，需要内核给 `reason: "program"` 才能出“找不到这个程序”（`notFound.program` 已备）。
5. 页面所属插件取自 `Resource.kind` 的 `<pluginId>:` 前缀；`plugin:<id>` 主题由内核在事件处理函数结束后发。
6. `refs.incoming` 对已删除目标也返回引用方（内核任务书里已写）；若不支持，确认框只是不显示被引用数。
7. 流式：内核的 `run.progress` 只保留最新一条，外壳靠 `run:<id>` 主题到达时取到的消息累积；若插件一次发得比刷新快，中间几条会漏，**结束后的完整输出才是准确的**。需要真正的逐块输出就得内核给进度增量（本轮没要求）。

## 没做 / 没验证
- 没有连真内核跑；假数据里没有播种 programs 权限、switchFailure 的插件，这几处只靠 vitest 覆盖（e2e 的 `round6.spec.ts` 由测试会话写）。
- 日志不会自动滚到底；实际体验待合并后看。
- 没改 host/src-tauri（无需）。
