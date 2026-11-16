# 第八轮：内核交付（分支 `claude/r8-kernel-e3ae43`）

按任务书 `round8-kernel.md` 的先后做完三项：§5 收尾三项 → §3 `ctx.host.transfer` → §4 `exports.trees` / `exports.pages`。三个提交：

| 提交 | 内容 |
|---|---|
| `2244367` | §5：`PageContext.params` → `ctx.params`、`PageEventResult.params`、`RunError.params`、指纹换 SHA-256 |
| `93bfa17` | §3：`ctx.host.transfer`（`download`/`upload`/`capture`），等待 `transfer.*` 与 `process.run` 不计入动作预算 |
| `9f90a92` | §4：`exports.trees`、`exports.pages`、全名 `tree`/`page`、`unmetExports`、权限 `pages` |

## 测试结果（全部实际跑过）

- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过（新增 `crates/kernel/tests/round8.rs` 15 个；`manifest.rs` 单元测试新增 2 个、`util.rs` 1 个；原有全部仍通过）。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：通过。
- `sh scripts/gen-types.sh --check`：最新（生成的 TS 已提交）。
- `pnpm lint`：通过。`pnpm typecheck`：通过。`cargo check -p onedesk-host --tests`：通过。
- 测试只用临时目录、本机临时 HTTP 服务（`127.0.0.1:0`）、内存密钥库。

`round8.rs` 覆盖：`ctx.params` 进 render/onEvent、`PageEventResult.params`；`RunError.params`；安装指纹是 SHA-256、旧 FNV 指纹被拒、确认在重开工作区后仍有效（并核对库里存的是权限清单）；导入指纹 SHA-256 且导入成功；三种 transfer 的成功路径（24 MB+ 文件，大于测试沙箱 16 MB 内存上限，逐字节相同）、进度回调；网络端（不在白名单、重定向到不在白名单的主机、`network.allow`）、文件端（授权外、符号链接目录/文件逃出、相对路径）、程序端（未声明、`process.allow`）、清单没要能力（三种）、不在运行里（命令、页面渲染）的拒绝；密钥代入与抹除、不允许的密钥名；非 2xx 不写文件；已存在不覆盖 / `overwrite`；父目录不存在、目标是文件夹；超时（下载、capture）、取消（下载、capture）后没有临时文件、进程组结束；回调抛错停止传输；等待不计入 60 秒预算且预算不重置（`transfer.download`、`process.run` 各一遍）；审计三种及被拒；别人的树里新建（根、分组、命令）、移动、`accepts`；所有者写/删依赖方资源被拒、页面外读不到；借用页面时 render/onEvent 的操作者、只读、无密钥字段、操作区与结果区组成、保存由用户做；依赖方动作的运行与 `view` 页签不出现；`unmetExports`、不能新建（页面、命令、插件代码三条路）、已有资源显示为停用且不能写、换版本自动恢复；全名未声明依赖不加载。

## 协议（只增）

| 类型 | 新字段 | 说明 |
|---|---|---|
| `PageContext` | `params?: Record<string,string>` | 页面上 `param: true` 字段当前值；内核作为 `ctx.params`（没带时 `{}`）交给 `render`、`onEvent`、新建页的 render、节点页的 `save` |
| `PageEventResult` | `params?: Record<string,string>` | 插件返回的新页面参数，内核原样转交（不过滤，见决定 3） |
| `RunError` | `params?: Record<string,string>` | 宿主拒绝/失败时原因的其余参数（`reason` 之外的全部，如 `program`、`layer`、`host`、`export`、`header`） |
| `PluginDetail` | `unmetExports?: string[]` | 内核总是给（可能为空）；全名 `<插件id>:<树或页面>` |
| `PluginPermission.id` | 新值 `pages` | `detail` 是 `<插件id>:<page>`（多个用已有的拼法） |

指纹在协议上仍是不透明字符串（现在是 64 位小写十六进制）。

## 清单新增部分

