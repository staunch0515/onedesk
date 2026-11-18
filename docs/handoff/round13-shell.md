# 任务：第十三轮——外壳与主进程（Sonnet）

协调分支 `claude/onedesk-coord-4-3ac9ba`（你的工作树从它切出）。

## 目标
1. `round13-plan.md` §2 主进程部分：只有第一版 `onedesk.db` 时备份并移动到 `workspaces/default/`（`crates/host/src/data_dir.rs`），失败原因码 `legacyMoveFailed`。
2. §3 全部：主进程的 `app.workspaces`、`app.createWorkspace`、`app.switchWorkspace`、`app.renameWorkspace`、`app.deleteWorkspace` 与事件 `app.workspacesChanged`（devhost 同样支持，浏览器里可验收）；一个主进程管理多个工作区的工作进程、连接按工作区转发；标题栏工作区菜单、新建/改名对话框、删除确认；假数据模式的演示；界面上的升级失败与未认领类型的显示（按内核交回的原因码与状态）。
3. 新增文字只加英语（`en-US.ts`），中日由测试会话补。协议类型等内核会话加；在那之前按计划里的名字写可选字段，合并后对齐，并**对着真内核实际走一遍再交**。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round13-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 完成标准
`round13-plan.md` §5 的主进程测试；`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、clippy 通过；假数据模式 `workbench.spec.ts` 全过、截图不变（有意变化逐张对照后更新并写明）。

## 交付物
小步提交（不推送、不合并）；`round13-shell-done.md`：完成了什么、测试结果、主进程方法与事件的确切形状、文件夹命名与 `trash/` 规则、新增文字键、我做的决定、没做/没验证的（桌面窗口里没看到的如实写）。

## 共同规则
- 先读 `CLAUDE.md`、`round13-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录、本机临时 HTTP 服务和内存密钥库（`ONEDESK_SECRET_STORE=memory`），绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`（那里可能有用户真实的第一版 `onedesk.db`，**不要读、不要拷**；夹具自己建）。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。做完用 SendMessage 把汇报发给协调会话（回复它发给你的消息的发送方），开头写分支名和最后一个提交号。
