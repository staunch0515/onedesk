# 第十一轮：阶段 5 第一部分——语言插件、网址、提示词、笔记阅读态、欢迎页（协调会话定，2026-11-17）

用户要求尽快做到阶段 5，所以阶段 4 剩下的（多窗口、多工作区）排到阶段 5 之后，与阶段 5 交叉（`dev-plan.md` 允许）。
依据：`dev-plan.md` 阶段 5；`docs/requirements.md` A 节“内置插件”、I.1（语言）；`kernel-design.md` §7.2、§7.5（`ui`）、§9.1（`page:` 目标）、§11。沿用前十轮的全部约定和共同规则（`round4-plan.md`–`round10-plan.md`、`coordinator-handover.md` §3–§5）。决定 D378–D383 见 `docs/decisions.md`。
本文件里的名字**定死**；协议类型由内核会话按这里的名字“只增”加进 `crates/protocol`（并 `pnpm gen:types`），外壳先按可选字段写。

## 1. 做完是什么样

- 界面语言来自语言插件：装着并启用中文、日语两个语言插件时，工作区配置里的“界面语言”可选英语、中文、日语，切换立即生效并记住；停用某个语言插件后它从选项里消失，正在用它的界面回到英语；外壳自带完整的英语，任何时候不出现空白或键名。
- 网址插件：新建一条网址，点“打开”用系统浏览器打开（只允许 http、https、mailto）。
- 提示词插件：正文里写 `{{名字}}`，页面自动出现对应的参数输入框；点“复制”把填好参数的文字放进剪贴板。
- 笔记有阅读态：按 Markdown 显示（标题、列表、代码、链接、`[[引用]]`），可在编辑与阅读之间切换。
- 第一次打开（没有任何标签页）时显示欢迎页，上面有“新建笔记 / 网址 / 提示词 / HTTP 请求”的入口。

## 2. 范围（D378）

**做**：语言插件机制与中、日两个语言插件；宿主 `ui.openExternal`；文字节点的 Markdown；启动页；内置插件 `org.onedesk.link`、`org.onedesk.prompt`、`org.onedesk.welcome`，笔记的阅读态；清单 `legacyKinds`（本轮只校验并保存，接管在下一轮）。
**不做（下一轮）**：综合、集合；第一版旧库升级；HTTP 插件的补全；多窗口、多工作区；第十轮隐藏的入口。

## 3. 语言插件（D379，I.1、§11）

- 清单：`contributes.languages: [ { "locale": "zh-CN", "name": "简体中文", "shell": "shell/zh-CN.json" } ]`。`locale` 是 BCP 47（字母、数字、`-`，最长 35）；`name` 是这门语言自己的写法（原样显示，不是文字键）；`shell` 是包内的 JSON 文件：一层的 `{ "键": "文字" }`，值都是字符串，文件最大 1 MB。未知字段、路径逃出包、同一插件里 `locale` 重复 → 清单不加载（原因 `badLanguages`）。
- 内核方法：`i18n.languages` → `LanguageInfo[]`（`{ locale, name, plugin? }`）：第一项固定是 `{ locale: "en-US", name: "English" }`（外壳自带，没有 `plugin`），其后是本工作区已启用插件提供的语言，按 `locale` 排序；两个插件给同一个 `locale` 时取插件 id 靠前的。`i18n.shell { locale }` → `{ locale, texts }`（`texts` 是那份 JSON；`en-US` 或没有这门语言 → 空表）。主题 `languages`：可选的语言变了（启用、停用、安装、移除、切换版本）时发。读语言文件不激活插件。
- 选择：工作区配置参数 `ui.language`（值是 `locale`；内核列入 `params.known`，类型文字）。没设或设的语言不可用 → 英语。
- 外壳：启动时取 `i18n.languages` 和 `ui.language`；文字 = 自带的英语 + 所选语言的 `texts` 覆盖（缺的键回退英语）；语言选择器（状态栏和工作区配置页的“界面语言”）列出 `i18n.languages`，选了就写 `ui.language` 并立即生效；收到 `languages` 主题时刷新，所选语言消失则回到英语。现有 URL 参数 `lang` 仍可覆盖（验收和测试用）。日期、数字、排序用当前 `locale`。假数据模式没有内核：直接从 `plugins/org.onedesk.lang.zh-cn/shell/zh-CN.json`、`plugins/org.onedesk.lang.ja-jp/shell/ja-JP.json` 导入（外壳里不再保留 `zh-CN.ts`，中文只有语言插件这一份）。
- 语言插件没有代码要跑：`main.js` 可以是空的 `export default {}`（若现有校验要求 `main`）。

## 4. 宿主与视图的三处补充（D380–D382）

- **`ctx.host.ui.openExternal(url)`**（§7.5）：只允许 `http:`、`https:`、`mailto:`，否则 `invalid/badUrl`；最长 2048。可在运行和页面事件里调用（都是用户刚点了按钮）；渲染、事件订阅、`migrate`、树处理函数里 → `denied`（沿用现有“不在允许的上下文”的原因码）。内核发 `ui` 主题的效果 `{ type: "openExternal", url }`（`CommandEffect` 只增一种）；审计 `ui.openExternal`（对象是主机名，不记路径）。外壳收到后：桌面版交给主进程用系统默认浏览器打开（主进程再校验一次协议），浏览器里用新标签页打开。
- **文字节点的 Markdown**：视图节点 `text` 只增 `format: "plain" | "markdown"`（缺省 `plain`）。外壳用 `markdown-it`（D381，新依赖，MIT）渲染，关闭原始 HTML；链接只留 `http`、`https`、`mailto`，点击走与 `openExternal` 相同的打开方式；`[[名称]]` 显示成可点的引用（按已有的引用解析，点开对应资源；解析不到显示为失效样式）；图片不加载（显示替代文字）。样式放 `src/design`，只用 token。
- **启动页**：清单页面声明只增 `"startup": true`（只能用在不属于任何类型的独立页面上，一个插件最多一个）。`workspace.info` 只增 `startupPages: string[]`（已启用插件的启动页目标 `page:<插件id>/<页面id>`，按插件 id 排序）。外壳：这个客户端没有任何恢复出来的标签页时打开第一个；用户关掉后不再自动打开，直到又一次“没有任何标签页的启动”。

