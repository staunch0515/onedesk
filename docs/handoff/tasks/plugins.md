# 任务：四个内置插件（分支 phase1/plugins）

**目标**：只用 `@onedesk/plugin-api` 实现网址、笔记、提示词、HTTP 请求四个内置插件，每个都有测试。

**允许修改**
- `src/plugins/**`（每个插件一个文件夹：`link/`、`note/`、`prompt/`、`http-request/`；`src/plugins/testing/`；`src/plugins/index.ts`）
- `docs/handoff/phase1-plugins.md`

**只读依赖**：`src/plugin-api/**`（唯一可 import 的接口）、`src/kernel/contracts.ts`（只为 `PluginSource` 类型，仅 `src/plugins/index.ts` 可用）、`docs/decisions.md`（D05–D13、D50、D55–D66）

**要点**
- 每个插件：`manifest.json`（id `org.onedesk.<名字>`，apiVersion "1"，provides 与实际注册完全一致，requires 最小化）+ `index.ts`（`export default definePlugin({ activate(host) {…} })`）+ `index.test.ts`。插件内只 import `@onedesk/plugin-api` 和本文件夹文件；不写 CSS/TSX，只返回视图树。
- 网址 `link`：schema：url（url，必填）、profile（text，可选，“浏览器配置文件，暂不生效”）；动作 `open`（output `none`）调用 `host.ui.openExternal(url, { profile })`；默认动作 open；视图 `details`（form 只读 + link 节点）。
- 笔记 `note`：schema：content（longtext）；视图 `markdown`（text 节点 format markdown；空内容时返回一句提示）。
- 提示词 `prompt`：schema：template（longtext，必填）、parameters（parameter）；`validate` 用 `lintPlaceholders`（errors 阻止保存，并检查模板中的 `{{name}}` 都在 parameters 中定义）；动作 `copy`：`input: { fromField: "parameters" }`，用 `fillPlaceholders` 替换（未填的用参数默认值），`host.ui.copyText`，output `text` 返回填充后的文本；视图 `preview`（模板 + 参数表格）。
- HTTP 请求 `http-request`：schema：method（select GET/POST/PUT/PATCH/DELETE/HEAD）、url（url，必填）、headers（longtext，每行 `Key: Value`）、body（longtext）；requires.network `["*"]`；动作 `send`：经 `host.network.fetch`，把上次响应（status、statusText、耗时、headers、body、时间）存 `host.storage` 键 `response:<resourceId>`，output `text`（状态行 + 正文）；视图 `response`（异步读存储：状态与耗时 text、响应头 table、正文 text code；无响应时提示“运行 发送 查看响应”）；格式错误的 header 行报 validation。设置项：`timeoutMs`（number，默认 30000）。
- `src/plugins/testing/fake-host.ts`：内存实现 `HostApi`（可注入网络响应、记录 openExternal/copyText 调用），供插件单元测试使用。第二阶段会再用真实内核做集成测试。
- `src/plugins/index.ts`：导出 `builtinPluginSources(): PluginSource[]`（origin `builtin`，manifest 用 JSON import，`load: () => import("./link/index").then(m => m.default)`）。
- `describe(resource)` 返回中文 summary/usage。界面文字简短、动词开头。

**完成标准**：`pnpm typecheck`、`pnpm lint`（架构检查会读取你的 manifest）通过；`pnpm exec vitest run src/plugins` 通过，覆盖：每个清单通过 `ManifestSchema` 校验且 provides 与注册一致、每个动作的成功与失败路径（网址非法、提示词缺参数/格式错误、HTTP 网络失败/非 2xx/坏 header）、每个视图返回的树通过 `ViewTreeSchema`。

**交付物**：分支 `phase1/plugins` 上的提交 + `docs/handoff/phase1-plugins.md`。