```jsonc
"exports": {
  "kinds": [ … ],                 // 第七轮，不变
  "trees": [ { "id": "board" } ], // 本插件自己的存储树（source: "stored"），每个一次，只有 id
  "pages": [ { "id": "card" } ]   // 本插件自己的页面，每个一次，只有 id
},
"contributes": { "kinds": [ {
  "tree": "t.board:board",        // 可写别人的全名；该插件必须在 depends 里
  "page": "t.board:card",         // 同上；两者独立
  "accepts": [ "memo" ]           // 放在别人树里的类型：只能写本插件的类型（"*" 也不行）
} ] }
```

加载时的拒绝原因：`badExports`（未知字段、不是自己的树/页面、不是存储树、重复、格式错）；新增 `undeclaredDepend`（全名的插件不在 `depends`）；全名格式错 → `badName`；放在别人树里的类型 `accepts` 写了别人的类型或 `*` → `unknownKind`。自己的树/页面只能写短名（写自己的全名会按“别人的”处理并因不在 `depends` 被拒）。

## 宿主接口（插件看到的确切签名）

```ts
ctx.host.transfer.download(opts: {
  url: string; method?: string /* 同 network.request 的 7 种，默认 GET */; headers?: Record<string,string>;
  body?: string; to: string; overwrite?: boolean; timeoutMs?: number /* 默认 600000，最大 3600000 */;
  onProgress?: (p: { bytes: number; total?: number }) => void | Promise<void>;
}): Promise<{ status: number; headers: Record<string,string>; bytes: number; path?: string }>
// 非 2xx：{ status, headers, bytes: 0 }，没有 path，不写文件

ctx.host.transfer.upload(opts: {
  from: string; url: string; method?: "PUT" | "POST" | "PATCH" /* 默认 PUT */; headers?: Record<string,string>;
  timeoutMs?: number; onProgress?: (p: { bytes: number; total: number }) => void | Promise<void>;
}): Promise<{ status: number; headers: Record<string,string>; body: string; truncated: boolean }>

ctx.host.transfer.capture(opts: {
  program: string; args?: string[]; env?: Record<string,string>; cwd?: string; stdin?: string;
  to: string; overwrite?: boolean; timeoutMs?: number;
  onProgress?: (p: { bytes: number }) => void | Promise<void>;
}): Promise<{ code: number | null; signal: string | null; stderr: string; truncated: boolean; bytes: number; path: string }>
```

- `onProgress` 最多每 100 ms 一次（批里只交最后一条）；回调里可以调 `ctx.progress`。回调抛错 → 停止传输，调用以回调的错误结束（同 `process.run` 的 `onOutput`）。
- 内部方法（只由沙箱引导代码用，插件对象上没有）：`transfer.progress(sid)`、`transfer.stop(sid)`。
- 只能在运行里：渲染、页面事件、事件订阅、命令、`migrate` → `denied/notInRun`（与 `process.run` 同码）。

## 新增的错误原因码（列全）

| 码 | 何时 |
|---|---|
| `conflict` / `reason: exists` | `transfer.download`/`capture` 的目标已存在且 `overwrite` 不是 `true`（也包括写入期间别人放了同名文件：最后改名用 `RENAME_EXCL`） |
| `denied` / `reason: notExported`，`params.export` = 全名 | 依赖方类型借用的树或页面对方没导出：新建（`page.save` 的 `new:`、`command.execute` 的 `new:`、插件 `resources.create`）、写已有资源（`page.save`）、页面事件（`page.event`） |
| 清单 `undeclaredDepend` | 全名 `tree`/`page` 的插件不在 `depends` |

