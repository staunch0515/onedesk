# 任务：第十五轮——外壳与主进程（Sonnet）

协调分支 `claude/onedesk-coord-4-3ac9ba`（你的工作树从它切出）。

## 目标
`round15-plan.md` §2 表里“外壳与主进程（Sonnet）”那一行，按 §1、§3 的标准做完。参考旧程序 `/Users/zhongpingxue/quizbuks/sqlpool`（只读）。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round15-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 交付物
`round15-shell-done.md`：做了什么、测试结果、B、C、D、F 中归你的各行的结论、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round15-plan.md`、本文件；大文件按需读小节。范围外的问题追加到 `todo.md`。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。自行决定，不要停下来问；决定写进交接文件。
- 测试只用临时目录、本机临时 HTTP 服务和内存密钥库（`ONEDESK_SECRET_STORE=memory`），绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 小步提交（不推送、不合并），提交信息 `<范围>: <做了什么>` + 空行 + 为什么。跑过 e2e 后用 `git checkout -- docs/screenshots` 还原基准截图，只提交本轮新增的截图。
- 交回前跑自己范围的全部检查；e2e 相关的跑**全部** `pnpm exec playwright test`（先 `cargo build -p onedesk-worker -p onedesk-host`）。没运行过、没看到结果的如实写出。做完用 SendMessage 回复开你的协调会话，开头写分支名和最后一个提交号。
