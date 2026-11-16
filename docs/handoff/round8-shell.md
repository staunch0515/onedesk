# 任务：第八轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round8-plan.md` 里定死的名字写（协议类型合并后才生成，先在外壳里按可选字段和本地类型写），假实现补上对应数据。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round8-plan.md` §6 外壳一行）
1. 页面参数：`page.resolve`、`page.event`、内容变化后的重算，`context` 里都带 `params`（页面上 `param: true` 字段当前的值，与 `run.start` 的 `params` 同一份）；`PageEventResult.params` 应用到页面状态，不产生“未保存”标记。改 `param: true` 字段本身不得让页面显示“未保存”。
2. `RunError.params`：运行失败的文字里写明名字（`blockedByPolicy` 带 `program`/`host` 和 `layer`、`notFound` 带 `program`、`undeclaredProgram` 带 `program`、`hostNotAllowed` 带 `host` 等；没有 `params` 时沿用现在的笼统文字）。
3. 插件页：`PluginDetail.unmetExports`（全名列表）——显示“以下类型不可用：对方没有导出 …”；权限 `pages` 的明细（`<插件id>:<page>` 列表，说法：“它的内容由这些插件的页面显示，这些插件能读到这类内容”）在安装确认框和权限表里的显示。
4. 核对（尽量不改代码，改了写明）：别的插件的树的“新建”里出现依赖方的类型；用别人页面的资源能打开、编辑、保存，操作区是“页面的 save/event 动作 + 依赖方自己的动作”，结果区没有 `view` 页签；新建被拒 `denied/notExported` 的提示。
5. 文字（英、中）：原因码 `notExported`、`undeclaredDepend`、`exists`（用在搬运目标上）、`notInRun` 等本轮新增或新用到的；审计操作名 `transfer.download`、`transfer.upload`、`transfer.capture`。搬运的进度沿用运行进度的显示，不新增界面。
6. `todo.md` 里外壳的两条小项：已删除页“永久删除”的确认框显示被引用数（并去掉 `e2e/round5.spec.ts` 里那条 `test.fixme` 由测试会话做，你只改界面）；信息面板“引用”一节不显示字段内部名（显示字段标签，取不到就不显示）。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round8-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round8-plan.md`、`docs/decisions.md` D352–D360、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。主进程里不写插件名字。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round8-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round8-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