`transfer` 其余全部沿用已有原因码：`notInRun`、`notRequested`（清单没要 `files` 或网络）、`hostNotAllowed`、`blockedByPolicy`（`network.allow` 或 `process.allow`，后者带 `program`、`layer`）、`localAddress`、`secretNotAllowed`、`unknownSecret`、`forbiddenHeader`、`badMethod`、`badUrl`、`badScheme`、`tooManyRedirects`、`timeout`（`invalid`）、`outsideGrant`、`notAbsolute`、`insideDataDir`、`notFile`、`notFound`（`path`、`program`、`host`）、`undeclaredProgram`、`notExecutable`、`tooManyProcesses`、`badArgs`、`badEnv`、`cancelled`（`denied`，回调失败时）。

## 审计操作名（列全，新增）

- `transfer.download`、`transfer.upload`：对象是主机（成功时是最后应答的主机）。摘要 `{ method, status, bytes, ms, path }`（`path` 是本机文件路径；不含地址的路径、内容、请求头）。
- `transfer.capture`：对象是程序名。摘要 `{ args（个数）, bytes, code 或 signal, ms, path }`。
- 每次成功一行（结果 `ok`，不按运行合并）；被拒和失败各一行（结果 `failed:<code>`，与其它被拒记录同格式），对象是插件给的主机/程序名（不合法的程序名记空）。
- 不重复记 `network.request`、`process.run`。

## 我做的决定（设计没写到或与设计不一致处）

1. **旧指纹的升级**：库里 `confirmed.<版本>` 存的一直是权限清单本身（`atoms_fingerprint`，逐行文本），不是哈希；FNV 只用于显示和比对。所以换算法后已确认的版本自然仍有效，不需要迁移（计划允许的“等价做法”）。测试：确认后重开工作区仍有效，并直接核对库里存的值。代价：外壳若缓存了旧的预览指纹，`plugin.confirmPermissions` 会得 `invalid/fingerprintMismatch`，需重新取 `plugin.get` / `inspect`。
2. 文件的 `basis`（`files.readText`/`writeText` 的内容指纹）仍是 FNV：它不是确认用的指纹（D359 只说安装与导入确认）。
3. `PageEventResult.params` 内核不过滤（内核不知道哪些字段是 `param: true`），值必须是字符串（清空用 `""`），否则 `badOutput`。`PageContext.params` 与 `draft` 一起计入输入大小上限。
4. **依赖**：根 `Cargo.toml` 只加 `sha2 = "0.10"`（D359；它本来就在 `Cargo.lock` 里，`Cargo.lock` 只多了内核的依赖行）。上传的文件体用 `reqwest::Body::wrap` + 自写的 `http_body::Body`，为此在 `crates/kernel/Cargo.toml` 直接写了 `http-body = "1"`、`bytes = "1"`——两者早已经由 reqwest/hyper 编进来，`Cargo.lock` 没有新包（只是内核依赖列表多两行）。没有用 reqwest 的 `stream` 特性：它会让 `Cargo.lock` 多出一个 wasm 专用的 `wasm-streams` 条目。许可证：http-body MIT，bytes MIT。请协调会话决定是否补记 decisions.md。
5. 文件一端“与 `files` 完全相同”按现有 `files` 实现：只看授权文件夹（加 `insideDataDir` 检查）；内核的 `files` 目前没有“插件自己的目录”和“刚选的路径”，所以 `transfer` 也没有。
6. `upload` 只接受有请求体的方法 `PUT`/`POST`/`PATCH`（其余 `invalid/badMethod`）；宿主自己设 `Content-Length`；307/308 重新打开文件再发；301/302 的 POST、303 照 `network.request` 改成不带体的 GET。
7. 新模块叫 `crates/kernel/src/carry.rs`（`transfer.rs` 已被导出导入占用）。`network.request` 与下载/上传共用 `Inner::http_open`（检查与重定向逻辑一处）；`capture` 与 `process.run` 共用 `Inner::process_run`（加了可选的标准输出去处），所以程序端的检查、环境变量、进程组、超时清理完全相同。
8. 预算（D355）用第七轮的 `Hold`：等 `transfer.*`、`process.run` 时持有，时间不计入；预算不重置。等待期间插件的回调（`onProgress`、`onOutput`）用的时间也不计入，但同步片看门狗照常。
9. 进度严格“最多每 100 ms 一次”，结束时不补发最后一次（结果里有 `bytes`）；上传进度按已交给 HTTP 栈的字节数。
10. 文件内容不抹除密钥：下载的正文、`capture` 的标准输出原样进文件（它们不经过插件）；回到插件的部分（响应头、上传的响应正文、`stderr`）照常抹除。
11. **不可用的类型**（借用的树/页面没导出）：节点和页面显示为 `disabled`（`stateReason` 不填，和插件停用一样），只读；`page.save`、`page.event` → `denied/notExported`；不出现在“新建”里。插件本身照常（其余功能不受影响）。
12. **借用页面**：`ctx.resource` 带 `readOnly: true`，正文去掉该类型的密钥字段（和第七轮依赖方读资源同一函数）；所有者的 `resources.get` 只对“本次调用所在的那条资源”放行（同样去掉密钥字段），`list`/页面外的 `get` 仍 `foreignKind`；写、删、移动 → `foreignKind`。操作区：页面声明里 `save`、`event` 两种，接着是依赖方自己 `kinds` 含该类型的动作（`role: run`，id 用全名），再接第七轮的“依赖本插件的插件的动作”。结果区去掉 `view`。运行记录页也由页面所有者渲染，`view` 页签因 D351 不出现，`run.render` → `notFound`。
13. 放进别人的树：通过 `new:` 命令只会把父节点设为分组（原有逻辑），所以“建在根和分组下”；挪到所有者的类型下按所有者的 `accepts`（全名）。

