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

---

# 第二阶段：`e2e/round11.spec.ts`（连真内核）

已合并协调分支 `d7a5b52`。先做的第 1 项（`link.refused` 键补进两份语言 JSON）单独提交 `4476e30`；`lang-check` 只对照 `en-US.ts`，外壳可以删 `zh-CN.ts`。

## 怎么跑
`cargo build --workspace`（devhost 会拉起 `onedesk-worker`，只编 host 不够）→ `E2E_PORT=1435 pnpm exec playwright test e2e/round11.spec.ts`。devhost 用 `ONEDESK_SECRET_STORE=memory` 和临时目录；`window.open`、剪贴板在页面启动前被替换成记录器，不会打开真浏览器。

## 覆盖（17 条，串行）
- 协议：`i18n.languages` = en-US、ja-JP、zh-CN（顺序、名字、`plugin`）；`i18n.shell` 两种语言键集合一致、en-US 和未知语言空表；`plugin.get.legacyKinds`（note、http、link、prompt；welcome、语言插件为空）；`workspace.info.startupPages`。
- 欢迎页：全新数据目录第一次启动显示；四个入口各打开对应类型的编辑页；已有标签页的启动不再弹出；关掉后不再回来。
- 网址：`run.start` 的 `ui` 主题发 `openExternal` 带地址；审计 `ui.openExternal` 的对象只有主机名，没有路径/查询；界面里点“打开”→ `window.open` 被调用一次；`javascript:`、`file:` 被插件拒绝并显示文字；协议层这几种、`ftp:`、超长地址的运行都以 error 结束、不发效果、不增加审计行。
- 提示词：`{{name}}`、`{{城市}}` 两个输入框，`{{secret:x}}` 没有；输入后不出现“Unsaved”；“复制”→ 剪贴板是代入后的文字（`{{secret:x}}` 原样保留）；协议层 `page.event copy` 发 `ui` 的 `copy` 效果；`preview` 输出。
- 笔记阅读态：标题、列表、行内代码、代码块渲染；显示的是未保存草稿；`<script>`、`<img onerror>` 原样显示成文字且没执行；网址链接走 `window.open`；`javascript:` 链接不成为 `<a>`；保存后 `[[Other note]]` 可点并打开那条笔记；解析不到的 `[[…]]` 是失效样式（`od-markdown__ref--broken`）点了不开标签；切回编辑草稿还在。
- 语言：不带 `lang` 默认英语；状态栏菜单有英语/日语/中文，选中文、日语立即变并写入 `ui.language`，刷新后保持；插件页面（网址编辑页）的字段文字随语言变；停用日语插件后选项消失、日语界面回到英语，重新启用后恢复；英/中/日三种语言下抽查三个页面没有形如 `a.b.c` 的键名。

## 与计划/任务书不一致或要注意的
1. **关掉欢迎页再刷新**：任务书写“关掉后刷新不再自动打开”，但外壳实现（`startup.ts`，D382 原文“直到又一次没有任何标签页的启动”）是：刷新时若没有标签页就再打开。我的测试只断言“关掉后同一次会话里不会回来”和“有标签页时刷新不弹出”，**没有**断言“全部关掉后刷新仍不弹”（那与实现相反）。需要协调会话确认想要哪种。
2. 内核把网址里的主机名转小写再发效果（`https://Docs.Example.com/…` → `https://docs.example.com/…`），测试按这个写。
3. 笔记阅读态的“模式”下拉（`param: true` 的 enum，没有默认值）在编辑态显示成一个空的“Choose”框：内核/外壳没有给页面参数默认值。功能没问题，但观感上多余；可考虑让页面参数支持默认值。（没改，没有标 fixme。）
4. 未保存草稿里新写的 `[[x]]` 在阅读态是失效样式，保存后才能点（外壳交接里已写的已知限制）；测试里先保存再点。
5. 外壳的内核词表（`kernel-texts.ts`）没有日语；日语界面里内核错误文字回退英语（外壳交接第 6 点）。我没有对此写断言。
6. 首个 `shell:` 测试偶尔会撞上刚启动的 devhost 还没就绪（第一次整套运行里出现过一次“workspace service stopped”），重跑通过；没有加重试。

## 测试结果
`E2E_PORT=1435 pnpm exec playwright test e2e/round11.spec.ts`：**17 通过，0 跳过，0 fixme**（串行，约 3 分钟；只有一次整套运行中前面反复的失败是我自己的测试写法问题，已修）。`pnpm typecheck` 通过、`pnpm lint` 通过。截图 `docs/screenshots/round11-*.png` 生成后没有提交（已删，重跑即可再生成）；`git checkout -- docs/screenshots` 已执行。

没有标 `test.fixme`。没有发现需要改别人文件的缺陷。

7. 写测试时踩到的：`getByText("bad link")` 会匹配到资源名 “Bad link”（大小写不敏感的子串）；`page.reload()` 前要等 `ui.get layout` 里已经没有欢迎页（布局是稍后才保存的）——这两个是测试写法问题，不是产品缺陷。

