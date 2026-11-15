# 第三轮外壳（claude/week1-shell-74b52c）：运行、插件页、命令面板接真内核

## 做了什么
- 已合并 `claude/week1-slice-3b4ae5`（72a3c7c）。
- 类型：`Run`、`RunOutput`、`RunStatus/Progress/Summary/Error`、`PluginDetail/Version/Setting/Load/Provides`、`PluginPermission`、`PaletteCommand` 改为从生成类型再导出。界面一侧的超集：`Run.input` 保留宽松 JSON，`PluginPermission` 多一个演示用的 `label?`，`ActionDecl` 多 `action?`（完整动作 id）和 `confirm?`（`Label`）——协议补充（§6）合并后改成生成类型。
- 真客户端：`run.start/get/cancel/listFor/tasks/clearFinished/setKept/render`、`page.event`、`plugin.get/setEnabled/setSetting/reload`、`command.palette`；`run.start` 按协议类型发（`input` 里数字仍是数字，空的环境不发）；`command.execute` 的 `open` 效果里的 `params/envId` 折进界面的 `state`（`normalizeEffects`）。
- 混合客户端：运行按所属资源分边（内核资源→内核，演示资源→假实现），之后每次 `run.get/cancel/render/setKept` 跟着那次运行的归属走；任务面板、运行记录树、插件树、插件页、命令面板、`page.event`（对真资源）都走内核；`plugin:<id>` 一律内核页面；`run:<id>` 按归属。假实现的 `plugins`、`runs` 树与内核同 id，有真内核时自动去掉；数据源树与 SQL 等演示页面仍是演示并有徽标。
- 页面（`view-page.tsx`）：动作用 `ActionDecl.action`（没有就用原来的规则）；有 `confirm` 的 `run/save-run` 动作先弹确认框再执行；对真资源页，数字/布尔字段的草稿与运行输入按类型（数字、布尔）保存和发送，演示页仍是文字。
- 插件页：对内核插件，“版本”一栏只读（没有激活/固定按钮）、权限开关禁用、“授权文件夹”动作走 `plugin.grantFolder`，新增“已授权的文件夹”区列出并可移除；权限名按 id 取字（未知原样）。
- 文字：内核命令 `plugin.enable/disable`、`run.cancel/keep/unkeep/openResource/reuse`，树 `plugins`、`runs`，审计操作 `plugin.setSetting`、`run.cancel`，权限 id，运行失败码（`pluginDisabled`、`interrupted`、`badOutput`、`timeout`、`unknownAction`、`badInput`，`i18n.runError`；其余失败码仍显示运行自带的消息）；文字键齐全性测试已跟着补。

## 测试与检查
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（116）通过；`cargo test -p onedesk-host`（3+11）、clippy 通过；纯假数据 `e2e/workbench.spec.ts` 23 过 1 跳过，截图已还原。
- 新增：混合客户端（运行分边并跟到各自一边、任务只取内核、插件页/插件状态/命令面板/页面事件走内核）、真客户端（`run.start` 的形状、`open` 效果折叠）、文字齐全性（运行失败码）。

## 我做的决定
- 演示页上开始的运行不会出现在任务面板里（任务面板只读内核的 `run.tasks`），但页面里的结果区照常通过 `run.get` 显示。
- 数字/布尔按类型发送只在“连着内核且页面是内核的”时做，纯假数据模式和演示页不变。

## 没做或没验证
- **没有用真内核实跑**（内核另一会话在写）：参数条、重算、动作、取消、历史页签、`run:<id>` 页面、运行记录树、插件启用/停用与设置、命令面板，都只按生成类型与文档接了线，靠假内核客户端测试；没有界面一级的新测试（只有客户端一级的）。
- 确认框（`confirm`）、数字/布尔转换没有界面测试。
- 命令面板的分组名 `group` 是内核给的 `Label`，若是文字键，需要补文字（齐全性测试看不到，因为内核代码还没合进来）。
- 插件页的设置项沿用现有控件，数字设置按文字发送（协议 `plugin.setSetting` 的 `value` 就是字符串）。
- 插件树的 `plugin:<id>` 页面里“版本”只读、权限只读，按计划本轮不做安装/权限确认。
