# OneDesk 架构（第一个里程碑）

## 1. 定位与运行环境

OneDesk 是“内核 + 插件”的桌面工作入口。内核只认识三件事：**资源**、**插件**、**视图**。所有具体功能（网址、笔记、提示词、HTTP 请求……）都由插件提供，内核不认识任何具体功能。

- 平台：仅 macOS，最低 **macOS 11 Big Sur**；Apple Silicon 优先，Intel（x86_64）也能构建。
- 工具链：Node.js 22 LTS（`.nvmrc`）、pnpm、Rust stable（`rust-toolchain.toml`）。
- 数据目录：`~/Library/Application Support/onedesk/`
  - `onedesk.db`：唯一数据库；`backups/`：启动时自动快照，保留最近 7 份
  - `plugins/<插件文件夹>/manifest.json`：外部插件

## 2. 分层

```
前端（WebView：React + TypeScript）
  shell/       应用外壳：布局、菜单、页面、视图渲染器、命令面板接线、设置页、文案（i18n）
  design/      设计系统：tokens.css + 基础组件（Radix 交互 + 自有样式）+ 图标（lucide）
  plugins/     内置插件：只 import plugin-api，与外部插件同一套接口、同一条加载路径
  plugin-api/  对插件公开的类型与 zod 校验（清单、字段、kind、action、view、视图树、宿主 API）
  kernel/      内核：资源库、搜索、集合、插件宿主、注册表、动作执行、事件、键值存储（无 UI）
  platform/    平台适配：Tauri（invoke Rust 命令）与浏览器预览（sql.js），实现 kernel 的 Platform 接口
后端（Rust，Tauri 2）
  db：rusqlite 单连接；迁移（src-tauri/migrations/NNNN_*.sql，事务执行）、启动快照
  secrets：macOS 钥匙串（keyring）；plugins：扫描外部插件文件夹；export/import：读写导出文件夹
  系统能力：opener（系统浏览器）、clipboard-manager、http（无 CORS 的网络请求）、dialog（选择文件夹）
```

依赖方向只能向下：`shell → design / kernel / plugin-api`，`plugins → plugin-api`，`kernel → plugin-api`，`platform → kernel(类型)`。`kernel` 不得 import `plugins/`、`shell/`、`design/`、`platform/`；平台能力由 `createKernel({ platform })` 注入。外壳中只有组合根 `src/shell/bootstrap.ts` 可以 import `platform/`（选择 Tauri 或浏览器预览实现、扫描插件、创建内核）。测试注入 sql.js + 模拟平台。

## 3. 内核

- **资源库**：单表 `resources`（字段与接口摘要一致，另有内核维护的 `search_text`）。增删改查、按 kind / 标签 / 分组 / 集合查询，`version` 做乐观并发。
- **搜索**：对 `search_text`（名称 + 描述 + 标签 + body 中全部字符串，小写）做子串匹配，多词取交集，名称命中优先。目标：1 万条 < 200 ms。
- **集合**：手动集合，规则为“按标签”或“按 kind”。
- **插件宿主**：生命周期 安装 → 启用 → 激活 → 停用 → 卸载。内置与外部插件都表示为 `PluginSource { origin, manifest(JSON), load() }`，走同一条加载路径：校验清单 → 校验 apiVersion → 检查 id 重复 → 加载模块 → 激活。失败的插件记录原因（设置页展示），不影响其他插件。激活时只能注册清单 `provides` 中声明的 kind / action / view。停用时撤销注册和事件订阅，资源保留。
- **动作执行**：校验输入 → `action.run(context, input)`（异步，不阻塞界面）→ 校验输出 → 发出事件 → 返回 `{ status, output | error, durationMs }`。插件抛错被转为失败结果。
- **事件**：`resource.*`、`action.started/completed`、`plugin.changed`、`notify`。
- **键值存储**：`plugin_storage`（按插件隔离）、`app_settings`（菜单排序、折叠等）。
- **导出/导入**：导出 `resources.json`、`collections.json`、`manifest.json`、`attachments/`；导入遇到相同 id 由界面询问覆盖或跳过。密钥不进入导出。

## 4. 插件接口（apiVersion "1"，定义在 `src/plugin-api`）

```ts
export default definePlugin({
  activate(host) {
    host.resources.registerKind({ id, name, icon, schema, defaultAction, views, describe })
    host.actions.register({ id, label, kinds, input, output, run })
    host.ui.registerView({ id, label, kinds, render })
  },
})
```

宿主 API：`resources`、`collections`、`actions`、`events`、`ui`、`storage`、`notify`、`context`、`network`（经宿主转发，只允许清单声明的地址）、`secrets`（钥匙串，只允许清单声明的名字）。

视图 `render(resource, state)` 返回视图树（单个节点或节点数组），节点只有 `form`、`table`、`text`、`link` 四种。宿主校验后用基础组件画出，插件不接触 DOM。

## 5. 外壳

- 布局：左侧固定菜单（分组、折叠、拖动排序；底部插件与设置）；顶部全局搜索、新建、命令面板；右侧页面 = 标题区 + 操作区 + 内容区。最小窗口 1280×720。
- 资源页：标题区（名称、kind、标签）；操作区（kind 的动作，默认动作为主按钮）；内容区为标签页：kind 声明的视图 + 内核通用“编辑”表单（由 schema 生成）。动作结果面板显示执行中 / 成功 / 失败。
- 每个页面都有加载中、空、错误三种状态。命令面板（⌘K）：搜索资源、执行动作、跳转页面、切换主题和密度。

## 6. 测试

- 单元（vitest + sql.js，真实 SQLite）：资源增删改查、清单校验、视图树、搜索。内核覆盖率 ≥ 80%。
- 集成：插件宿主完整生命周期；迁移测试（Rust `cargo test`：从上一版本升级数据不丢）；性能测试（1 万条搜索）。
- 界面（Playwright 驱动浏览器预览模式，见 decisions.md）：新建资源、打开菜单项、运行动作、搜索、切换主题；同时生成 `docs/screenshots/`。
- 架构检查：内核源码不得出现内置插件的 id / kind；UI 检查：样式不得写死颜色和像素。
- 全部由 `pnpm check`（即 `/check`）统一运行。
