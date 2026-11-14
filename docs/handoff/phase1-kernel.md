# phase1/kernel：按 contracts.ts 实现内核和两个平台适配

分支：`worktree-agent-a8e299883a5b550a8`（任务说明写的是 `phase1/kernel`，但会话被要求留在 worktree 自带的分支上，没有改名）。
worktree：`/Users/zhongpingxue/onedesk/repo/.claude/worktrees/agent-a8e299883a5b550a8`

## 完成了什么

- `createKernel(options)`（`src/kernel/index.ts`）实现了 `Kernel` 接口的全部成员，冻结文件没有改动。
- 内核模块：
  - `resources.ts`：增删改查、乐观并发（版本检查写在 UPDATE 的 WHERE 里）、body 校验、标签/分组统计、按 kind/标签/分组/集合查询。
  - `search.ts`：写入时生成 `search_text`；多词 `instr` 交集；名称命中优先。
  - `collections.ts`：手动集合（按标签 / 按 kind）。
  - `plugin-host.ts` + `host-api.ts` + `registry.ts`：统一加载路径、清单校验、生命周期、注册表、每个插件的 HostApi 和权限检查（D10/D13/D14/D60）。
  - `actions.ts`：runId、取消、输入输出校验，永不抛异常（D56）。
  - `views.ts`：内核构建 ViewState、校验视图树（D64）。
  - `data.ts`：导出、导入计划、按决定覆盖或跳过，一个事务（D57）。
  - `events.ts`、`prefs.ts`、`fields.ts`（字段值校验，kind schema / 动作输入 / 插件设置共用）。
- `src/kernel/testing/`：
  - `createTestKernel()`：sql.js 内存库 + 模拟平台，可注入 `fetch`、`now`、`randomId`、`secrets`、`context`、`plugins`；返回 `opened`、`copied`、`requests` 供断言。只接受 `":memory:"`，其他路径一律拒绝（D26）。
  - `pluginSource(manifest, module, { origin })`：把清单和模块包成 `PluginSource`。
  - `sqljs.ts`：sql.js 的 `SqlDriver` + TS 迁移执行器（`import.meta.glob("/src-tauri/migrations/*.sql")`，每个迁移一个事务，维护单行 `schema_version`）。
  - `sample.ts`：假插件 `org.test.sample`（kind `sample`），内核测试用，外壳测试也可以用。
- `src/platform/`：
  - `tauri.ts`：`createTauriPlatform()`，按 `contract.ts` 调用 Rust 命令，系统能力走 opener / clipboard-manager / http / dialog 插件。
  - `browser.ts`：`createBrowserPlatform()`（异步），sql.js + localStorage 持久化（T01）、内存密钥、`plugins.scan` 返回空、导出走浏览器下载、导入返回 `not_implemented`。
  - `http.ts`：两个平台共用的网络请求实现（超时、响应头规范化、错误转 `unavailable`）。
- 主会话补充的三条约定都已满足并有测试：`fromField` 参数只有 `required: true` 且没有 default 才必填；`kind.validate` 的错误和 schema 错误合并进 `OneDeskError("validation", …, { fields })`；插件抛的 `OneDeskError` 的 code/message/hint 原样进入 `ActionResult.error`。

## 改了哪些文件

新增（全部在允许范围内）：

- `src/kernel/`：`index.ts`、`actions.ts`、`collections.ts`、`data.ts`、`events.ts`、`fields.ts`、`host-api.ts`、`plugin-host.ts`、`prefs.ts`、`registry.ts`、`resources.ts`、`search.ts`、`util.ts`、`views.ts`
- `src/kernel/` 测试：`resources.test.ts`、`search.test.ts`、`plugin-host.test.ts`、`actions.test.ts`、`views.test.ts`、`host-api.test.ts`、`data.test.ts`
- `src/kernel/testing/`：`index.ts`、`sqljs.ts`、`sample.ts`、`sqljs.test.ts`
- `src/platform/`：`tauri.ts`、`browser.ts`、`http.ts`、`platform.test.ts`
- `docs/handoff/phase1-kernel.md`

没有新增依赖，没有改 `package.json`、`scripts/`、冻结接口。

## 测试与检查结果

全部在本 worktree 实际运行过（最后一次运行时机器负载很高，`uptime` 的 load average 在 400 以上，其他会话在编译）。

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过：“架构检查通过（内核 26 个文件，内置插件 0 个）”“界面规范检查通过” |
| `pnpm coverage` | 通过：10 个测试文件、200 个测试全过；语句 97.75%、分支 92.21%、函数 98.02%、行 98.73%（阈值 80/70/80/80） |

