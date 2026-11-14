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
- `src/kernel/sqljs/`（D91）：sql.js 的 `SqlDriver` + TS 迁移执行器（`import.meta.glob("/src-tauri/migrations/*.sql")`，每个迁移一个事务，维护单行 `schema_version`），测试和浏览器预览共用。
- `src/kernel/testing/`：
  - `createTestKernel()`：sql.js 内存库 + 模拟平台，可注入 `fetch`、`now`、`randomId`、`secrets`、`context`、`plugins`；返回 `opened`、`copied`、`requests` 供断言。只接受 `":memory:"`，其他路径一律拒绝（D26）。
  - `pluginSource(manifest, module, { origin })`：把清单和模块包成 `PluginSource`。
  - `sample.ts`：假插件 `org.test.sample`（kind `sample`），内核测试用，外壳测试也可以用。
- `src/platform/`：
  - `tauri.ts`：`createTauriPlatform()`，按 `contract.ts` 调用 Rust 命令，系统能力走 opener / clipboard-manager / http / dialog 插件。
  - `browser.ts`：`createBrowserPlatform()`（异步），sql.js + localStorage 持久化（T01）、内存密钥、`plugins.scan` 返回空、导出走浏览器下载、导入返回 `not_implemented`。
  - `http.ts`：两个平台共用的网络请求实现（超时、响应头规范化、错误转 `unavailable`）。
- 主会话补充的三条约定都已满足并有测试：`fromField` 参数只有 `required: true` 且没有 default 才必填；`kind.validate` 的错误和 schema 错误合并进 `OneDeskError("validation", …, { fields })`；插件抛的 `OneDeskError` 的 code/message/hint 原样进入 `ActionResult.error`。

## 改了哪些文件

新增（全部在允许范围内）：

- `src/kernel/`：`index.ts`、`actions.ts`、`collections.ts`、`data.ts`、`events.ts`、`fields.ts`、`host-api.ts`、`plugin-host.ts`、`prefs.ts`、`registry.ts`、`resources.ts`、`search.ts`、`util.ts`、`views.ts`
- `src/kernel/` 测试：`resources.test.ts`、`search.test.ts`、`plugin-host.test.ts`、`actions.test.ts`、`action-scope.test.ts`、`views.test.ts`、`host-api.test.ts`、`network.test.ts`、`data.test.ts`、`builtin-plugins.test.ts`
- `src/kernel/sqljs/`：`index.ts`、`index.test.ts`
- `src/kernel/testing/`：`index.ts`、`sample.ts`
- `src/platform/`：`tauri.ts`、`browser.ts`、`http.ts`、`platform.test.ts`
- `docs/handoff/phase1-kernel.md`

没有新增依赖，没有改 `package.json`、`scripts/`、冻结接口。

## 测试与检查结果

全部在本 worktree 实际运行过，下表是合并 main、完成审查后各项之后的最后一次（运行时机器负载仍然很高，load average 250 左右）。

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过：“架构检查通过（内核 29 个文件，内置插件 4 个）”“界面规范检查通过”。合并 main 之后脚本读得到 4 个内置插件的清单，内核不出现内置插件名字这一条现在是真的检查到了 |
| `pnpm coverage` | 通过：19 个测试文件、341 个测试全过（含 main 带来的插件测试）；语句 98.04%、分支 92.34%、函数 98.25%、行 98.99% |

完成标准里的测试覆盖项对应的测试文件：

- 资源增删改查、乐观并发、body 校验、标签/分组/集合：`resources.test.ts`
- 搜索（名称、标签、正文、中文、多词）和性能：`search.test.ts`
- 清单校验（扫描错误、格式错误、apiVersion 不兼容、id 重复、未声明的注册，各有测试）和生命周期：`plugin-host.test.ts`
- 动作（成功、插件抛错、输出类型不符、取消、插件停用）：`actions.test.ts`
- 视图渲染与校验：`views.test.ts`
- 宿主 API 权限（读写范围、网络主机模式、密钥声明）：`host-api.test.ts`
- 导出/导入（覆盖/跳过）：`data.test.ts`
- 迁移执行器（失败回滚）：`sqljs/index.test.ts`
- 内置插件经真实内核加载（无加载错误、全部激活、停用再启用恢复）：`builtin-plugins.test.ts`

