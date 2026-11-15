# round3/tests（分支 claude/week1-plugins-15d46f）：示例插件与第三轮界面检查

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

## 第二阶段（合并 3bd050a 之后）
- 示例插件：去掉 `!text`（它与动作声明的 `output: "table"` 冲突）；新增动作 `explain`（`output: "text"`，页面动作区“Explain / 说明”，角色 `run`），输出“这段正文用到的参数：”+ 每个参数的取值与来源（手填 / 来自环境 / 未设置）；vitest 相应更新。`ctx.locale`、事件只改绑定字段（`body.text`）的约定已确认符合。
- `e2e/round3.spec.ts`（连真 devhost）逐项覆盖：新建示例查询并写 `:name` 出参数条；运行出表格、状态栏与任务面板有这次运行；`!slow` 进度并取消、历史里记为已取消；`!fail` 的原因留在结果区；“Explain”出文字；“Tidy”改了未保存内容、标签变未保存；“Final text”页签；历史页签点一条在新标签页打开那次运行（内容是当时的，只读）；运行记录树；环境里有同名参数时参数条显示占位值与来源；插件树三个插件、停用后资源变灰、页面提示已停用、`run.start` 得 `pluginDisabled`、`page.save` 被拒、新建菜单没有它的项，启用后恢复；改设置 `rowLimit` 后行数变化；授权文件夹列出与移除；命令面板列出内核命令与插件的“新建”项并能执行；未保存的新建页面上直接运行成功；重启 devhost 后运行历史还在。截图 `docs/screenshots/round3-*.png`。
- 结果：`E2E_PORT=1432 pnpm e2e`：**57 通过、0 失败、3 跳过**（2 个 `test.fixme`：S-R1、K-R1；1 个 workbench.spec 原本就跳过的 review shots）。`pnpm lint`、`pnpm typecheck`、`pnpm test` 通过。

### 发现的问题
**K-R1（内核，`crates/kernel/src/pages.rs` 的 `new:` 目标）**：`page.resolve {target:"new:org.onedesk.sample:query"}` 返回 `resultTabs: []`，同一插件的资源页（`resource:<id>`）有三个页签。后果：未保存的新建页面没有结果区——点“运行”本身成功（状态栏有记录、`run.tasks` 里有），但表格、历史、最终文本页签都看不到。期望：`new:` 页面也带清单里页面声明的 `resultTabs`（和 `recompute`/`usesEnv`）。检查：`test.fixme("running on an unsaved new page shows the result table")`；“直接运行也能成功”本身有通过的检查。

**S-R1（外壳，运行结束后页面不重新绘制）**：运行结束后页面上的“上次运行：N / M 行”（插件用 `storage` 记的，随页面渲染）仍是“还没有运行过”，重新打开页面才更新。内核没问题（运行结束后 `page.resolve` 就返回新值，已用协议验证）。复现：打开一条已保存的示例查询，运行，等表格出来，页面上那行不变。外壳交接文件说“运行状态从进行中变为结束时让页面重新解析”，但在这个流程里没有发生（可能只对未保存的新建页面生效——那里我看到它更新了）。检查：`test.fixme("the page refreshes when a run ends and shows the stored last-run summary")`；“重新打开后摘要在”有通过的检查。

**观察（非缺陷）**：
- 运行很快（约 0.8 秒），普通运行的进度文字一闪而过，检查里用 `!slow` 看进度。
- 停用插件后它在树里的节点和它的资源节点都是 `aria-disabled`，点不了；“页面提示已停用”要靠已打开的标签页看到，再启用也要从已打开的插件页标签进入（或用协议）。检查按此写。
- 界面把环境里的参数值也当作“手填值”随运行送出，所以“Explain”对环境里有值的参数写的是“= 42 (entered here)”而不是“from environment”（插件代码里“来自环境”分支由 vitest 覆盖）。
- 事件类动作（Tidy）在“More actions”菜单里。