## 没做 / 没验证

- 导入（`workspace.import`）没有检查“类型不可用”：文件里若有借用未导出树/页面的类型，仍会照常建出来（之后显示为停用）。已记 `todo.md`。
- 被运行取消打断的 `transfer` 不写审计行（宿主调用在取消时被直接丢弃，`process.run` 原来也如此）；超时、拒绝、回调失败都有。
- 没单独测：`transfer` 在 `migrate`、事件订阅里的拒绝（代码路径与命令/渲染相同：没有 `run_id` → `notInRun`）；`transfer` 的 `insideDataDir`；上传跨主机重定向时去掉凭据（与 `network.request` 共用代码，第四轮有测试）；安装确认框（`app.inspectPlugin`）里出现 `pages`——只测了权限清单与指纹（单元测试）和 `plugin.get` 的 `permissions`。
- 外壳、e2e、`pnpm check` 全套没跑（只跑了 lint、typecheck 和 Rust 部分）。

## 审查后的修改（`round8-review.md`，内核部分）

| # | 怎么改的 | 测试 |
|---|---|---|
| 1 | 历史运行页（`run:` 目标）借用别人的页面时与 `resolve_resource` 同样处理：交给所有者 `render` 的 `ctx.resource` 去掉密钥字段、带 `readOnly: true`，`ctx.draft`（输入快照）也去掉密钥字段；先检查类型是否可用，不可用（或任一方停用）→ 页面 `disabled`、不调用所有者的代码；操作区只留 `save`/`event`。此外凡是运行不是页面所有者自己的（含第七轮依赖方动作），交给页面代码的 `ctx.run` 去掉 `input`、`summary`、`error`、`output`（D351）。顺带修正：这条路径造出的资源行版本号用类型所属插件的版本，不再用页面所有者的。 | `a_dependents_kind_…`（历史页只读、无密钥字段、`ctx.run` 不含这四项、无 run 项）；`an_unexported_…`（导出撤回后历史页 `disabled`、视图为空） |
| 2 | D361：`Hold` 分两种等待——等用户（`enter`，不限）和等 `transfer.*`/`process.run`（`enter_wait`）。按时间片记账：重叠的调用只算一次，与等用户重叠的时间不重复算；后一种一次调用累计最多暂停 `SandboxConfig.max_wait_pause`（默认 1 小时，常量 `install::MAX_WAIT_PAUSE`），超过后 `held()` 为假、预算照常计时（截止时间 = 开始 + 预算 + 等用户的时间 + min(等待时间, 上限)）。 | `install::tests::waits_for_programs_count_once_and_at_most_the_cap`；`overlapping_waits_pause_the_budget_at_most_the_cap`（5 个首尾重叠的 `process.run`，上限 1 秒 → `timeout`；默认上限 → 成功） |
| 3 | 新函数 `files::open_source`：解析并检查后，从钉住的目录描述符用 `O_NOFOLLOW` 打开，再 `fstat` 判断是普通文件；`readText` 和 `transfer.upload` 都改用它。`upload` 保存这个描述符，每一跳（含 307/308 重发）`try_clone` 后从头读，不再按路径重开。最后一段是链接 → `denied/outsideGrant`。 | `files::tests::review3_…`（检查后把路径换成指向授权外的链接，读到的仍是原文件；之后再开被拒）；上传 307 重发仍逐字节相同 |
| 5 | `PageEventResult.params` 先按任意 JSON 收下再校验：值必须是文字，最多 64 个键，每个值最多 4 KB（4096 字节）。不合格 → 页面事件返回 `invalid`，**新原因码 `badParams`**（`detail` 写哪一项不合格）。 | `page_context_params_…`（64 键 × 4 KB 通过；65 键、4097 字节、数字值 → `invalid/badParams`；页面参数不进 `changes`、不写资源） |
| 6 | `transfer.download`/`capture` 用 `overwrite: true` 覆盖时，临时文件按原文件权限创建并 `fchmod` 到同一权限（不受 umask 影响）；新文件仍是 0644。 | `files::tests::review6_…`；`non_2xx_existing_targets_and_overwrite`（0600 覆盖后仍 0600） |

