# 任务：第十轮——插件与测试，第一阶段（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核和外壳会话同时在写；这一阶段你只做不依赖它们的部分。第二阶段（`e2e/round10.spec.ts` 连真内核）等合并后由协调会话另行通知，**这一阶段不要写**。

## 目标
1. 新夹具 `e2e/fixtures/plugins/com.example.nested/0.1.0/`（英、中语言文件，假 host 的 vitest；写法照 `com.example.keeper`）：类型 `shelf`（字段 `count` 数字、`text` 长文本；清单 `"children": true`；页面一个表单，`save` 动作）。`kinds.handle("shelf", { children(ctx, node, offset) })`：按资源的 `count` 给出那么多个节点（标签 `Item 00001`…，随 `ctx.locale` 中英不同），每批 500 个、用 `next` 续；第一个节点带 `target: "resource:<这条资源的 id>"`，其余没有 `target`；`count` 为 -1 时抛错（验证“加载失败”）。另一个动作 `touch`（运行：用 `ctx.host.resources.update` 把这条资源的 `text` 改成固定文字——用来验证“被插件改了”的合并）。
2. `plugins/org.onedesk.sample/`：加一个动作产出 1 万行、5 列的表格（若现有动作已能通过参数做到，就不加，在交接文件写明怎么触发）；更新 vitest。

## 允许修改
`plugins/**`、`e2e/fixtures/**`、`scripts/check-*.mjs`；`docs/handoff/round10-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round10-plan.md`、`crates/**`、`src/**`、现有夹具。

## 完成标准
`pnpm test`、`pnpm lint`（含架构检查和内置插件的检查）、`pnpm typecheck` 通过；写完 JSON 立即 `python3 -m json.tool` 校验。

## 交付物
自己分支上的提交（不推送、不合并）；`docs/handoff/round10-tests-done.md`：做了什么、测试结果、我做的假设（合并后要对着真内核核对的）、没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round10-plan.md`、本文件；其余按需读。只改“允许修改”里的文件；不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：做完就停。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
