# phase2/shell：应用外壳与页面

实际分支：`worktree-agent-a16d78ede4ece62d7`（按要求不切换分支，合并时按 `phase2/shell` 处理）。
worktree：`/Users/zhongpingxue/onedesk/repo/.claude/worktrees/agent-a16d78ede4ece62d7`

## 完成了什么

- **组合根** `src/shell/bootstrap.ts`（外壳中唯一 import `platform/` 的文件）：检测 `window.__TAURI_INTERNALS__` 选择平台（动态 import，浏览器包里不带 Tauri 适配）→ `app.status()`，有 `migrationError` 只显示阻断页（原因、数据目录、数据库路径、结构版本、快照说明、处理方式）→ `plugins.scan()` 转成 `PluginSource`（扫描 `error` 原样传入；清单 JSON 解析失败记为 error；入口源码经 Blob URL `import()` 取 `default`）+ `builtinPluginSources()` → `createKernel` → `plugins.load`。浏览器预览首次启动写入 4 个示例资源（每种 kind 一个，分“工作”“个人”两组）和 1 个集合，只写一次（prefs `shell.previewSeeded`）。StrictMode 下启动只执行一次（两个内核不会同时写同一个库）。
- **布局**：AppShell；左侧菜单按 group 分组、可折叠、dnd-kit 拖动排序（指针 + 键盘，中文读屏提示），组内顺序、分组顺序（分组“…”菜单里上移/下移）和折叠状态存 `kernel.prefs`（键 `shell.menu`）；停用插件的资源不出现（D15）；body 不合法的资源灰色 + 警示图标（tooltip 说明）；菜单底部：全部资源、集合、插件、设置。顶部：工作区名、全局搜索框（回车进入搜索结果页）、“命令面板 ⌘K”、“新建”（⌘N）。
- **资源页**：PageHeader（kind 图标、名称、kind 徽标、分组、标签、未保存徽标、描述）+ 操作区（该 kind 的动作，默认动作为最后的主按钮；运行中按钮显示进度并禁用；“…”菜单里删除）+ Tabs（`registry.viewsFor(kind)`，最后“编辑”）。插件视图经 `kernel.views.render` → 视图树渲染器（form 只读字段列表、table、text plain/markdown/code、link 经平台 `openExternal`）。结果面板：运行中（进度条 + 取消）、成功（text/table/link/file/none 的消息与内容）、失败（红色文字：原因 + 处理方式）、已取消；可关闭。动作有输入时弹对话框（`actions.inputFields`，提示词参数带默认值）。
- **编辑视图**：通用字段（名称、分组、标签、描述、可见性、AI 可见）+ kind 字段（text/longtext/number/url/boolean/select/reference/parameter 参数列表编辑器）。草稿在资源页里，切换标签不丢；本地校验 + `kernel.resources.validate` + 保存时内核返回的字段错误都显示在字段下；保存失败把焦点移到第一个错误字段；乐观并发冲突显示“资源已在别处修改 / 重新加载”；有未保存修改时离开（菜单、搜索、命令面板任何跳转）弹确认，关窗口有 beforeunload。编辑标签页的标题区操作变为“还原 / 保存（⌘S）”。
- **插件停用的资源**：打开时显示“插件已停用”提示条（含“启用插件”按钮）和只读数据；找不到插件的显示“找不到提供…的插件”。
- **新建资源**：对话框（kind 只列已启用插件的、名称、分组 + 该 kind 的必填字段，这样 body 创建时就合法）→ 创建后进入“编辑”标签页。删除资源要确认。
- **全部资源**：表格（名称、类型、分组、标签、更新时间（表格数字））；停用插件的资源灰色、类型列写“HTTP 请求（已停用）”；按类型、标签筛选，空状态区分“没有资源 / 没有符合筛选的”。**搜索结果页**同一表格。**集合**：列表 + 新建（按标签或类型，值从已有标签/已启用类型中选）+ 集合内资源表格 + 删除。
- **插件页**：每个插件一行（图标、名称与描述、版本、来源、资源数、状态开关）；停用的灰色并显示“保留了 N 个资源”；激活失败显示原因；“设置”抽屉按 `manifest.settings` 生成表单；外部插件可卸载（询问是否同时删除它声明且仍存在的密钥）；已卸载列表可“重新安装”（D90/D114）；加载失败列表（来源、位置、原因）。
- **设置页**：外观（主题：跟随系统/浅色/深色；密度：舒适/紧凑，存 prefs `shell.theme` / `shell.density`，启动时先读再渲染，无闪烁）；数据（数据目录、数据库、结构版本、快照列表（UTC 文件名转本地时间）、导出全部数据（选文件夹 → 写入 5 个文件 → 吐司显示路径）、导入（选文件夹 → 计划 → 无冲突直接应用，有冲突时表格逐条选择或“全部覆盖/全部跳过” → 应用 → 结果吐司））；密钥（列表、添加、修改值、删除；值输入框 password 类型，永不回显）；插件加载错误。
- **命令面板（⌘K / Ctrl+K）**：资源（`kernel.search`，正文命中的也保留）、“搜索 X 的全部结果”、当前资源的动作（默认动作标 ⌘↵）、新建（总入口 + 每个 kind）、页面跳转、插件菜单项（全局动作，结果用吐司）、切换主题、切换密度。快捷键：⌘N 新建、⌘↵ 运行默认动作、⌘S 保存、Esc 关闭（Radix）。
- `notify` 事件 → 吐司；每个页面有加载中、空状态（一句话下一步）、错误状态（原因 + 处理方式 + 重试）；页面渲染异常由错误边界接住（重试）。
- 所有界面文字在 `src/shell/i18n/zh-CN.ts`，经 `t()`（`{{name}}` 占位符）取用。
- 性能：菜单第一次有数据时输出 `[onedesk] menu-ready <ms>`（`performance.now()`）。
- `src/main.tsx`：渲染外壳；`?gallery`（可加 `&theme=dark&density=compact`）显示组件展示页。

