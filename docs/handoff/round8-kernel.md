# 任务：第八轮——内核（Opus）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。

## 目标
实现 `docs/handoff/round8-plan.md` §3–§5 的内核与工作进程部分，按这个先后（前面的先交付，做不完的如实写明）：
1. §5 三项：`PageContext.params` → `ctx.params`、`PageEventResult.params`；`RunError.params`；指纹换 SHA-256（`sha2`）并处理库里的旧指纹。
2. §3 `ctx.host.transfer`（`download`、`upload`、`capture`），含等待时间不计入动作预算（也适用于 `process.run`）。
3. §4 `exports.trees`、`exports.pages`，类型的全名 `tree`/`page`，`unmetExports`，权限 `pages`。

协议类型按计划里定死的名字“只增”加进 `crates/protocol`，`pnpm gen:types` 并提交生成的 TS。注意 `crates/kernel/src/transfer.rs` 已被第五轮的导出导入占用，新模块另起名字。

## 允许修改
`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、`src/workbench/protocol/generated/**`（只由生成脚本写）、根 `Cargo.toml` 与 `Cargo.lock`（只为加 `sha2`，D359 已记）；`docs/handoff/round8-kernel-done.md`；`docs/handoff/todo.md`（只追加）。不加别的新依赖（确需要先写进交接文件：用途、替代方案、许可证）。

## 只读依赖
`docs/handoff/round8-plan.md`（逐条遵守）、`docs/redesign/kernel-design.md` §7.3–§7.5、§9.3、§13、`docs/decisions.md` D352–D360、前几轮的 `*-kernel-done.md`（按需读小节：第四轮网络、第六轮外部程序、第七轮依赖与导出）。

## 完成标准
`round8-plan.md` §7 列出的内核测试全部有并通过；`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`、对应的 clippy（`-D warnings`）、`sh scripts/gen-types.sh --check`、`pnpm lint` 通过。数据库结构只新增迁移。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round8-kernel-done.md`：完成了什么、测试结果、清单新增部分、宿主接口的确切签名、协议只增的类型与字段、新增错误原因码与审计操作名（列全）、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round8-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录、本机临时 HTTP 服务和内存密钥库，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
