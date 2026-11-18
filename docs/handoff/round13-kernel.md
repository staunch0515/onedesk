# 任务：第十三轮——内核（Opus）

协调分支 `claude/onedesk-coord-4-3ac9ba`（你的工作树从它切出）。

## 目标
实现 `round13-plan.md` §2 的内核部分和 §3 的 `workspace.settingsSnapshot` / `init-settings.json`：第一版库的识别与一次事务的转换、`legacyKinds` 认领与 `kinds.handle` 的 `upgrade`、未认领类型的树节点状态、新的原因码与审计名。协议类型按计划里定死的名字“只增”加进 `crates/protocol`，`pnpm gen:types` 并提交生成的 TS。第一版结构：`git show bf8f6b0^:src-tauri/migrations/0001_init.sql`；需要第一版运行时的细节（`schema_version` 的写法、时间格式、tags/body 的 JSON）在 git `bf8f6b0^` 的源码里查。测试夹具自己在 Rust 里按该 SQL 建。

## 允许修改
`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、`src/workbench/protocol/generated/**`（只由生成脚本写）；`docs/handoff/round13-kernel-done.md`；`docs/handoff/todo.md`（只追加）。数据库结构只新增迁移；不加新依赖。

## 完成标准
`round13-plan.md` §5 的内核测试全部有并通过；`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`、clippy（`-D warnings`）、`sh scripts/gen-types.sh --check`、`pnpm lint` 通过。

## 交付物
小步提交（不推送、不合并）；`round13-kernel-done.md`：完成了什么、测试结果、宿主接口 `upgrade` 的确切签名、协议只增的类型与字段、新增原因码与审计名（列全）、未认领节点用的状态值、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round13-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录、本机临时 HTTP 服务和内存密钥库（`ONEDESK_SECRET_STORE=memory`），绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`（那里可能有用户真实的第一版 `onedesk.db`，**不要读、不要拷**；夹具自己建）。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。做完用 SendMessage 把汇报发给协调会话（回复它发给你的消息的发送方），开头写分支名和最后一个提交号。