## 改了哪些文件

- 新增 `src/shell/`：`bootstrap.ts`、`services.ts`、`sample-data.ts`、`start.tsx`、`app.tsx`、`shell-context.ts`、`hooks.ts`、`format.ts`、`menu-model.ts`、`sidebar-menu.tsx`、`top-bar.tsx`、`palette.tsx`、`new-resource-dialog.tsx`、`schema-form.ts`、`schema-fields.tsx`、`edit-view.tsx`、`view-tree.tsx`、`action-ui.tsx`、`resource-table.tsx`、`pages/{resource,all-resources,search,collections,plugins,settings}-page.tsx`、`i18n/{zh-CN,index}.ts`
- 测试：`src/shell/{menu-model,schema-form,bootstrap}.test.ts`、`view-tree.test.tsx`、`integration.test.tsx`
- 修改：`src/main.tsx`
- 本文件

没有新增依赖，没有改冻结接口、`package.json`、`scripts/`。第二轮按主会话许可改了 `src/design/**`（新增 TextLink、TextBlock、KeyValueList 及测试，Sidebar header 对齐，展示页一节，`index.ts` 导出），新增 `src/shell/{kind-cache,delete-resource}.ts`、`review-fixes.test.tsx`。

## 测试与检查结果

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过（架构检查：内核 29 个文件、内置插件 4 个；界面规范检查通过；kind `link` 同名警告是原有的） |
| `pnpm test` | 33 个文件、413 个测试全过 |
| `pnpm coverage` | 413 全过；语句 98.19%、分支 92.63%、函数 98.6%、行 99.08%（覆盖率只统计内核和 plugin-api） |
| `pnpm test:rust` / `clippy` / `e2e` | 未运行（没有改 Rust；`e2e/` 不在本任务允许范围内，仓库里也还没有 Playwright 配置） |

外壳测试：
- `menu-model.test.ts`：分组（去首尾空格、未分组在最后）、默认排序、保存的顺序优先、拖动移动、分组上移下移、折叠、坏数据回退。
- `schema-form.test.ts`：每种字段类型的初始值/默认值、转回 body（空值省略、数字、保留 schema 外的键、参数行去空）、动作输入、必填/数字/网址/选项/参数名/重复参数校验。
- `view-tree.test.tsx`（jsdom）：form/table/text（plain 保留换行、markdown、code、tone）/link（经宿主打开，不渲染 `<a>`）/空视图。
- `bootstrap.test.ts`：外部插件来源（JSON 解析、扫描错误原样传入、缺入口）、预览示例数据只写一次且全部合法。
- `integration.test.tsx`（真实内核 + 四个内置插件）：网址创建 → 视图 → 打开；笔记 markdown 视图；提示词参数编辑器的值 → 输入表单 → 复制（默认值回退）；HTTP 发送 → 响应视图，网络失败是失败结果；整个 App：菜单列出资源、打开资源看到“详情/编辑”标签、点“打开”看到结果、停用 HTTP 插件菜单项消失且数据保留、启用后恢复；body 不合法时菜单灰色 + 警示图标、资源页提示字段；编辑的字段级错误不写库、未保存时离开弹确认。

