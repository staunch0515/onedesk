# 任务：第五轮——插件与测试，第一阶段（Sonnet）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。内核和外壳会话同时在写；这一阶段你只做不依赖它们的部分。第二阶段（`e2e/round5.spec.ts` 连真内核）等合并后由协调会话另行通知，**这一阶段不要写**。

## 目标
1. 笔记插件（`plugins/org.onedesk.note/`）：清单里正文字段声明 `{ "type": "longtext", "refs": true }`（字段名以现有清单和 `main.js` 为准；格式见 `round5-plan.md` §4）；正文的占位提示里加一句可以写 `[[名称]]`（英、中）；vitest 断言清单声明。不改页面结构。
2. `e2e/fixtures/exports/sample/`：一个手写的导出文件夹，格式按 `round5-plan.md` §5（`manifest.json`、`resources.json`、`revisions.json`、`runs.json`、`audit.json`、`blobs/`），内容：一个分组；两条互相用 `[[名称]]` 引用的笔记；一条类型为本机没有的插件（如 `com.example.missing` 的 `thing`）的资源；一条带外部键的笔记（第二阶段会先在工作区里建一条同外部键的）。具体的字段名内核会话还没定：按计划文字和 `kernel-design.md` §3.3 的资源字段写，并在交接文件里写明“合并后要对着内核实际导出的文件校正”。
3. `e2e/fixtures/exports/broken/`：`manifest.json` 的 `format` 不对的一个文件夹；另一个 `version: 99` 的。
4. `plugins/_testing` 里若需要支持 `refs` 字段声明的检查，跟着补。

## 允许修改
`plugins/**`、`e2e/fixtures/**`、`scripts/check-*.mjs`；`docs/handoff/round5-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round5-plan.md`、`docs/redesign/kernel-design.md` §3.3、§3.5、§10、`crates/**`、`src/**`。

## 完成标准
`pnpm test`、`pnpm lint`、`pnpm typecheck` 通过；写完 JSON 立即 `python3 -m json.tool` 校验。

## 交付物
自己分支上的提交（不推送、不合并）；`docs/handoff/round5-tests-done.md`：做了什么、测试结果、我做的假设、没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round5-plan.md`、本文件；其余按需读。只改“允许修改”里的文件；不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：这一阶段很小，做完就停。
- 没运行过、没看到结果的如实写出，不说“完成”。
