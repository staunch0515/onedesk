# 决定记录

每条：编号、日期、决定、原因。只追加，不改写；推翻旧决定时新增一条并注明“取代 Dxx”。

## 第一个里程碑（2026-11-14，主会话）

### 运行方式与接口

- **D01 插件运行方式**：同一进程内的 TypeScript ES 模块。内置插件用静态 import；外部插件由 Rust 读取 `plugins/<dir>/` 下的 `manifest.json` 与入口文件 `index.js`，前端以 Blob URL 动态 import。两者都包装成 `PluginSource { origin, manifest, load() }`，走同一条加载路径。接口不依赖运行方式，将来可换成 Worker / 独立进程。
- **D02 视图树**：只用 `form`、`table`、`text`、`link` 四种节点。`render` 可返回单个节点或节点数组（数组 = 自上而下排列），不新增容器节点。`form` 节点在插件视图中为只读展示；可编辑表单只由宿主的通用“编辑”视图使用。
- **D03 校验**：清单、字段定义、视图树、动作输出都用 zod 校验（`src/plugin-api/schemas.ts`），清单本身是 JSON 文件。
- **D04 apiVersion**：只接受 `"1"`；其他值拒绝加载并记录原因。
- **D05 id 规则**：插件 id 为反向域名（如 `org.onedesk.link`）。kind id 全局唯一（如 `link`），重复注册拒绝。动作与视图在插件内用本地 id，全局键为 `插件id/本地id`；kind 的 `defaultAction`、`views` 写本地 id，解析到同一插件。
- **D06 动作适用的 kind**：接口摘要未说明动作如何关联 kind，动作增加可选字段 `kinds: string[]`。
- **D07 动态输入**：提示词的参数随资源变化。`action.input` 可为字段列表，或 `{ fromField: "<body 字段名>" }`，表示由资源 body 中该 `parameter` 字段生成输入表单。
- **D08 参数占位符**：全项目统一使用 `{{name}}`（名字限 `[A-Za-z_][A-Za-z0-9_]*`）。提示词插件提供占位符检查并有测试；不支持 `$name` / `:name`，出现时在编辑表单报错。
- **D09 系统能力**：接口摘要未列出“用系统浏览器打开”和“剪贴板”。放在 `ui` 下：`ui.openExternal(url)`、`ui.copyText(text)`，由宿主执行（不是插件直接操作界面）。
- **D10 资源访问范围**：插件经 `host.resources` 只能读写自己注册的 kind 的资源；外壳（shell）直接使用内核 API。
- **D11 视图状态**：`render(resource, state)` 中 `state = { revision, lastResult? }`，`lastResult` 为本次会话中该资源最近一次动作结果。`render` 可以是异步的，可读取 `host.storage`（HTTP 请求的上次响应存在插件存储里，重启后仍可见）。
- **D12 每个 kind 自动获得通用“编辑”视图**（内核按 schema 生成表单），默认视图为 `kind.views[0]`，没有则为“编辑”。
- **D13 网络**：`network.fetch(url, init)` 经宿主转发；清单 `requires.network` 声明允许的主机模式，`"*"` 表示任意主机（HTTP 请求插件需要）。未声明的地址一律拒绝（宁可误拒）。
- **D14 密钥**：补充要求取代“secrets 仅占位”。密钥只存 macOS 钥匙串（service `onedesk`，account = 密钥名），插件只能读取清单 `requires.secrets` 中声明的名字。数据库、清单、导出文件中不出现明文。设置页可增删改；卸载外部插件时询问是否删除其声明的密钥。
- **D15 停用插件的显示**：验收要求“停用后菜单项消失”，界面要求“停用插件和失效资源灰色显示、不隐藏”。决定：菜单中隐藏停用插件的资源；插件页灰色显示停用插件及“保留了 N 个资源”；“全部资源”表格和搜索结果中灰色显示这些资源，打开后提示“插件已停用”。body 不符合 schema 的资源在菜单中灰色显示并带警示图标。
- **D16 内置插件不可卸载**，只能停用；外部插件可卸载（删除插件记录与插件存储，不删除文件夹，避免误删用户文件）。

### 存储