测试缺口一节补的测试：重叠调用下的预算（见 #2）；别人的页面画历史运行页（见 #1）；`notInRun` 在页面事件 `onEvent`、事件订阅、`migrate` 里（`each_end_refuses_by_its_own_rules`、`transfer_in_migrate_is_not_in_a_run`，后者同时核对审计 `failed:denied`）；`transfer` 的本机地址规则（通配主机解析到回环 → `localAddress`）；`capture` 的 `DYLD_`/`LD_` 环境变量 → `invalid/badEnv`；`PageEventResult.params` 的校验与“不进草稿”（见 #5）；依赖方资源在树之间移动的确切结果：从别的树的视角移动 → `notFound`（`what: node`），移进别的树的分组 → `invalid/otherTree`，别的树的分组移进所有者的树 → `notFound`（`what: node`），资源仍在原树。

新增原因码（审查后）：`invalid` / `badParams`（页面事件返回的页面参数不合格）。`SandboxConfig` 只增字段 `max_wait_pause`（内核配置，不是协议）。

检查（审查修改后实际跑过）：`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol` 通过（其中一次整体运行在机器负载高时 `round3` 有 1 个失败、耗时 53 秒，没看到是哪个；单独连跑 `round3` 4 次、整体再跑 1 次都全过，判断为与本次修改无关的时序抖动，未定位）；clippy `-D warnings`、`sh scripts/gen-types.sh --check`、`pnpm lint`、`cargo check -p onedesk-host --tests` 通过。

**追加（外壳发现的缺陷 1）**：网络被拒的三种 `denied/hostNotAllowed`、`denied/localAddress`、`denied/blockedByPolicy`（`network.allow`）现在都带 `params.host` = `<主机>:<端口>`（端口总是写出，如 `example.invalid:80`；不含路径、查询串），`network.request` 与 `transfer.download`/`upload` 共用这一处（`network.rs` 的 `check_hop`），经 `RunError.params.host` 到界面。测试：`each_end_refuses_by_its_own_rules`（三种 × 两条路径，及运行错误）。`outsideGrant` 补 `path`、`layer` 给名字、无总量时的进度没做（不在这次要求里）。