## 5. 内置插件（插件与测试会话）

写法照现有内置插件（`plugins/org.onedesk.note/`、`plugins/org.onedesk.http/`）；都有英、中、日三份语言文件（功能插件自带页面文字）和 vitest（假 host）。
- `org.onedesk.lang.zh-cn`、`org.onedesk.lang.ja-jp`：§3。中文的 `shell/zh-CN.json` 由 `src/workbench/i18n/zh-CN.ts` 转出（键和值原样，一条不少）；日语的 `shell/ja-JP.json` 键与英语（`en-US.ts`）完全一致，逐条翻译。附一个检查（放 `scripts/check-*.mjs` 或 vitest）：两份 JSON 的键集合与 `en-US.ts` 相同，占位符（`{name}` 之类）一致。
- `org.onedesk.link`：类型 `link`（树 `resources`；字段 `url` 文字、`profile` 文字——浏览器配置文件，只留字段）；页面一个表单；动作 `open`（运行，默认动作）→ `ctx.host.ui.openExternal(url)`，输出 `link`；`url` 为空或协议不允许时报插件自己的错误文字。`legacyKinds: ["link"]`。
- `org.onedesk.prompt`：类型 `prompt`（字段 `text` 长文本）；页面 `recompute: true`：从正文里找 `{{名字}}`（名字：字母、数字、`_`、`-`、中文，最长 40；`{{secret:…}}` 之类带冒号的不算），每个出一个 `param: true` 的输入框；动作 `copy`（页面事件）：用 `ctx.params` 代入（没填的留原样），`ctx.host.ui.copy(文字)`，提示“已复制”；动作 `preview`（运行，输出文字）显示代入后的结果。`legacyKinds: ["prompt"]`。占位符语法是插件自己的（规则 5）。
- `org.onedesk.note`：页面加一个 `event` 动作 `toggle`（“阅读 / 编辑”），阅读态渲染 `{ type: "text", format: "markdown", text }`（用未保存的草稿），状态记在页面参数或页面状态里（照现有机制，写明用的哪种）；`legacyKinds: ["note"]`。
- `org.onedesk.http`：只加 `legacyKinds: ["http-request"]`。
- `org.onedesk.welcome`：独立页面 `welcome`（`startup: true`）：一段 Markdown 的介绍，和四个入口（link 节点，目标 `new:org.onedesk.note:note` 等；对应插件没启用时不显示那一项——用 `ctx.host.plugins` 以外的办法：页面渲染时按宿主给的信息判断，若没有现成的接口就全部显示，并写进交接文件）。

## 6. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3 的清单、方法、主题、`ui.language`；§4 的 `openExternal`、`text.format`、`startup` 与 `startupPages`；清单 `legacyKinds`（字符串数组，各项是旧的短类型名；只校验、保存、出现在 `plugin.get` 的详情里 `legacyKinds: string[]`，不接管） | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS |
| 外壳（Sonnet） | §3 外壳；§4 的打开外部链接（含主进程）、Markdown 渲染、启动页；新增文字（英语） | 同前几轮，另加 `package.json`/`pnpm-lock.yaml`（只为 `markdown-it`） |
| 插件与测试（Sonnet） | 第一阶段：§5 全部。第二阶段（合并后）：`e2e/round11.spec.ts` | `plugins/**`、`e2e/**`、`scripts/check-*.mjs` |

外壳删除 `src/workbench/i18n/zh-CN.ts` 要等合并后（那时语言插件的 JSON 才在同一棵树里）：第一阶段先做机制，保留 `zh-CN.ts`；合并后对齐时改为导入 JSON 并删掉它。

## 7. 完成标准

- 内核必须有的测试：`contributes.languages` 的每种拒绝；`i18n.languages` 的顺序、同 `locale` 取靠前的插件、停用/启用/移除后的变化与主题；`i18n.shell` 的内容、未知语言与 `en-US` 给空表、文件过大或不是一层字符串表时的处理、不激活插件；`ui.language` 在 `params.known`。`openExternal`：允许与拒绝的协议、长度、各上下文、主题效果、审计不含路径。`text.format` 的校验。`startup` 的校验（只能独立页面、最多一个）、`startupPages` 随启用停用变化。`legacyKinds` 的校验与详情。全部用临时目录。
- 外壳必须有的测试：文字的覆盖与回退（缺键、语言消失）；语言选择写 `ui.language`；Markdown 渲染不输出原始 HTML、链接协议过滤、`[[引用]]`；启动页只在没有标签页时打开。假数据模式 `workbench.spec.ts` 全过、截图不变（中文截图若有，文字不得变）。
- 插件：每个插件的 vitest；语言文件键一致性检查。
- `e2e/round11.spec.ts` 连真内核跑通。交接文件 `round11-kernel-done.md`、`round11-shell-done.md`、`round11-tests-done.md`。
