# round3/tests（分支 claude/week1-plugins-15d46f）：第一阶段——示例插件

## 完成了什么
- `plugins/org.onedesk.sample/`（id `org.onedesk.sample`，类型 `query` “示例查询 / Sample query”）：
  - 清单按 round3-plan §4：动作 `run`；页面 `editor`（`recompute`、`usesEnv`；动作 运行/保存/保存并运行/整理（事件 `tidy`）；结果页签 `result`（output）、`final`（view）、`history`）；设置 `rowLimit`（number，默认 200）、`style`（enum，upper/lower）；“新建”菜单；作者/许可/主页。python3 -m json.tool 已校验。
  - `main.js`：参数条从正文的 `:name` 得出（忽略字符串与注释里的；按后缀猜类型：`_id`/`limit` 数字、`_time` 日期时间、`_date` 日期、其余文字；`host.params.get` 有值则给 `envValue` 与 `envSource`）；占满高度的 `code` 编辑区（`bind: body.text`）；用 `host.storage` 记最近一次运行的摘要并作为 muted 文字显示在页面上；`onEvent("tidy")`（按设置 `style` 改关键字大小写，返回 `{changes, message}`，没有变化只返回 message）；`renderResultTab("final")`（把 `:name` 换成这次运行的参数值）；`run:<id>`/结果页签渲染时（`ctx.run`）参数条与编辑区只读。
  - 动作 `run`：按正文与参数散列生成固定表格（4 列，行数受 `rowLimit` 限制，`total` 是未截断的总数），`ctx.progress` 三次（0.1/0.4/0.8），每步 `ctx.host.util.sleep`（250/300/200 ms）；`!fail` 抛错；`!slow` 约 20 步每步 1 秒、每步查 `ctx.cancelled()`（取消后立即返回 `none`）；`!text` 输出文字。
  - 英、中语言文件；vitest（假 host）：辅助函数、页面渲染各分支、事件、结果页签、动作各分支（成功/确定性/rowLimit/!fail/!text/!slow 与取消/宿主错误透传）、所有用到的文字键在两份语言文件里都有。
- `plugins/_testing/view-check.ts`：`registry` 现在也收 `actions`；新增 `checkActionResult`（动作返回值“无多余字段”：输出按类型、`summary` 只有 `rows`/`message`）、事件返回值的键表。
- `scripts/check-arch.mjs`：插件的测试文件可以 import `node:fs/path/url`（读自己包里的文件）。

## 测试与检查结果
`pnpm test` 通过（20 个文件、131 个测试，示例插件 20 个）；`pnpm lint`、`pnpm typecheck` 通过。

## 我做的决定
- 正文放在 body 的 `text`（绑定 `body.text`，与笔记一致）。
- `ctx.t(key)` 不带占位符，所以带数字的文字（“上次运行：{rows} / {total} 行”等）由插件自己按 `ctx.locale` 取出并替换 `{name}`。
- 返回值只用协议里的字段：动作结果 `{output, summary:{rows?, message?}}`（不带 `truncated`、`durationMs`，由内核补）；事件结果 `{changes?, message?}`；`render` 只返回 `{view}`。
- `!slow` 被取消时返回 `{output:{type:"none"}}`（内核应已把这次运行记为取消，结果作废）。

## 没验证
- 内核第三轮尚未合并，插件没有在真沙箱里跑过：`host.actions`、`ctx.host.util/params/storage/settings`、`ctx.progress/cancelled`、`onEvent`、`renderResultTab` 的真实形状按文档假设；清单的 `"confirm": null`、`"saveFirst"` 是否被严格校验接受要合并后看。
- `e2e/round3.spec.ts` 第二阶段（合并后）再写。
