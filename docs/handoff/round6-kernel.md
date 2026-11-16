# 任务：第六轮——内核（Opus）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。

## 目标
实现 `docs/handoff/round6-plan.md` §3–§6 的内核与工作进程部分：清单 `requires.programs`、`contributes.events`；宿主能力 `process`（`run`、`ready`）、策略 `process.allow`、插件自己的目录、审计与合并计数；宿主能力 `events`（`on`）与 `plugin:<id>` 主题；小项里内核的部分（`PluginDetail.switchFailure`、`RefInfo.fieldLabel`、`refs.incoming` 对已删除目标可查）。

## 允许修改
`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改；加了就 `pnpm gen:types` 并提交生成的 TS）；`docs/handoff/round6-kernel-done.md`；`docs/handoff/todo.md`（只追加）。新依赖先写进交接文件（用途、替代方案、许可证，仅 MIT/Apache-2.0/BSD/ISC/Zlib/Unicode-3.0），能用标准库和已有依赖（`libc` 若已在依赖树里）就不加。

## 只读依赖
`docs/handoff/round6-plan.md`（逐条遵守，名字已定死）、`docs/redesign/kernel-design.md` §6.3、§7.2、§7.4、§7.5、§13、`docs/decisions.md` D331–D337、前几轮的 `*-kernel-done.md`（按需读小节）。

## 完成标准
`round6-plan.md` §8 列出的内核测试全部有并通过；`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`、对应的 clippy（`-D warnings`）、`sh scripts/gen-types.sh --check`、`pnpm lint` 通过。数据库结构只新增迁移。测试里的外部程序只用系统自带的 `/bin/echo`、`/bin/sh`、`/bin/sleep`、`/bin/cat` 和测试临时写的脚本；测试结束不留子进程。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round6-kernel-done.md`：完成了什么、测试结果、清单新增部分、宿主接口的确切签名、协议只增的字段、新增错误原因码与审计操作名（列全）、我做的决定、新依赖、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round6-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录和内存密钥库，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
