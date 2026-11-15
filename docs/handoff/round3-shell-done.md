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

## 合并后的对齐（对着真内核跑过）
- 已合并 `claude/week1-slice-3b4ae5`（8f86dc8）。
- 文字：补了 `core:plugin`、`core:run`，审计操作 `plugin.state`、`run.keep`、`run.unkeep`，错误原因 `unknownSetting/badValue/badKey/pluginDisabled/callEnded`，运行失败码 `invalidInput`（我原先写成 `badInput`，已改）、`pluginError`，命令面板分组名 `core`（“工作区”）；`runError` 对没有专门文字的失败码退到通用错误码文字（`denied`、`conflict` 等）再退到运行自带的消息。文字齐全性测试的清单跟着更新（`params.get` 是宿主方法不是审计操作，已列入忽略）。`pnpm test` 135 项全过。
- 类型对齐：`ActionDecl` 直接用生成类型（`action`、`confirm` 已在内）；`open` 效果用生成类型的 `params/envId`（界面的 `open()` 现在直接读 `effect.params/effect.envId`，演示效果的 `state` 仍支持）；删掉了我的 `normalizeEffects` 与它的测试。
- 读了“我做的决定”，与我假设不一致、已改的：失败码名（见上）；`plugin.get` 的 `load.ms/at` 不给、`versions[].installedAt` 为 0——插件页对此不再显示“0 ms”和“1970 年”（显示“已加载”和“—”）；`builtin` 恒为 false（没有“内置”徽标，需要的话要主进程告诉）；`plugin.reload` 不重读清单（界面“重新加载”按钮保留，提示不变）；对内核插件隐藏“检查更新”。
- **对着真内核实跑**（`cargo build -p onedesk-worker -p onedesk-host`；devhost + 临时目录；Vite 开发服务器；一个不提交的临时 Playwright 脚本，已删除）。看到的：
  - 启动：树按 内核 + 演示 排列；工作区名取自内核（之前误用演示的名字，已改：混合模式下 `workspace.list` 只列内核的工作区，`startTargets` 为空，不再开出演示标签页——之前会开出一个指向不存在的演示插件的坏标签页）。
  - “新建”菜单里有“示例查询”；新建后页面有参数条、动作区（运行 / 保存 / 保存并运行 / 整理）、结果区三个页签。
  - 在编辑区输入 `:user_id`、`:limit`，约 300 ms 后参数条出现这两项（重算有效）。保存并运行：状态栏出现运行摘要，结果区先显示进度再出表格（59 行，有行号、排序），任务面板和“历史”页签都有这次运行。运行结束后页面上的“上次运行：59 / 59 行”也会刷新（我加了：运行状态从进行中变为结束时让页面重新解析）。
  - `!fail`：结果区留着 `pluginError — 插件运行时出错（详情见下）`和异常全文；`!slow`：显示“取消运行”按钮，点了得到“这次运行已取消”，历史里记为已取消（1.6 s）。
  - 运行记录树：`#4…#1`，状态徽标，失败的带删除线；点一条在新标签页打开 `run:<id>`：只读的输入快照、状态/时间/耗时/环境、编辑区内容是当时的。
  - 插件树三个插件；插件页：停用后树里变灰、页面写“已停用”；再启用恢复。改设置 `rowLimit=5` 后再运行得 5 行（设置有效）。“整理”把 `select a from b` 改成 `SELECT a FROM b`。命令面板列出内核命令（组名原来是原始键 `core`，已补文字）、各插件的命令和“新建”项。
  - 浏览器控制台全程没有错误或警告。
- **发现的内核/插件问题（没改它们的文件）**：
  1. 示例插件的 `!text` 路径返回文字输出，但清单里动作声明的是 `output: "table"`，内核按声明拒绝（`badOutput — declared table, got "text"`）。要么清单声明改成可变，要么 `!text` 不可行；任务书说含 `!text` 时输出文字，两者矛盾，需要插件会话/协调会话定。
  2. 命令面板里“Duplicate”（笔记的命令）在没有节点上下文时也出现，从面板执行会怎样没试。
  3. 运行记录树里失败的运行带删除线，且和“插件被停用”的灰色删除线样式一样，容易混淆（`state: broken` 的通用样式）；纯界面问题，暂不改。
- 检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`（135）通过；纯假数据 `e2e/workbench.spec.ts` 23 过 1 跳过；截图已还原。

## 第三轮审查后的修改
- 已合并 `claude/week1-slice-3b4ae5`（c75425a）。
- #7 运行失败原因：表里的 `badInput` 早已改成 `invalidInput`（上一节）；这次再按内核实际会发的码补齐：内核自己的 + 透传的 `denied/invalid/conflict/notFound/invalidParams/internal`（走通用错误文字）。没有文字、运行也没带消息的失败码，显示“运行失败（原因：<码>）。”（`RUN_FALLBACK`），不再留空白；状态栏、任务面板、结果区都经 `i18n.runError`。
- #6 语言：`run.start`、`run.render` 现在带 `locale`（测试在 `real-client.test.ts`）。
- #13 审计操作名：按内核文档里实际会写的对齐——`resource.*`、`params.set/unset/acknowledge`、`workspace.setConfig/startup`、`plugin.state`、`plugin.grant`、`files.write`（原来写成 `file.write`）、`run.start/end/keep/unkeep`，以及插件被拒的宿主调用名（`resources.*`、`files.*`、`settings.get`）；去掉了我臆造的 `plugin.setSetting`、`run.cancel`（审计表里；`run.cancel` 作为命令的文字还在）。演示用的几个操作名保留。测试清单同步（`kernel-texts.test.ts`）。
- 错误原因：按内核文档补齐全部 `reason`（`emptyName`、`parentNotFound`、…、`cancelled`、`timeout`、`threw`、`badOutput`、`outOfMemory`、`engine` 等，英中），所以“停用插件的资源 `page.save` → `denied/pluginDisabled`”、“取消后的宿主调用 → `cancelled`”“超时 → `timeout`”都有文字；清单被拒的原因（`schema`、`apiVersion`、`mainMissing`…）也配了文字，插件树里 `stateReason` 会显示出来。测试：`i18n/index.test.tsx`（失败文字不空白、回退句、`denied/pluginDisabled`、`cancelled`、`timeout`）、`kernel-texts.test.ts`（全部原因都有英中文字）。
- 内核还在修，我是按它文档里列出的名字对的；它提交后再合并时若有出入，改 `kernel-texts.ts` 的表和测试清单即可。没有再对着真内核实跑这几处。
- 检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`（143）通过；纯假数据 e2e 22 过 1 失败 1 跳过，失败的仍是早已知道的“tree: drag onto a group”偶发项（干净提交上也会失败）；截图已还原。