注意：机器负载高时，coverage 插桩下整个 App 的测试会超过默认 5 秒，已给这一组设 30 秒超时和 10 秒的 `asyncUtilTimeout`。

## 浏览器预览（`pnpm preview:web`，端口 1421，Playwright 临时脚本，未提交）

1440×900 与 1280×800，浅色和深色各走一遍，截图逐张看过。验收 1–5：
1. 启动后菜单按“个人 / 工作”分组列出 4 个示例资源，底部全部资源/集合/插件/设置；控制台 `[onedesk] menu-ready` 1.8–7 秒（vite 开发模式首编译 + 机器负载，不代表打包后的冷启动）。控制台无错误。
2. 新建网址（⌘N → 填名称、分组、网址 → 创建 → 进入编辑页）；网址“打开”弹出 example.com；笔记 markdown 阅读态；提示词“复制”弹参数对话框 → 剪贴板内容正确；HTTP“发送”运行中显示进度条 + 取消，完成后结果面板 + 响应视图（httpbin 真实请求）；编辑网址为 `ftp://bad` 保存 → 字段下红字 + 顶部“保存失败”，焦点到出错字段；⌘S 保存成功吐司。
3. 插件页关掉“HTTP 请求” → 菜单项消失，插件行灰色“保留了 1 个资源”，全部资源中该行灰色、类型“HTTP 请求（已停用）”，打开后“插件已停用”提示条 + 只读数据；重新启用后恢复。
4. 搜索框回车：按名称“周报”、标签“接口”、正文“httpbin”都能找到；无结果有一句话空状态。⌘K：资源、当前资源动作（默认动作标 ⌘↵）、新建、页面、外观；输入“读书”回车打开笔记；输入“深色”切换主题；“紧凑”切换密度；刷新后主题密度保持。
5. 浅色/深色主要页面检查过对比度和对齐（截图见下方），未见明显问题。另：键盘拖动排序（空格拿起 → ↓ → 空格放下）生效且刷新后保持；分组折叠刷新后保持；⌘↵ 运行默认动作。

截图（临时，未提交到 docs/screenshots）：`/private/tmp/claude-501/-Users-zhongpingxue--claude-spares-spare-nqTuln/5bbb3006-62cc-4b97-a63b-3de5900b44f6/scratchpad/shots/`（`light-*`、`dark-*`、`light-k*`、`tauri-*`）。

截图中发现并修正的问题：
- 命令面板用 `filter=false` 时，结果变化后 cmdk 不再选中第一项，回车无效 → 改为让 cmdk 过滤，内核结果带上查询词作为关键词（正文命中不会被二次过滤掉）；空查询结果和当前资源提前加载，打开时第一项稳定。
- 停用插件的资源类型显示成 `http-request（已停…`、资源页徽标“未知类型” → 用插件名显示“HTTP 请求（已停用）”，提示条文案改为插件名。
- 插件表名称/描述两行挤在行高里 → 一行（名称 + 灰色描述截断）。
- 搜索框占位文字被截断、原生 search 清除按钮是蓝色 → 文案缩短，改为 `type=text role=searchbox`。
- “⌘ 命令 ⌘K”重复 → “命令面板 ⌘K”。
- 编辑页保存按钮只在表单底部、保存失败后页面停在底部 → 编辑标签页的标题区换成“还原 / 保存”，失败时焦点移到第一个错误字段；结果面板不在编辑标签页显示。
- 全部资源的计数与筛选控件基线不齐 → 计数移到标题徽标。
- 浏览器预览中“外部插件放在（浏览器预览）/plugins/…”无意义 → 只在桌面应用显示。

## 真实应用（`pnpm tauri dev`，1420 被其他会话占用，用 1430）