性能（1 万条资源，6 个查询各跑 7 次，全部耗时会打印）：

- 机器相对空闲时：各查询 20–60 ms，单次最慢约 100 ms。
- 负载 400+ 时的最后一次：各查询最好的一次最慢 76.9 ms，单次最慢 126.9 ms。
- 断言用的是“每个查询最好的一次 < 200 ms”，不是单次最慢（D93）。原因：机器被其他会话占满时单次耗时会到 300–700 ms，那量的是机器而不是搜索。负载更高的一次里这个值到过 154.6 ms，所以在极端负载下这个测试仍有可能失败。

另外做过的实际运行检查：

- 在真实浏览器里（Vite 开发服务器 + 应用内浏览器）动态加载 `src/platform/browser.ts` 和内核：wasm 加载成功，迁移到版本 1，加载假插件、创建资源、搜索都正常，重新创建平台后数据从 localStorage 读回。检查后已清掉 localStorage 并停掉服务器。
- 用 Vite 的库模式单独打包 `src/platform/browser.ts`（关闭压缩）成功，迁移 SQL 和 wasm 都进了包。

没有运行过的：

- `tauri.ts` 只用模拟的 `invoke` 和插件测过（参数名、错误转换）。没有在真实 Tauri 应用里跑，需要联调。
- 特别是重定向：`tauri.ts` 假定给 `@tauri-apps/plugin-http` 传 `maxRedirections: 0` 时会把 3xx 响应原样返回（带 `location` 头）。这一点只按类型定义和文档写的，没有在真实应用里验证。如果它实际是报错，结果是白名单插件遇到重定向一律失败（误拒，不是放行）。
- 浏览器实跑检查是在审查前那一版上做的；之后 `browser.ts` 只改了一处 import 路径，没有重新在浏览器里跑。
- `pnpm test:rust`、`pnpm clippy`、`pnpm e2e` 不属于本任务，没有运行。

## 审查后完成的各项（主会话第二轮要求）

