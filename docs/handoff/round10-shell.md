# 任务：第十轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round10-plan.md` 里定死的名字写（协议类型合并后才生成，先在外壳里按可选字段和本地类型写），假实现补上对应数据。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round10-plan.md` §8 外壳一行）
1. §3：树和结果区表格的虚拟滚动；树的子节点按需分批（去掉 5000 的上限）。实现放 `src/design` 的基础组件。
2. §4 外壳：未保存内容被别处修改时的静默合并与提示条（“保留我的”→ 保存时带 `overwrite`；“采用新的”）；保存遇 `conflict/stale` 的处理。
3. §5 的显示：类型自供的子节点（可展开、带 `target` 的可打开、右键只有“打开”、“加载失败”节点的文字）。
4. §6：状态栏的通知入口；清点并处理所有“只弹提示”的按钮、菜单项、命令（做实或隐藏，交接文件里列表）。
5. §7 外壳：插件页标题按界面语言；没声明 `files` 的插件不显示“已授权的文件夹”一节。
6. 本轮新增原因码（`stale` 等）的英中文字。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round10-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round10-plan.md`、`docs/decisions.md` D372–D376、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。主进程里不写插件名字。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round10-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round10-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