- **D20 数据库在 Rust 侧**：rusqlite（bundled）单连接 + Mutex，前端通过 `db_select` / `db_execute` / `db_batch`（事务）命令访问。不用 tauri-plugin-sql：它是连接池，跨调用的事务不可靠，满足不了“迁移在事务中执行”。
- **D21 迁移**：`src-tauri/migrations/NNNN_name.sql`，编号递增，已发布的不再修改。版本存在 `schema_version` 表。启动时 Rust 在一个事务中逐个执行未应用的迁移，失败回滚，前端显示阻断错误页，不允许继续使用。TS 测试用同一批 SQL 文件建库。
- **D22 数据目录**：`dirs::data_dir()/onedesk`（即 `~/Library/Application Support/onedesk/`），不依赖 bundle identifier。启动时先确认目录存在（不存在则创建）。
- **D23 启动快照**：迁移前用 SQLite `VACUUM INTO` 写 `backups/onedesk-YYYYMMDD-HHMMSS.db`，只保留最近 7 份。
- **D24 搜索不用 FTS5**：中文在 FTS5 默认分词器下效果差，子串匹配反而符合预期；1 万条规模下全表扫描足够快（有性能测试）。数据量增长后再评估。
- **D25 标签**存为 JSON 数组字符串，按标签查询用 `instr(tags, '"标签"')` 精确匹配，避免多表写入。
- **D26 测试数据库安全**：TS 测试只用 sql.js 内存库；Rust 测试只用临时目录。会重建数据的集成测试需要 `ONEDESK_TEST_DB=1`，且代码拒绝打开路径中包含 `Application Support/onedesk` 或文件名为 `onedesk.db` 的数据库。

### 界面

- **D30 基础组件**：Radix UI 各原语（Dialog、DropdownMenu、Select、Tabs、Tooltip、Toast、Switch、Popover）负责交互与无障碍；外观全部用 `src/design/tokens.css` 中的 CSS 变量实现。命令面板用 cmdk（无样式）。
- **D31 样式方案**：普通 CSS + CSS 变量，类名前缀 `od-`，每个组件一个 CSS 文件放在组件旁。不用 CSS-in-JS、不用 Tailwind。除 `tokens.css` 外不允许写死颜色、像素值；不允许内联 style（拖动排序的 transform 除外）。由 `scripts/check-ui.mjs` 检查。
- **D32 图标**：只用 lucide（线性，统一 1.75 线宽）。清单 `icon` 字段填 lucide 图标名。
- **D33 文案**：界面文字集中在 `src/shell/i18n/zh-CN.ts`，组件通过 `t()` 取用。
- **D34 主题与密度**：`<html data-theme="light|dark">` 与 `data-density="comfortable|compact"`；偏好存 `app_settings`，默认跟随系统。
- **D35 路由**：外壳内部状态路由（不引入 react-router），页面：全部资源、资源、集合、插件、设置。

### 测试与工具

- **D40 界面测试**：macOS 的 WKWebView 没有 WebDriver，tauri-driver 不支持 macOS。界面测试用 Playwright 驱动“浏览器预览模式”（同一套前端 + sql.js 平台适配），截图也由它生成。真实应用另外手动启动检查，Rust 部分由 `cargo test` 覆盖。
- **D41 包管理**：pnpm；Node 22 LTS；Rust stable。

### 依赖（用途 / 替代方案 / 许可证）

| 依赖 | 用途 | 替代方案 | 许可证 |
|---|---|---|---|
| react, react-dom | 界面 | Solid、Svelte（团队熟悉度低） | MIT |
| vite, @vitejs/plugin-react | 构建 | webpack（更慢） | MIT |
| typescript | 类型 | — | Apache-2.0 |
| zod | 清单与视图树校验 | ajv + JSON Schema（更啰嗦） | MIT |
| @radix-ui/react-* | 无样式交互基础 | 自己实现（无障碍成本高） | MIT |
| cmdk | 命令面板 | 自己实现 | MIT |
| lucide-react | 线性图标 | heroicons | ISC |
| react-markdown, remark-gfm | 笔记 markdown 阅读态（不注入 HTML） | marked + DOMPurify | MIT |
| @dnd-kit/core, @dnd-kit/sortable | 菜单拖动排序（支持键盘） | 原生 HTML5 拖放（无键盘支持） | MIT |
| sql.js | 测试与浏览器预览中的 SQLite | better-sqlite3（需原生编译） | MIT |
| vitest, @vitest/coverage-v8 | 单元与集成测试、覆盖率 | jest | MIT |
| @testing-library/react, jsdom | 组件测试 | — | MIT |
| @playwright/test | 界面测试与截图 | Cypress | Apache-2.0 |
| @tauri-apps/api, cli, plugin-opener / clipboard-manager / http / dialog | 桌面壳与系统能力 | Electron（体积大） | MIT / Apache-2.0 |
| tauri, tauri-build（Rust） | 桌面壳 | — | MIT / Apache-2.0 |
| rusqlite（bundled） | SQLite | sqlx（异步、连接池） | MIT |
| keyring | macOS 钥匙串 | security-framework（仅 macOS，更底层） | MIT / Apache-2.0 |
| dirs | 数据目录 | 手写路径 | MIT / Apache-2.0 |
| serde, serde_json | 序列化 | — | MIT / Apache-2.0 |
| tempfile（dev） | Rust 测试临时目录 | — | MIT / Apache-2.0 |

### 临时措施（必须迁移）

- **T01** 浏览器预览模式把 sql.js 数据库存在 `localStorage`，只用于开发与界面测试，不含密钥（预览模式的 secrets 为内存实现）。迁移期限：第二个里程碑结束前评估是否保留预览模式。
