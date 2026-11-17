# 任务：第十一轮——插件与测试，第一阶段（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核和外壳会话同时在写；这一阶段你只做不依赖它们的部分。第二阶段（`e2e/round11.spec.ts` 连真内核）等合并后由协调会话另行通知，**这一阶段不要写**。

## 目标
`docs/handoff/round11-plan.md` §5 的全部（名字、字段、动作已定死，逐条照做）：语言插件 `org.onedesk.lang.zh-cn`、`org.onedesk.lang.ja-jp`（含键一致性检查）；`org.onedesk.link`；`org.onedesk.prompt`；`org.onedesk.note` 的阅读态与 `legacyKinds`；`org.onedesk.http` 的 `legacyKinds`；`org.onedesk.welcome`。内核和外壳同时在写：清单里本轮新增的字段（`contributes.languages`、`legacyKinds`、页面的 `startup`、文字节点的 `format`、`ctx.host.ui.openExternal`）按计划里定死的名字写，vitest 用假 host；`pnpm lint` 的内置插件检查若不认新字段，改 `scripts/check-*.mjs`。新内置插件要让主进程复制得到（照现有内置插件放在 `plugins/` 下即可）。

## 允许修改
`plugins/**`、`e2e/fixtures/**`、`scripts/check-*.mjs`；`docs/handoff/round11-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round11-plan.md`、`crates/**`、`src/**`、现有夹具。

## 完成标准
`pnpm test`、`pnpm lint`（含架构检查和内置插件的检查）、`pnpm typecheck` 通过；写完 JSON 立即 `python3 -m json.tool` 校验。

## 交付物
自己分支上的提交（不推送、不合并）；`docs/handoff/round11-tests-done.md`：做了什么、测试结果、我做的假设（合并后要对着真内核核对的）、没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round11-plan.md`、本文件；其余按需读。只改“允许修改”里的文件；不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：做完就停。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
