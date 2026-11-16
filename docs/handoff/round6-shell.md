# 任务：第六轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round6-plan.md` 写，假实现补上对应数据。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round6-plan.md` §7 外壳一行）
1. 安装确认框（以及“允许版本 X？”的确认框）：权限里有 `programs` 时单独一段，警告文字“它会运行外部程序，这些程序可以访问这台电脑上你能访问的一切”，列出程序名字（`detail` 逗号分隔，带 `(plugin)` 的标为插件自带）。
2. 核对 `process.allow` 能从“添加参数”里加（来自 `params.known`）；`denied/blockedByPolicy` 对外部程序的文字；`undeclaredProgram`、`notInRun`、`notExecutable`、找不到程序（`notFound`，`what: program`）等原因码和审计操作名 `process.run`、`events.failed` 的英中文字。
3. 订阅 `plugin:<id>` 主题：收到后重新 `page.resolve` 该插件打开着的页面（不丢未保存的输入）。
4. 运行中的流式输出：核对结果区在运行进行中能显示插件经 `ctx.progress` 送来的文字（现有 `run:<id>` 进度）；不够就补到“边跑边出、结束后是完整输出”。
5. 小项：插件页版本表上方显示 `PluginDetail.switchFailure`（版本、原因、时间）；已删除页“永久删除”的确认框写明被引用数（`refs.incoming`）；引用面板用 `RefInfo.fieldLabel`，没有标签就不显示“位于…”。这三个字段内核按“只增”加，名字已定死，生成的类型合并后才有——先在外壳里按可选字段读。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round6-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round6-plan.md`、`docs/decisions.md` D331–D337、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round6-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round6-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