首次编译约 8.5 分钟后 `target/debug/onedesk` 运行。本机没有给辅助功能权限，无法用 System Events 模拟键盘鼠标，所以用一个**临时**脚本（`src/tauri-selfcheck.tmp.ts` + `main.tsx` 里一行开发期 import，均已删除、未提交）在 WebView 内按真实界面点按钮、填表单，结果 POST 到本机临时监听，窗口截图用 `screencapture -l <窗口号>`（只截 OneDesk 窗口）。另在 `~/Library/Application Support/onedesk/plugins/shellcheck/` 放了一个临时外部插件（已删除）。看到的结果：
- 菜单可见（空库：只有底部四项，空状态提示）；四个内置插件和外部插件写入 `plugins` 表（外部插件默认停用，D54）。
- 通过“新建”对话框和命令面板“新建提示词/新建HTTP 请求”创建了 3 个资源，`sqlite3 -readonly ~/Library/Application Support/onedesk/onedesk.db` 查到 `link 联调网址`、`prompt 联调提示词`、`http-request 联调请求`。
- `opener`：网址“打开”成功（系统浏览器打开 example.com）。
- 剪贴板：提示词“复制”后 `pbpaste` 得到“OneDesk 联调剪贴板”。
- HTTP（`@tauri-apps/plugin-http`，插件声明 `*`）：`httpbin.org/redirect-to?url=…/get` 返回 200，跟随了重定向，User-Agent `tauri-plugin-http/2.9.0`。
- **D110**：外部插件只声明 `httpbin.org`：重定向到 `httpbin.org/get` → 成功、status 200；重定向到 `example.com` → 失败“重定向到未声明的地址 example.com，已拒绝”。说明 Tauri 下 `maxRedirections: 0` 会原样返回 3xx，宿主逐跳检查生效。
- 外部插件经 Blob URL `import()` 加载成功（CSP `script-src 'self' blob:` 可用），启用后命令面板出现它的菜单项，运行结果用吐司显示；`notify` → 吐司正常。
- 停用/启用 HTTP 请求插件：菜单项消失/恢复。
- 设置页：数据目录 `/Users/zhongpingxue/Library/Application Support/onedesk`、结构版本 1、3 份快照，UTC 文件名正确转成本地时间（`onedesk-20261114-103557.db` → 2026-11-14 19:35）。
- **没有验证**：导出/导入的文件夹选择（原生对话框无法在没有辅助功能权限时操作）；密钥写入真实钥匙串（避免写用户钥匙串）。
- 结束后已停止 tauri dev、1430 的 vite、1421 的预览服务器和临时监听；临时插件文件夹已删除。

**留在真实库里的数据**：3 个联调资源（未分组）和 `plugins` 表中 `org.example.shellcheck` 一行（已启用，但文件夹已删，下次启动不会加载）。需要清理的话在应用里删除这 3 个资源；插件行无害。

## 还缺什么

- 导出/导入在真实应用中的手动验证（选文件夹）；密钥在钥匙串中的增删改。
- `docs/screenshots/` 的验收截图和 `e2e/`：不在本任务允许修改的范围，建议由测试会话把上面的临时脚本整理成 `e2e/` 用例并生成截图。
- 停用插件的资源：只读数据用记住的字段名（`shell.kindCache`）；从未在启用状态下见过的 kind（例如导入的未知类型）仍显示原始键名，并有一句说明。
- 菜单只支持组内拖动；跨组移动通过编辑“分组”字段完成；分组排序用“…”菜单上移/下移（没做分组拖动）。
- 启动包里仍有约 1.2 MB 的 design chunk（主要是 lucide 全部图标 + react-markdown），见“性能”。

## 评审修复（第二轮，主会话转来的独立审查）

提交：`a7f5d9d`（修复 + 设计系统组件）、`4255443`（插件页列宽）、`37a79a3`（按需加载）。

