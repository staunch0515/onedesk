# 任务：第九轮——插件与测试，第一阶段（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核和外壳会话同时在写；这一阶段你只做不依赖它们的部分。第二阶段（`e2e/round9.spec.ts` 连真内核）等合并后由协调会话另行通知，**这一阶段不要写**。

## 目标
1. `e2e/fixtures/plugins/com.example.transfer/`：没有 `total` 时 `ctx.progress(null, …)`；更新 vitest。
2. `plugins/org.onedesk.market/`：清单读得出但缺必需字段、或 `id`/`version` 与所在目录不符的包标为“不可用”并给原因，不进“要安装的包”下拉；更新 vitest。
3. 新夹具 `e2e/fixtures/plugins/com.example.keeper/0.1.0/`（英、中语言文件，假 host 的 vitest）：一个类型 `box`（字段 `text`），页面一个表单和两个 `event` 动作——`remember`（把草稿文字存进 `ctx.host.storage`）、`recall`（读出来经 `changes` 填回）；动作 `stash`（运行：把这次运行的 `ctx.host` 存到模块级变量，输出文字 `stashed`）和 `slow`（运行：`ctx.host.util.sleep` 20 秒，用来验证运行中不回收）；页面事件 `abuse`（用存下来的那个 host 调 `network.request`，把宿主的错误原样作为 `message` 返回——用来验证 `staleContext`）；一个提供树 `keeper`，`children` 返回一个标签随 `ctx.locale` 变的节点。清单 `requires` 要一个固定主机的网络（写法照现有夹具）。
4. `e2e/fixtures/make-many-plugins.mjs <目录> <个数>`：在给定目录生成指定个数的最小合法插件包（`<id>/0.1.0/manifest.json`、`main.js`、`locales/en-US.json`），只写给定目录，拒绝 `~/Library/Application Support/onedesk*`；附单元测试（用 20 个）。

## 允许修改
`plugins/**`、`e2e/fixtures/**`、`scripts/check-*.mjs`；`docs/handoff/round9-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round9-plan.md`、`crates/**`、`src/**`、现有夹具。

## 完成标准
`pnpm test`、`pnpm lint`（含架构检查和内置插件的检查）、`pnpm typecheck` 通过；写完 JSON 立即 `python3 -m json.tool` 校验。

## 交付物
自己分支上的提交（不推送、不合并）；`docs/handoff/round9-tests-done.md`：做了什么、测试结果、我做的假设（合并后要对着真内核核对的）、没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round9-plan.md`、本文件；其余按需读。只改“允许修改”里的文件；不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：做完就停。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
