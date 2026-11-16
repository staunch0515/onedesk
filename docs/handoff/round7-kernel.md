# 任务：第七轮——内核（Opus）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。

## 目标
实现 `docs/handoff/round7-plan.md` §3–§5 的内核与工作进程部分：清单 `depends`、`exports`、`requires.plugins.install`；依赖是否满足的判断、依赖方的停用与恢复、对切换/自动切换/停用/移除的限制；导出点两种（依赖方给被依赖类型加动作、读被依赖类型的资源）及其权限与指纹；宿主能力 `plugins`（`requestInstall`、`list`）、方法 `plugin.installRequests`、`plugin.answerInstallRequest`、主题 `install-requests`；`PluginDetail.depends`、`dependents`；审计。协议类型按计划里定死的名字“只增”加进 `crates/protocol`，`pnpm gen:types` 并提交生成的 TS。

## 允许修改
`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）；`docs/handoff/round7-kernel-done.md`；`docs/handoff/todo.md`（只追加）。不加新依赖（确需要先写进交接文件：用途、替代方案、许可证）。

## 只读依赖
`docs/handoff/round7-plan.md`（逐条遵守）、`docs/redesign/kernel-design.md` §7.2、§7.3、§7.5、§7.6、§13、`docs/decisions.md` D342–D348、前几轮的 `*-kernel-done.md`（按需读小节）。

## 完成标准
`round7-plan.md` §8 列出的内核测试全部有并通过；`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`、对应的 clippy（`-D warnings`）、`sh scripts/gen-types.sh --check`、`pnpm lint` 通过。数据库结构只新增迁移。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round7-kernel-done.md`：完成了什么、测试结果、清单新增部分、宿主接口的确切签名、协议只增的类型与字段、新方法与主题、新增错误原因码与审计操作名（列全）、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round7-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑（内核不知道“市场”是什么）。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录和内存密钥库，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