## 审查 #10（笔记页 `recompute: true`）：保留，原因
外壳只有一条重画页面的路径：`view-page.tsx` 里的 recompute 效果——页面声明了 `recompute`，且草稿或页面参数变了，才在 300 ms 后重新 `page.resolve`。页面事件的返回值（`params`、`changes`）只改标签页状态/草稿，**不会**触发重画。所以去掉 `recompute` 后，点“阅读 / 编辑”改了 `mode` 参数，页面不会变。代价是编辑时每次停顿多一次 `render`（笔记的 render 很轻，不调宿主接口）。要真正去掉，需要外壳在页面事件返回 `params` 后主动重新 resolve（外壳的文件，我没改）；那之后把 `recompute` 删掉即可，vitest 里对应一行断言要改。已在 `main.test.ts` 的测试里写明原因。
Markdown 的界面断言本来就按渲染结果（角色、文字、`a.od-markdown__ref--broken`）写，不依赖具体库；`[bad link](javascript:alert(1))` 一条断言的是“保留为纯文本”，换库后若输出不同需要对一下。

## 验收三处（合并 `2f7f60a` 之后）
1. **欢迎页切语言后介绍/标题不变——外壳问题，`test.fixme`**。插件按 `ctx.locale` 取字（vitest 里 zh 已测），入口是 Label 所以会变；`text` 节点和 `title` 是插件按渲染时的语言解析出的字符串，外壳在界面语言变化后不会重新 `page.resolve`（`view-page.tsx` 里唯一的重取是 `recompute` 效果，只看草稿和页面参数）。重新打开页面后就是新语言。位置：`src/workbench/pages/view-page.tsx` 的 recompute 效果（缺“语言变了就重取”）。`e2e/round11.spec.ts` 里 `test.fixme("shell: the welcome page's title and intro follow a language change…")`，修好后去掉 fixme 即可（中、日、英三个来回）。
2. **网址 `open` 输出**：本来就走 `ctx.t`（用 `ctx.locale`）。新增界面检查：日语界面运行“開く”后结果区是“example.com を開きました”（通过）。我试过把输出 `label` 做成各语言的 Label 让它随语言变，**内核拒绝**（`badOutput`：动作的 link 输出 `label` 必须是字符串），已还原。所以运行输出是运行时语言的字符串，切语言后不会变——这是协议类型（`RunOutput::Link.label: String`）的限制，要变就得改协议（接口决定）。
3. **笔记“模式”下拉默认值**：给 `mode` 字段加了 `envValue: "edit"`（外壳的枚举控件显示 `value || envValue`），首次打开显示“Edit”而不是占位符；没有 `envSource` 所以没有“来自环境”的提示。vitest 和界面检查（`combobox "Mode"` 含 Edit）已加。
4. markdown 库换成 `marked` 后，把“`[bad link](javascript:alert(1))` 保留为纯文本”那条文字断言去掉了（输出细节因库而异），仍保留“没有 javascript: 的 `<a>`、没有名为 bad link 的链接”。

结果：`e2e/round11.spec.ts` 19 通过、1 fixme（跳过）。

## 内核词表补进语言插件（D387）
- `zh-CN.json`、`ja-JP.json` 各补 305 条（303 条 `kernel.*`、`permission.resourcesAll`、`link.openFailed`）。中文取自 `round11-shell-done.md` 的表（表里的 `\|` 还原成 `|`），表里没有的两条自己译：`permission.resourcesAll`＝读取本工作区所有内容的名称、类型和位置（不含正文）；`link.openFailed`＝系统无法打开该链接：{reason}。日语逐条自译，没有母语者审阅。`lang-check` 通过（键集合与占位符与 `en-US.ts` 一致）。
- `e2e/round11.spec.ts` 加断言：中文下活动栏“工作区配置”“运行记录”“资源”；日语下“ワークスペース設定”“実行記録”“リソース”；命令面板里内核命令“打开审计/監査ログを開く”，审计页的操作名“新建资源/リソースを作成”（都是内核词表）。**没有**做“内核错误文字”的界面断言：我试了两种触发（空名称、清除后保存已被永久删除的笔记），前者外壳不发内核错误，后者按钮/流程卡住（两次尝试都超时），已放弃，改成上面的命令/审计词条。
- 结果：`round11.spec.ts` **20 通过、1 fixme**（欢迎页切语言，外壳）；`workbench.spec.ts`（假数据）23 通过、1 跳过（原本就跳过）。假数据截图跑完有 9 张像素变化，我逐个看了：差别是演示数据里相对“现在”的日期/时间（例如 11/16 18:31 → 11/17 06:01），不是文字；没有更新基准，已 `git checkout -- docs/screenshots`。
- `pnpm test`：546 通过，**1 个失败不是我的**：`src/workbench/i18n/kernel-texts.test.ts` “has words for every error reason the kernel gives”——en-US 缺内核原因 `badDropAnswer` 的文字（合并进来的协调分支上的外壳/内核问题）。`pnpm lint`、`pnpm typecheck` 通过。