`pnpm lint` 在这个 worktree 里读不到内置插件清单（`src/plugins` 还不存在），所以“内核不出现内置插件名字”这一条实际没有被脚本检查到。我另外手动搜了一遍（`org.onedesk`、`note`、`prompt`、`http-request`、`markdown`、`response` 的字符串字面量），非测试的内核代码里没有；唯一命中是 `testing/sample.ts` 里假插件的字段名 `note`，测试目录不在检查范围内。合并插件分支后请再跑一次 `pnpm lint`。

完成标准里的测试覆盖项对应的测试文件：

- 资源增删改查、乐观并发、body 校验、标签/分组/集合：`resources.test.ts`
- 搜索（名称、标签、正文、中文、多词）和性能：`search.test.ts`
- 清单校验（扫描错误、格式错误、apiVersion 不兼容、id 重复、未声明的注册，各有测试）和生命周期：`plugin-host.test.ts`
- 动作（成功、插件抛错、输出类型不符、取消、插件停用）：`actions.test.ts`
- 视图渲染与校验：`views.test.ts`
- 宿主 API 权限（读写范围、网络主机模式、密钥声明）：`host-api.test.ts`
- 导出/导入（覆盖/跳过）：`data.test.ts`
- 迁移执行器（失败回滚）：`testing/sqljs.test.ts`

性能（1 万条资源，6 个查询各跑 7 次，全部耗时会打印）：

- 机器相对空闲时：各查询 20–60 ms，单次最慢约 100 ms。
- 负载 400+ 时的最后一次：各查询最好的一次最慢 76.9 ms，单次最慢 126.9 ms。
- 断言用的是“每个查询最好的一次 < 200 ms”，不是单次最慢。原因：机器被其他会话占满时单次耗时会到 300–700 ms，那量的是机器而不是搜索。负载更高的一次里这个值到过 154.6 ms，所以在极端负载下这个测试仍有可能失败。

另外做过的实际运行检查：

- 在真实浏览器里（Vite 开发服务器 + 应用内浏览器）动态加载 `src/platform/browser.ts` 和内核：wasm 加载成功，迁移到版本 1，加载假插件、创建资源、搜索都正常，重新创建平台后数据从 localStorage 读回。检查后已清掉 localStorage 并停掉服务器。
- 用 Vite 的库模式单独打包 `src/platform/browser.ts`（关闭压缩）成功，迁移 SQL 和 wasm 都进了包。

没有运行过的：

- `tauri.ts` 只用模拟的 `invoke` 和插件测过（参数名、错误转换）。没有在真实 Tauri 应用里跑，Rust 命令是另一个会话在做，需要合并后联调。
- `pnpm test:rust`、`pnpm clippy`、`pnpm e2e` 不属于本任务，没有运行。

## 还缺什么

- 没有“重新安装已卸载的外部插件”的入口。D54 说设置页可以重新安装，但 `Kernel.plugins` 没有对应方法；现在卸载后再次扫描会一直跳过它，也不出现在 `list()` 里。需要主会话决定是否加接口。
- `reference` 字段只校验“是字符串”，不检查目标资源是否存在或 `refKind` 是否匹配（`validate` 是同步接口，查不了库）。
- `views.render("core/edit", …)` 抛 `not_implemented`：编辑视图由外壳按 schema 生成，内核不渲染。
- 浏览器预览模式不能导入（没有文件夹读取能力），导出是逐个文件触发浏览器下载。

## 决定（请主会话汇总到 decisions.md）