| # | 问题 | 修复 | 测试 |
|---|---|---|---|
| 阻断 1 | 在资源页启用插件后显示“有未保存的修改”并拦截导航 | `useEditDraft` 只在用户真的编辑过时算未保存（`edited` 状态）；资源、版本或 schema（kind 注册）变化而没有编辑时重置草稿 | `review-fixes.test.tsx`：停用 → 打开资源 → 点“启用插件” → 没有未保存徽标，导航不弹确认；只有真正改过才算未保存，改回原值不算 |
| 阻断 2 | ⌘K 面板按正文或标签搜不到资源（cmdk 只在挂载时读 keywords） | 内核结果带上找到它们的查询词作为关键词，**并把查询词放进 item id**，每个新结果集都重新挂载；“搜索 X 的全部结果”单独一组、和结果一起挂载，排在资源后面（回车打开资源） | 正文词“季度目标”、标签词“例会”都能在面板中找到资源、不显示不相关的资源，回车打开 |
| 3 | 灰色行名称仍是全对比度 | 资源表名称用纯文本继承行颜色；插件表停用行名称用 `subtle` | 停用插件的资源名称没有 `od-text` 类，行是 `--muted` |
| 4 | 侧栏删除没有反馈 | 抽出 `useDeleteResource`（确认 → 删除 → 成功/失败吐司 → 如在该资源页则离开），资源页和侧栏共用 | 成功吐司；删除失败显示“无法删除…”和原因 |
| 5 | 侧栏加载错误 | `ErrorState` inline + 重试 | 读取失败显示“菜单加载失败”，重试后恢复 |
| 6 | ⌘K 叠在其他对话框上 | 面板开着时 ⌘K 关闭它；有其他对话框时忽略 | ⌘N 打开新建后 ⌘K 不打开面板；面板开关 |
| 7 | 面板运行动作不检查运行中 | 当前资源有动作在运行时，面板里它的动作禁用（描述显示“正在运行”），选择时再检查一次 | HTTP 发送进行中，面板“发送”项 `aria-disabled` |
| 8 | HTTP 响应重复显示 | kind 有插件视图时结果面板只显示状态行（`output.message`，没有则输出第一行/行数/链接/文件名），“显示完整输出”展开 | compact 面板只显示 “200 OK”，展开后看到完整输出；摘要规则单测 |
| 9 | 插件页 1280 宽描述被截断 | 操作列 sm、改为图标按钮（带工具提示）；来源列 xs 纯文本；没有 `manifest.settings` 时不显示设置按钮 | 只有 HTTP 请求有设置按钮；1280 宽截图中描述完整 |
| 10 | 文案集中 | `useShell` 错误信息、默认动作的“（⌘↵）”后缀进 i18n | — |
| 11 | 长行被截断（User-Agent） | 新组件 `TextBlock`：`white-space: pre-wrap; overflow-wrap: anywhere`；视图树 text 节点和动作输出都用它 | 400 字符的长行完整在 `pre` 中；浏览器里 `pre` 的 `scrollWidth - clientWidth` 为 0 |

设计系统（这次允许改 `src/design/**`）：
- `TextLink`（行内链接，`onOpen` 代替导航，可带外链图标）、`TextBlock`（保留换行的正文/代码块，长行换行，tone）、`KeyValueList`（只读键值，`columns`/`stacked`，原始键名可用等宽）、`Sidebar headerJustify="between"`。`Select` 本来就支持 `aria-label`（我第一次看漏了），补了测试。
- 测试：`src/design/components/text-components.test.tsx`；展示页新增“文本块、链接、键值列表”一节。只引用 token，组件内无中文；check-ui 通过（`font-family` 只用 `.od-mono` 和 `font: inherit`）。
- 外壳使用：视图树 link → `TextLink`；form 节点 → `KeyValueList`；text/code → `TextBlock`；停用插件资源的只读数据 → `KeyValueList`；侧栏头部“OneDesk + 新建”两端对齐。

停用插件资源的字段名：外壳在启动和每次 `plugin.changed` 时把已注册 kind 的名称、图标、字段标签记到 prefs `shell.kindCache`；停用后只读视图按 schema 顺序用这些标签，没有记录时显示原始键名（等宽）并说明“插件不可用，无法读取字段名称，以下显示原始键名。”

浏览器预览复查（1280×800，浅色和深色，`pnpm preview:web`）：HTTP 结果面板只显示“200 · 784 ms”+“显示完整输出”，展开后 User-Agent 长行换行、无横向溢出；⌘K 输入正文词“httpbin”和标签词“阅读”都找到资源并选中，回车打开；⌘N 后 ⌘K 不叠加（对话框数 1）；停用“网址”后全部资源中名称灰色、资源页只读数据显示“网址”标签，点“启用插件”后无未保存徽标、导航不弹确认；侧栏删除“读书笔记”后有“已删除”吐司；插件页 1280 宽描述完整；展示页新组件浅/深色正常。控制台无错误。

## 性能（G.6：冷启动到看到菜单 < 2 秒）

生产构建：`pnpm build` → `pnpm exec vite preview --port 1451`，Playwright 读 `[onedesk] menu-ready`（`performance.now()`，从导航开始算）。“全新”= 每次新浏览器上下文（无缓存、空 localStorage，包含建库、迁移、写示例数据）；“已有数据”= 同一上下文刷新。**测量时机器负载很高（load average 56 → 313），数值偏大。**