0. **合并 main 并实现 `plugins.uninstalled()` / `reinstall(id)`（D90）**：扫描到已卸载的外部插件时记住它的来源；`reinstall` 清掉 `uninstalled` 标记、按该来源重新加载，保持停用，不执行插件代码。它的 kind 已被别的插件占用时拒绝（`conflict`），数据库不动。
1. **全局动作的读取范围（D10）**：`kinds` 为空的动作收到 `resourceId` 时，动作所属插件必须能读该资源的 kind（自己的 + `requires.plugins`），否则返回 `permission` 失败结果，插件代码不会被调用。`host.actions.run` 另外检查调用方插件自己也能读该资源，所以不能借别的插件的动作读取。读取范围不传递。审查者复现的场景有测试（`action-scope.test.ts`）。
2. **重定向（D13）**：白名单里没有 `*` 的插件，平台不再自动跟随重定向。宿主拿到 3xx 后对 `Location` 重新做白名单检查，通过才跟随，最多 5 跳；跨源时去掉 `Authorization`、`Cookie`、`Proxy-Authorization`；303 以及非 GET/HEAD 遇到 301/302 改为不带正文的 GET。浏览器预览拿不到 3xx 的 `Location`（只有不透明响应），所以白名单插件在预览模式下遇到重定向直接拒绝。声明了 `*` 的插件仍由平台自动跟随。
3. **激活超时**：`activate()` 10 秒没有完成记为激活错误（`激活失败：超过 10 秒没有完成`），撤销它的宿主接口，继续加载后面的插件。测试用 vitest 的假计时器，没有为此增加生产代码里的注入点。
4. **标签**：新建和更新时拒绝含 `"` 或 `\` 的标签（`validation`，`fields.tags`）。
5. **`requires.network`**：格式错误的条目（带协议、路径、用户信息、空格、非法端口、位置不对的通配符等）在加载时报加载错误。不带端口的模式只匹配默认端口（http 80 / https 443），带端口的精确匹配端口。
6. **sql.js 驱动和迁移执行器**移到 `src/kernel/sqljs/`（D91），`browser.ts` 从那里引用；`testing/` 只留测试工具，不再转出这些函数。

传递“不要跟随重定向”的方式：内核调用 `platform.network.fetch` 时在 init 上多带一个 `redirect: "manual" | "follow"`，类型是 `src/kernel/host-api.ts` 导出的 `HostFetchInit`（在 `NetworkRequestInit` 基础上扩展），两个平台适配都认它。冻结的 `Platform` 接口和 `NetworkRequestInit` 没有改。自己实现 `Platform` 的测试替身如果忽略这个字段，行为就是“自动跟随”，请注意。

## 还缺什么

- 导入不检查标签里的 `"` 和 `\`：第 4 项只加在新建和更新上，导入的资源保持原样写入。
- `requires.network` 不支持 IPv6 字面量（如 `[::1]`），这样写会报加载错误。
- `reference` 字段只校验“是字符串”（D94）。
- `views.render("core/edit", …)` 抛 `not_implemented`：编辑视图由外壳按 schema 生成，内核不渲染。
- 浏览器预览模式不能导入，导出是逐个文件触发浏览器下载（D94）。

## 决定（请主会话汇总到 decisions.md）

1. **sql.js 驱动和迁移执行器放在内核一侧**（已按 D91 定在 `src/kernel/sqljs/`），`src/platform/browser.ts` 从那里引用。原因：架构检查不允许内核 import `platform/`，而测试内核和浏览器预览要共用同一个执行器。
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
14. **网络主机模式**：比较的是主机名，大小写不敏感；`*.x.com` 只匹配子域，不匹配 `x.com` 本身；不带端口只匹配默认端口，带端口时要求端口一致；格式不对的条目在加载时就报错（第二轮按主会话要求收紧）。
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
22. **重定向由宿主逐跳检查**（第二轮）：细节见“审查后完成的各项”第 2 条；最多 5 跳，超过报 `unavailable`；没有 `Location` 的 3xx 和 304 原样返回给插件。
23. **`host.actions.run` 带 `resourceId` 时先查调用方的读取范围**（第二轮）：资源不存在时不拦截，交给内核返回 `not_found`。
24. **激活超时后**（第二轮）该插件的 `state` 为 `disabled`、带 `activationError`，数据库里的启用标记不变（下次启动重试）；迟到的注册和宿主调用都被拒绝。
25. **同一次扫描里已卸载插件的来源**（第二轮）：再次 `load` 到同一个已卸载的 id 时，用新的来源覆盖记住的来源，不报重复。

## 需要谁确认 / 问题

- **主会话**：分支名是 `worktree-agent-a8e299883a5b550a8` 而不是 `phase1/kernel`，合并时请留意。
- **主会话 / Rust 会话**：联调时请确认 `@tauri-apps/plugin-http` 在 `maxRedirections: 0` 下返回 3xx 响应（见“没有运行过的”）。
- **主会话 / 外壳会话**：`platform.network.fetch` 的 init 现在可能带 `redirect` 字段（`HostFetchInit`）；外壳自己直接调平台时不需要传。
- **Rust 会话**：`tauri.ts` 假定命令在失败时 reject 一个中文字符串，`secrets_get` 找不到时返回 `null`；`db_batch` 的每条语句都带 `params`（没有时传空数组）。
- 第一轮提的“重新安装接口”“`vite build` 失败”“sql.js 代码的位置”“组合根约定”已由主会话在 D90、D95、D91、D92 处理。