1. **sql.js 驱动和迁移执行器放在 `src/kernel/testing/sqljs.ts`**，`src/platform/browser.ts` 从那里引用。原因：架构检查不允许内核（包括 `kernel/testing`）import `platform/`，而测试内核和浏览器预览要共用同一个执行器，所以共用代码只能放在内核一侧。
2. **TS 迁移执行器每个迁移一个事务**（迁移 SQL 和 `schema_version` 更新在同一个事务里），与 `contract.ts` 里 Rust 侧的描述一致；失败时停在上一个成功的版本。
3. **`resources.create` 一律忽略草稿里的 `id` 和 `origin`**（外壳和插件都一样），只有导入能保留它们。
4. **类型未注册时**：`create`、带 `body` 的 `update` 报 `unavailable`；不带 `body` 的 `update`（改名、改标签）和 `delete` 仍然允许；`validate` 返回 `{}`（无法校验）。
5. **`update` 里的 `body` 是整体替换**，不是合并。body 里 schema 之外的键允许存在。
6. **`tags()` 和 `groups()` 只统计当前已注册 kind 的资源**，与 `list()` 的默认范围一致。
7. **搜索**：默认 `limit` 100；空查询返回最近更新的资源；排序是“名称里命中的词数”倒序，再按更新时间倒序。只把 body 里的字符串放进 `search_text`，数字和布尔不放。
8. **kind 冲突在加载阶段拒绝**：清单声明的 kind 已被先加载的插件声明时，后者记为加载错误。这样 `kindOwner` 在插件停用时也不会有歧义。
9. **激活是全有或全无**：任何一次被拒绝的注册（未声明、定义不合法、重复）都会让整个激活失败并撤销已注册的内容，即使插件自己吞掉了异常。注册只能在 `activate` 期间进行。
10. **激活失败**记在 `PluginInfo.activationError`，`state` 为 `disabled`，数据库里的启用标记不变（下次启动重试）；`plugins.enable()` 在激活失败时会 reject，方便界面直接显示原因。入口模块加载失败也算激活失败，不算加载错误；停用的外部插件不会执行它的入口代码。
11. **激活后的交叉检查**：kind 的 `defaultAction` 必须是本插件注册的、且 `kinds` 包含该 kind 的动作；kind 的 `views` 必须都已注册；动作的 `kinds` 只能是本插件注册的 kind；菜单项的动作必须已注册。
12. **宿主 API 读到无权读取的资源时抛 `permission`**（`get` 也是），不返回 null；不带 kind 的 `list` 只返回可读范围内的资源。
13. **插件订阅的 `action.completed`** 只包含自己和 `requires.plugins` 里插件的动作。
14. **网络主机模式**：比较的是主机名，大小写不敏感；`*.x.com` 只匹配子域，不匹配 `x.com` 本身；模式里带端口时要求端口一致；其他带 `*` 的写法一律不匹配。
15. **卸载**：把 `plugins` 行标成 `uninstalled = 1`、`enabled = 0`、清空 settings，删除该插件的 `plugin_storage`；资源保留。返回的 `declaredSecrets` 已去掉其他已加载插件也声明的名字（D53）。
16. **`setSettings`** 与已保存的值合并，只保留清单 `settings` 里声明的字段，并按字段类型校验。
17. **动作**：
    - 插件返回 `undefined` 视为 `{ type: "none" }`。
    - 没通过前置检查（未知动作、输入无效等）的运行只发 `action.completed`，不发 `action.started`。
    - 插件在运行中被停用时，结果是 `cancelled`。
    - 经 `host.actions.run` 触发的动作 `source` 固定为 `manual`。
18. **`ViewState.revision`** = 资源的 `version` + 该资源本次会话的动作完成次数。
19. **导入**：`planImport` 的三个入参既接受文件文本也接受已解析的 JSON；`manifest.formatVersion` 必须是 1；文件内 id 重复直接拒绝。新条目用普通 INSERT，所以计划之后如果同一个 id 被别处写入，整个导入失败并回滚，不会静默覆盖。
20. **默认上下文**：workspace 和 user 的 id 都是 `local`，名字是“本地工作区”“本地用户”。
21. **浏览器预览**：每次写库后同步把整个库写回 localStorage（键 `onedesk.preview.db`）；写不进去（超配额）时只告警、继续在内存里工作；保存的数据打不开或迁移失败时通过 `app.status().migrationError` 报告，并且不覆盖原数据。`pickFolder` 返回一个占位名字（否则外壳会当成取消，导出流程测不到）。

## 需要谁确认 / 问题

- **主会话**：分支名是 `worktree-agent-a8e299883a5b550a8` 而不是 `phase1/kernel`，合并时请留意。
- **主会话**：是否给 `Kernel.plugins` 增加“重新安装”的方法（见“还缺什么”第一条）。
- **主会话 / 外壳会话**：`createBrowserPlatform()` 是异步的，`createTauriPlatform()` 是同步的；组合根需要 `await`。迁移失败时预览平台返回的是一个空库，组合根应先看 `app.status().migrationError` 再创建内核（否则 `createKernel` 会因为没有表而报错）。
- **主会话（范围外，未改动）**：`pnpm exec vite build` 在未改动的占位 `src/main.tsx` 上就失败，报错来自 `vite:esbuild-transpile`。`vite.config.ts` 在非调试构建时设了 `minify: "esbuild"`，而依赖里没有 esbuild。我没有改 `vite.config.ts` 和 `package.json`，也没有写 `docs/handoff/todo.md`（不在我的允许范围内），请主会话处理。
- **Rust 会话**：`tauri.ts` 假定命令在失败时 reject 一个中文字符串，`secrets_get` 找不到时返回 `null`；`db_batch` 的每条语句都带 `params`（没有时传空数组）。
