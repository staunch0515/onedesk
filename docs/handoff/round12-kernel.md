# 任务：第十二轮——内核（Opus）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。

## 目标
实现 `docs/handoff/round12-plan.md` §3、§4：
1. `requires.resources`、权限 `resourcesAll`、`ctx.host.resources.search`（只给基本信息）、有此权限时自供子节点的 `target` 可指向任意资源。
2. 插件决定的放置：类型声明 `drop`、`kinds.handle` 的 `drop`、树节点 `dropAny`、移动入口里的分流、审计 `tree.drop`。

协议类型按计划里定死的名字“只增”加进 `crates/protocol`，`pnpm gen:types` 并提交生成的 TS。

## 允许修改
`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、`src/workbench/protocol/generated/**`（只由生成脚本写）；`docs/handoff/round12-kernel-done.md`；`docs/handoff/todo.md`（只追加）。不加新依赖（确需要先写进交接文件：用途、替代方案、许可证）。

## 只读依赖
`docs/handoff/round12-plan.md`（逐条遵守）、`docs/redesign/kernel-design.md` §5、§7.2、§7.5、`docs/decisions.md` D388–D392、前几轮的 `*-kernel-done.md`（按需读小节）。

## 完成标准
`round12-plan.md` §7 列出的内核测试全部有并通过；`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`、对应的 clippy（`-D warnings`）、`sh scripts/gen-types.sh --check`、`pnpm lint` 通过。数据库结构只新增迁移。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round12-kernel-done.md`：完成了什么、测试结果、清单新增部分、宿主接口的确切签名、协议只增的类型与字段、新增错误原因码与审计操作名（列全）、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round12-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录、本机临时 HTTP 服务和内存密钥库，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