| 版本 | 全新（5 次） | 已有数据（5 次） |
|---|---|---|
| 优化前（index 1.7 MB） | 2843, 2293, 1790, 1820, 2053 ms（中位 2053） | 847, 820, 883, 1323, 1218 ms（中位 883） |
| 优化后（按需加载，load 313） | 1946, 1544, 1783, 1559, 1645 ms（中位 1645） | 860, 511, 644, 586, 733 ms（中位 644） |

优化：组件展示页、集合/插件/设置/搜索页改为 `React.lazy` + `import()`（启动不需要）。分析：主包解析执行约 650–850 ms（负载下），sql.js wasm + 迁移约 250 ms，插件加载约 50 ms，其余是首次写示例数据和渲染。剩下的大头是 design chunk（约 1.2 MB，lucide 全部图标按名字解析 + react-markdown），需要设计会话决定是否改为按需图标/懒加载 Markdown。真实应用不走 sql.js、不写示例数据，更接近“已有数据”一行。

## 测试与检查结果（第二轮）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 最后一次：35 个文件、430 个测试全过。此前一次内核“1 万条资源搜索 < 200ms”在 load average 300–430 时失败（最好的一次 246 ms，D93 已说明高负载会失败，与本次改动无关），重跑通过 |

## 决定（请主会话汇总到 decisions.md）

1. 路由：`all | resource(id, tab?) | collections(id?) | plugins | settings | search(query)`，启动进入“全部资源”。
2. prefs 键：`shell.menu`（`{groupOrder, itemOrder, collapsed}`）、`shell.theme`、`shell.density`、`shell.previewSeeded`、`shell.kindCache`（kind → 名称、图标、字段标签）。
3. 菜单默认顺序：分组按名字（zh-CN 排序）、未分组最后；组内按名字；保存过顺序的在前，新资源排在后面。分组名去首尾空格。
4. 新建对话框包含该 kind 的必填字段（否则 `create` 会因 body 不合法被拒）。
5. 编辑保存时 body 以原 body 为基础只替换 schema 字段（schema 外的键保留）；空值从 body 中删除；标签用中英文逗号分隔。
6. ⌘S 只在有修改（或上次保存失败）时保存，避免无意义的版本号增加。
7. 全局动作（插件菜单项）的结果用吐司显示；资源动作的结果显示在资源页结果面板，编辑标签页不显示结果面板；kind 有插件视图时结果面板只显示状态行，可展开完整输出。
8. 命令面板交给 cmdk 过滤；内核结果以查询词作关键词并放进 item id（每个结果集重新挂载）。
9. 浏览器预览模式示例数据：4 个资源（工作：网址、HTTP 请求；个人：提示词、笔记）+ 集合“常用接口”（标签“接口”），只在资源表为空且从未写过时写入。
10. 启动只执行一次 `boot()`（StrictMode 双调用不会建两个内核）；失败页“重试”才重新启动。
11. 卸载插件时只列出“它声明、没有其他插件声明、且钥匙串中确实存在”的密钥供勾选删除。
12. 草稿只有用户编辑过才算未保存；没有编辑时随资源版本和 schema 变化自动更新。
13. ⌘K：面板开着时关闭面板；有其他对话框时不打开。资源有动作在运行时，该资源的动作（页面按钮、⌘↵、面板）都不可再运行。
14. 启动不需要的页面（集合、插件、设置、搜索、组件展示页）按需加载。

## 设计系统缺口

已在第二轮补上：TextLink、TextBlock、KeyValueList、Sidebar header 两端对齐（Select 原本就支持 `aria-label`）。仍未做：
- 可输入的组合框（Combobox）：按主会话要求不做；分组和标签仍用普通输入框，已有分组写在说明文字里。
- 建议：PageHeader 可选吸顶（长表单时保存按钮可见）；Table 单元格允许换行的选项；图标按需加载以缩小启动包。

## 需要谁确认 / 问题

- **主会话**：分支名是 `worktree-agent-a16d78ede4ece62d7`，不是 `phase2/shell`。
- **主会话**：上面“决定”写进 decisions.md。
- **主会话/测试会话**：`e2e/` 与 `docs/screenshots/` 不在本任务允许范围，验收截图需要另行生成。
- **主会话/设计会话**：design chunk 约 1.2 MB（lucide 全量），是否改为按需图标。
