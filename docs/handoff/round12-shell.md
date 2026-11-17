# 任务：第十二轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round12-plan.md` 里定死的名字写（协议类型合并后才生成，先在外壳里按可选字段和本地类型写），假实现补上对应数据。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round12-plan.md` §6 外壳一行）
1. 树节点 `dropAny`：允许把任何资源节点放到这种节点“上面”（前后仍按普通规则），放下时调现有的移动方法；内核返回的提示文字（如“已加入 N 项”）显示出来；拖动中的放置提示沿用现有样式。
2. 权限 `resourcesAll` 在安装确认框和插件页权限表里的文字（英语）。
3. 核对并补最小实现（写明改了什么）：自供子节点的“失效”状态显示；视图表格的行内动作（移除、上移、下移这类带事件名的行按钮）与“点行打开目标”——若视图表格还不支持，就按现有视图树节点的约定给出最小实现（基础组件放 `src/design`）。
4. 不要改 `src/workbench/i18n/kernel-texts.ts` 的结构（第十一轮的收尾在另一个会话里改它）；新文字只往 `en-US.ts` 加。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round12-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round12-plan.md`、`docs/decisions.md` D388–D392、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。主进程里不写插件名字。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round12-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round12-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
