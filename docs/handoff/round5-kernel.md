# 任务：第五轮——内核（Opus）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。

## 目标
实现 `docs/handoff/round5-plan.md` §3–§7 的内核与工作进程部分：引用（`refs`、两种字段声明、读出时换成当前名称）、`refs.outgoing/incoming`、`params.known`、`workspace.export/importPreview/import`、策略 `protection.readonly` 与 `protection.no_export`（含 `restrictions`）、`run.export`。

## 允许修改
`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改；加了就 `pnpm gen:types` 并提交生成的 TS）；`docs/handoff/round5-kernel-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round5-plan.md`（范围与约定，逐条遵守）、`docs/redesign/kernel-design.md` §3.5、§4、§6.3、§7.6、§9.5、§10、§13、`docs/decisions.md` D321–D328、`docs/handoff/round4-kernel-done.md`（按需读小节）。

## 完成标准
- `round5-plan.md` §9 列出的内核测试全部有并通过；`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol` 全过；`cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings` 无警告；`sh scripts/gen-types.sh --check` 通过；`pnpm lint`（架构检查：内核里不得出现任何具体插件的名字或逻辑）通过。
- 数据库结构只新增迁移（0008 起），有升级测试。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round5-kernel-done.md`：完成了什么、测试结果、清单新增部分、协议只增的字段、新增错误原因码与审计操作名（列全，外壳据此配文字）、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round5-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录和内存密钥库，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。
