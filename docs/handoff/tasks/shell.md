# 任务：应用外壳与页面（分支 phase2/shell）

**目标**：用内核 API 和设计系统组件拼出完整可用的应用：菜单、资源页、通用视图、动作执行、集合、插件管理、设置（主题密度、导出导入、密钥、插件错误）、搜索、命令面板。浏览器预览模式和真实 Tauri 应用都能完整使用。

**允许修改**
- `src/shell/**`（含 `src/shell/i18n/zh-CN.ts`、`src/shell/bootstrap.ts`）
- `src/main.tsx`（接管：渲染外壳；设计展示页改为 `?gallery` 参数时显示）
- `docs/handoff/phase2-shell.md`

**只读依赖**：`src/kernel/**`（`createKernel`、`contracts.ts`、`testing/`）、`src/platform/**`、`src/design/**`（只能用这里的组件；缺组件写进交接文件，不在外壳里自己写样式）、`src/plugins/index.ts`、`src/plugin-api/**`、`docs/requirements.md`（B、D 节逐条满足）、`docs/decisions.md`。

**要点**
- `bootstrap.ts`（外壳中唯一 import `platform/` 的文件）：检测 Tauri（`window.__TAURI_INTERNALS__`）选择平台 → `app.status()`，有 `migrationError` 时只显示阻断错误页（原因 + 数据目录 + 备份说明）→ `plugins.scan()` 转成 `PluginSource`（`error` 原样传入；入口源码用 Blob URL `import()`，取 `default`）+ `builtinPluginSources()` → `createKernel` → `kernel.plugins.load`。浏览器预览模式首次启动写入少量示例资源（每种 kind 各一个，分两个分组），便于界面测试与截图。
- 布局：AppShell；左侧菜单（按 group 分组、可折叠、dnd-kit 拖动排序含键盘，顺序和折叠状态存 `kernel.prefs`；停用插件的资源不出现（D15）；body 不合法的资源灰色 + 警示图标）；菜单底部：全部资源、集合、插件、设置。顶部：全局搜索框（回车进入搜索结果页）、新建按钮、命令面板入口（显示 ⌘K）。
- 资源页：PageHeader（名称、kind 徽标、分组、标签）+ 操作区（该 kind 的动作，默认动作为主按钮，执行中显示进度并禁用，可取消）+ Tabs（`registry.viewsFor(kind)`，最后是“编辑”）。插件视图用 `kernel.views.render(key, resourceId)`，结果用视图树渲染器（form 只读字段列表、table、text plain/markdown/code、link（点击经 `ui.openExternal` 等价的平台能力打开））画出。“编辑”视图由 schema 生成表单：通用字段（名称、分组、标签、描述、可见性、AI 可见）+ kind 字段（text/longtext/number/url/boolean/select/reference（资源选择）/parameter（参数列表编辑器：增删行，名字/标签/默认值））；保存时显示字段级错误；有未保存修改时离开要确认。动作有输入时弹对话框（`actions.inputFields`）。结果面板：执行中（进度）、成功（按输出类型显示 text/table/link/file 内容/none 的消息）、失败（红色文字：原因 + 处理建议）、已取消。插件停用的资源打开时显示“插件已停用”提示条和只读数据。
- 新建资源：对话框（选 kind（只列已启用插件的 kind）、名称、分组）→ 创建后进入“编辑”标签页。删除资源要确认。
- 全部资源页：表格（名称、类型、分组、标签、更新时间（表格数字）），停用插件的资源灰色显示；按 kind/标签筛选。集合页：列表 + 新建集合（按标签或类型）+ 集合内资源表格。
- 插件页：每个插件一行（图标、名称、版本、来源、资源数、状态开关）；停用的灰色并显示“保留了 N 个资源”；设置表单按 `manifest.settings` 生成；外部插件可卸载（询问是否删除它声明的密钥）；加载失败列表（来源、位置、原因）。
- 设置页：外观（主题：跟随系统/浅色/深色；密度：舒适/紧凑，存 prefs）；数据（数据目录、schema 版本、快照列表；导出全部数据（选文件夹 → 写入 → 吐司显示路径）；导入（选文件夹 → 计划 → 有冲突时逐条或“全部覆盖/全部跳过”询问 → 应用 → 结果））；密钥（列表、添加、修改、删除，值输入框为密码类型，永不回显已存的值）。
- 搜索结果页与命令面板（⌘K / Ctrl+K）：资源（`kernel.search`）、当前资源的动作、页面跳转、新建资源、切换主题、切换密度、插件菜单项。其他快捷键：⌘N 新建、⌘↵ 运行默认动作、⌘S 保存编辑、Esc 关闭。所有操作可键盘完成。
- `notify` 事件 → 吐司。每个页面都有加载中、空状态（一句话下一步）、错误状态（原因 + 处理方式 + 重试）。
- 所有界面文字在 `i18n/zh-CN.ts`，通过 `t()` 取用，动词开头、简短。
- 性能：启动到菜单可见的耗时用 `performance.now()` 记录并输出到控制台（`[onedesk] menu-ready <ms>`），供界面测试读取。

**完成标准**
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过；外壳逻辑（视图树渲染器、schema 表单生成与校验、菜单分组排序）有 jsdom 测试；用真实内核（`createTestKernel` + `builtinPluginSources()`）做四个内置插件的集成测试（创建 → 打开视图 → 运行动作）。
- 在浏览器预览模式（`pnpm preview:web`）亲自走一遍验收 1–5：浅色和深色截图检查并修正问题。
- 用 `pnpm tauri dev` 启动真实应用，确认菜单可见、能新建资源（数据写入 `~/Library/Application Support/onedesk/onedesk.db`），在交接文件写出看到的结果。

**交付物**：分支上的提交 + `docs/handoff/phase2-shell.md`。

## 第一阶段合并后的补充（主会话）

- 先读 `docs/handoff/phase1-kernel.md`、`phase1-design.md`、`phase1-rust.md`、`phase1-plugins.md` 了解实际 API 与约定。设计组件清单与用法看 `src/design/index.ts` 和展示页 `src/design/gallery/`。
- 组合根（D92）：`createBrowserPlatform()` 是异步的；先 `app.status()`，有 `migrationError` 时不创建内核。浏览器预览用的 sql.js 在 `src/kernel/sqljs/`。
- 侧栏 NavItem 的行内菜单：把 DropdownMenu 的 `open` 传给 `actionsOpen`。
- 插件页需要支持“重新安装”（`kernel.plugins.uninstalled()` / `reinstall(id)`，D90/D114）。
- 时间：Rust 返回的快照/导出名是 UTC（D81），界面显示用本地时间。
- 真实 Tauri 联调时验证：HTTP 请求经 `@tauri-apps/plugin-http`（含 D110 的重定向行为）、`opener` 打开网址、剪贴板写入、导出/导入文件夹选择。把结果写进交接文件。`pnpm tauri dev` 若 1420 端口被占用，用 `pnpm tauri dev --config '{"build":{"devUrl":"http://localhost:1430","beforeDevCommand":"pnpm exec vite --port 1430 --strictPort"}}'`，结束后停掉进程。
- 停用插件的资源在菜单中隐藏、在“全部资源”和搜索结果中用 `--fg-inactive` 灰色显示（D15、D101）。
