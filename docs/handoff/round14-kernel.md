# 任务：第十四轮——内核（Opus）

协调分支 `claude/onedesk-coord-4-3ac9ba`（你的工作树从它切出）。

## 目标
`round14-plan.md` §2 表里“内核（Opus）”那一行，按 §1、§3 的标准做完。

## 允许修改
`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、`src/workbench/protocol/generated/**`（只由生成脚本写）；`docs/handoff/round14-kernel-done.md`；`docs/handoff/todo.md`（只追加）。

## 交付物
`round14-kernel-done.md`：做了什么、测试结果、处理过的 todo 条目（修了/以后＋理由）、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round14-plan.md`、本文件；大文件按需读小节。`todo.md` 只处理自己范围内的条目，处理结果（修了/以后＋理由）写进自己的交接文件，不改别人的条目。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。自行决定，不要停下来问；决定写进交接文件。
- 测试只用临时目录、本机临时 HTTP 服务和内存密钥库（`ONEDESK_SECRET_STORE=memory`），绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 小步提交（不推送、不合并），提交信息 `<范围>: <做了什么>` + 空行 + 为什么。跑过 e2e 后用 `git checkout -- docs/screenshots` 还原基准截图，只提交本轮新增的截图。
- 交回前跑自己范围的全部检查；e2e 相关的跑**全部** `pnpm exec playwright test`（先 `cargo build -p onedesk-worker -p onedesk-host`）。没运行过、没看到结果的如实写出。做完用 SendMessage 回复开你的协调会话，开头写分支名和最后一个提交号。
