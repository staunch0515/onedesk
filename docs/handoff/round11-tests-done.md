# 第十一轮·插件与测试·第一阶段 完成说明

分支 `claude/r11-tests-6101f2`。只改了 `plugins/**`、`e2e/fixtures/**`、本文件。第二阶段（`e2e/round11.spec.ts`）没有写。

## 做了什么
- `org.onedesk.lang.zh-cn`：`shell/zh-CN.json` 由 `zh-CN.ts` 原样转出（489 键）。`org.onedesk.lang.ja-jp`：`shell/ja-JP.json` 489 键逐条翻译。`main.js` 为 `export default {}`；自带三份 `locales/`（插件名与说明）。
- `org.onedesk.link`：类型 `link`（`url`、`profile`）；页面表单；动作 `open`（运行）→ `ctx.host.ui.openExternal(url)`，输出 `link`（目标 `resource:<id>`）；空地址、非 http/https/mailto、超过 2048 字符、含空白 → 插件自己的错误文字。`legacyKinds: ["link"]`。
- `org.onedesk.prompt`：类型 `prompt`；页面 `recompute: true`，每个 `{{名字}}`（字母数字 `_` `-` 中文，≤40，带冒号不算）一个 `param: true` 输入框；页面事件 `copy`（`ctx.params` 代入，没填的留原样，`ctx.host.ui.copy`，返回“已复制”）；运行动作 `preview` 输出代入后的文字。`legacyKinds: ["prompt"]`。
- `org.onedesk.note`：页面 `recompute: true`，加事件 `toggle`；阅读态渲染 `{ type: "text", format: "markdown", text }`（用未保存草稿）；状态用**页面参数** `mode`（`edit`/`read`），事件返回 `{ params: { mode } }`。`legacyKinds: ["note"]`；补 `ja-JP` 语言文件。
- `org.onedesk.http`：只加 `legacyKinds: ["http-request"]` 和 `ja-JP` 语言文件。
- `org.onedesk.welcome`：独立页面 `welcome`（`startup: true`），Markdown 介绍 + 四个 link 节点（`new:org.onedesk.note:note`、`new:org.onedesk.link:link`、`new:org.onedesk.prompt:prompt`、`new:org.onedesk.http:request`）。
- 测试：每个插件一个 vitest（假 host）；`plugins/_testing/lang-check.test.ts`（两份语言 JSON 与 `en-US.ts` 键集合相同、`{占位符}` 一致；`{{secret:名字}}` 这类字面示例不算占位符）；`plugins/_testing/locale-check.test.ts`（功能插件三份语言文件键与占位符一致）；`view-check.ts` 认 `text.format`。
- `e2e/fixtures/market/org.onedesk.note/0.1.0/` 是内置笔记包的逐字节副本（`round7-fixtures.test.ts` 检查），随笔记改动同步更新。
- `scripts/check-*.mjs` 没改：`pnpm lint` 不校验清单字段，新字段不会被拒。

## 我做的假设（合并后要对着真内核核对）
1. 清单里的 `legacyKinds`、页面 `startup`、`contributes.languages` 按计划名字写；内核若对 `contributes.languages` 的 `main` 有要求，已满足（`main.js` 存在）。
2. 链接动作不写 `default: true`（现有动作清单没有这个字段）；“默认动作”按页面上 `primary` 的运行动作理解。如果内核有专门的默认动作字段，要补。
3. 笔记的阅读态状态放在页面参数 `mode`，并声明了一个 `param: true` 的 enum 输入（“模式”）保证外壳保留它；`onEvent` 返回 `{params:{mode}}`。假定 `recompute: true` 的页面在参数变化后会重新 `render`。
4. `org.onedesk.link` 的输出是 `{type:"link", label, target:"resource:<id>"}`；没有资源 id 时输出 `none`。
5. 提示词的 `copy` 用 `ctx.params` 取参数、用草稿或资源正文取文字；假定页面事件上下文里有 `ctx.draft`、`ctx.params`、`ctx.host.ui.copy`（任务书写明）。`preview` 动作的参数也从 `ctx.params` 取。
6. 欢迎页没有现成接口判断插件是否启用，**四个入口全部显示**（`new:` 目标对应的插件没启用时点击的行为由外壳/内核决定）。
7. `ctx.t` 返回 Label（对象）；欢迎页的文字节点与 `title` 手工取当前语言的字符串，不直接把 Label 放进 `text`。
8. 语言插件的名称写成各自语言的“XX 语言”形式只放在 `locales/`（插件名），语言自己的显示名在 `contributes.languages[].name`（`简体中文`、`日本語`）。

## 测试结果
- `pnpm lint` 通过；`pnpm typecheck` 通过（无输出）；`pnpm test`：468 通过、2 个失败（`src/workbench/parts/tree-batches.test.tsx`，外壳的文件，满载并行时超时；单独跑该文件 11/11 通过，我没动 `src`）。`plugins` 下全部通过。

## 没验证的
- 没有连真内核：清单字段是否被内核接受、页面事件/参数的真实行为、`openExternal`/`copy` 的真实效果都没验证。
- 日语译文没有母语者审阅。
- 没有跑 `pnpm e2e`、`pnpm test:rust`、`pnpm clippy`（本阶段不涉及）。
