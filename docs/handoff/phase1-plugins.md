# phase1/plugins：四个内置插件（网址、笔记、提示词、HTTP 请求）

实际工作分支：`worktree-agent-a639a60080fda673b`（worktree 自动创建，未改名为 `phase1/plugins`，需主会话合并时处理）。

## 完成了什么

- 四个内置插件，只 import `@onedesk/plugin-api`，无 CSS/TSX：
  - `link`（`org.onedesk.link`）：kind `link`，动作 `open`，视图 `details`。
  - `note`（`org.onedesk.note`）：kind `note`，无动作，视图 `markdown`。
  - `prompt`（`org.onedesk.prompt`）：kind `prompt`，动作 `copy`（`input: { fromField: "parameters" }`），视图 `preview`；`validate` 用 `lintPlaceholders` 并检查模板中的 `{{name}}` 都在 parameters 中定义，同时检查参数名合法、不重复。
  - `http-request`（`org.onedesk.http-request`）：kind `http-request`，动作 `send`，视图 `response`；`requires.network: ["*"]`；设置项 `timeoutMs`（默认 30000）。
- `src/plugins/testing/fake-host.ts`：内存版 `HostApi`，可注入网络响应，记录 `openExternal`/`copyText`/`fetch`/`notify` 调用，提供 `runAction`（模拟内核：不抛异常、校验输出类型）、`renderView`、`emit`、`failSystemCalls`；`activatePlugin(module, options)` 一步激活。
- `src/plugins/index.ts`：`builtinPluginSources()`，4 个 `PluginSource`（origin `builtin`，JSON import 的 manifest，懒加载模块）。

## 改了哪些文件

`src/plugins/{link,note,prompt,http-request}/{manifest.json,index.ts,index.test.ts}`、`src/plugins/testing/fake-host.ts`、`src/plugins/index.ts`、`src/plugins/index.test.ts`、本文件。

## 测试与检查结果

- `pnpm install`：成功。
- `pnpm typecheck`：通过（无输出错误）。
- `pnpm lint`：通过（架构检查：内置插件 4 个；界面规范检查通过）。有一条警告“kind `link` 与通用视图节点/输出类型同名”，来自 `scripts/check-arch.mjs` 对 kind `link` 的既有处理，非错误。
- `pnpm exec vitest run src/plugins`：5 个文件、53 个测试全部通过。
- 覆盖：每个清单通过 `ManifestSchema` 且 provides 与实际注册完全一致；link 非法网址（空、file、javascript、无主机）与宿主失败；prompt 缺必填参数、模板用未定义参数、格式错误占位符、剪贴板失败、默认值回退、validate 各分支；http 网络失败（保留旧响应）、404 仍为成功并存储、非法网址、坏 header 行（指出行号）、未知方法、超时设置；每个视图的输出都经 `ViewTreeSchema` 校验。

## 还缺什么

- 未用真实内核做集成测试（第二阶段）。
- 未运行 `pnpm coverage`、cargo、e2e（不在本任务范围）。

## 决定（请汇总进 decisions.md）

1. 动作失败一律抛 `OneDeskError`（code `validation` / `unavailable`），由内核转为 `ActionResult{status:"error"}`。
2. HTTP：非 2xx 仍是成功（output 的 `message` 提示“服务器返回 N”）；网络失败为 `unavailable`，且不覆盖上一次响应。GET/HEAD 不发送 body；method 缺省为 GET；header 空行忽略，行格式 `Key: Value`，名字须为合法 token。
3. HTTP 响应存储键 `response:<resourceId>`，值 `{ status, statusText, durationMs, headers, body, receivedAt }`；监听 `resource.deleted` 删除对应响应。正文未截断（大响应会占存储，建议后续限制大小）。
4. 提示词参数填充：输入为空字符串或未提供时使用默认值；必填且无值时报“缺少参数”；非必填且无默认值时填空串。
5. 链接视图：网址非法时只显示表单，不输出 link 节点（否则视图树校验失败）。`openExternal` 的 `profile` 仅在非空时传入。
6. 笔记没有动作，`provides.actions` 为空。
7. 测试辅助目录 `src/plugins/testing/` 无 manifest，不被架构检查当作插件；测试文件通过 `../testing/fake-host` 引用，符合 `check-arch.mjs` 的白名单。
8. fake-host 用 `host.registered.{kinds,actions,views}` 暴露注册结果（因 `actions` 与 `HostApi.actions` 重名）。
9. 未新增依赖。

## 需要谁确认 / 问题

- 主会话：合并时分支名是 `worktree-agent-a639a60080fda673b`，不是 `phase1/plugins`。
- 主会话：`src/kernel/contracts.ts` 被 `src/plugins/index.ts` 通过相对路径 `../kernel/contracts` 以 type import 使用（任务允许）。
- 第二阶段：真实内核应确认 `validate` 返回的字段键、`fromField` 输入对象的形状（本插件假定为 `{ 参数名: 字符串 }`）。
