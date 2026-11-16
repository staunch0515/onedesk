# 第八轮：大数据搬运、导出点的另两种、几项收尾（协调会话定，2026-11-16）

依据：`dev-plan.md` 阶段 3；`kernel-design.md` §7.3、§7.4（“大数据不进沙箱”）、§7.5（`transfer` 一行）、§9.3。沿用前七轮的全部约定和共同规则（`round4-plan.md`–`round7-plan.md`、`coordinator-handover.md` §3–§5）。决定 D352–D360 见 `docs/decisions.md`。
本文件里的名字**定死**；协议类型由内核会话按这里的名字“只增”加进 `crates/protocol`（并 `pnpm gen:types`），外壳先按可选字段写。

## 1. 做完是什么样

- 一个示例插件（`e2e/fixtures/plugins/com.example.transfer`）：在运行里把一个本机 HTTP 地址的内容**下载**到授权文件夹里的文件、把文件**上传**到一个地址、把外部程序的输出**存成文件**；任务面板里看得到进度；取消后不留半截文件；文件比沙箱内存上限大也能搬（内容不经过插件）。地址不在白名单、路径不在授权范围、程序没声明，各自被拒。
- 一个提供自己的树并导出它的示例插件（`com.example.board`），和一个依赖它的插件（`com.example.board-extra`）：后者的类型“便签”出现在前者的树的“新建”里，建出来的资源在那棵树里，用前者的页面显示和编辑、保存；后者自己的动作出现在操作区。引用了没导出的树的类型不能新建，插件页写明原因。
- 插件市场页选包后不再显示“未保存”；安装和导入的指纹是 SHA-256；外部程序、网络被拒的运行错误里写明是哪个程序、哪个主机。

## 2. 范围（D352）

**做**：宿主能力 `transfer`（三种）；导出点 `exports.trees`、`exports.pages`；页面上下文带页面参数；指纹换 SHA-256；`RunError.params`；等待 `transfer`、`process.run` 的时间不计入动作的 60 秒。

**不做（之后）**：“用别人的输出类型”（插件自己的输出类型 `contributes.outputs` 还没有，等它一起做）；D339 的收紧；清单缓存；空闲回收；第一版旧库升级；`param_decls`；`ai.policy`；多部分表单上传；断点续传。

## 3. `ctx.host.transfer`（D353–D355）

三个调用，都只能在运行里（渲染、页面事件、事件订阅、`migrate` 里 → `denied/notInRun`，沿用 `process.run` 现有的原因码；若现有码不同，用现有的并在交接文件写明）。不返回句柄：就是一个带进度回调的调用，取消跟随运行的取消。

- `download({ url, method?, headers?, body?, to, overwrite?, timeoutMs?, onProgress? })` → `{ status, headers, bytes, path? }`
- `upload({ from, url, method?, headers?, timeoutMs?, onProgress? })` → `{ status, headers, body, truncated }`（`method` 默认 `PUT`；文件内容原样作请求体；响应正文与 `network.request` 同：文字、上限 8 MB）
- `capture({ program, args?, env?, cwd?, stdin?, to, overwrite?, timeoutMs?, onProgress? })` → `{ code, signal?, stderr, truncated, bytes, path }`（标准输出写进文件；`stderr` 与 `process.run` 同，上限 8 MB）

规则：
- **两端各按已有的规则检查**，不新增清单项：网络一端与 `network.request` 完全相同（清单主机或连接资源的授权地址、`network.allow`、`{{secret:名字}}` 代入与抹除、重定向规则）；文件一端与 `files` 的写（`to`）或读（`from`）完全相同（授权文件夹、插件自己的目录、刚选的路径；规范化并解析符号链接后比较）；程序一端与 `process.run` 完全相同（声明、`process.allow`、环境变量限制、进程组）。清单里没要对应能力 → `denied/notRequested`。原因码沿用各自已有的。
- **内容不进沙箱**：宿主按块（不超过 64 KB）直接搬；大小没有 8 MB 上限。`onProgress({ bytes, total? })` 最多每 100 ms 一次，回调里可以调 `ctx.progress`。
- **下载**先写到目标同目录的临时文件（`.<名字>.part-<随机>`），响应是 2xx 且写完才改名到位；非 2xx 不写文件，返回 `{ status, headers, bytes: 0 }`、没有 `path`；失败、超时、取消时删掉临时文件。`capture` 同样先写临时文件，程序跑完（不论退出码）改名到位，取消或超时则删掉。
- 目标已存在且 `overwrite` 不是 `true` → `conflict`，`reason: exists`。目标的父目录必须存在。
- 超时：`timeoutMs` 默认 600 000，最长 3 600 000。**动作在等 `transfer.*` 和 `process.run` 返回的时间不计入动作的 60 秒预算**（D355；它们有自己的超时），预算不因此重置。
- `protection.readonly` 生效时运行本来就被拒（D327），不另做。
- 审计：`transfer.download`、`transfer.upload`（对象是主机）、`transfer.capture`（对象是程序名）；摘要含字节数、状态码或退出码、耗时，不含地址的路径、文件内容、参数内容；文件路径记在摘要里。被拒也记。不与 `network.request`、`process.run` 重复记。

## 4. 导出点的另两种（D356–D357，§7.3）

```jsonc
"exports": {
  "kinds": [ … ],                       // 第七轮
  "trees": [ { "id": "board" } ],       // 允许依赖方把类型放进这棵树；必须是本插件自己的存储树（source: "stored"）
  "pages": [ { "id": "card" } ]         // 允许依赖方的类型用这个页面；必须是本插件自己的页面
}
```

依赖方的类型声明里 `tree`、`page` 可以写全名 `"<被依赖插件id>:<名字>"`（各自独立，可只用其一）。被依赖插件必须在 `depends` 里，否则清单不加载（`badExports` 之外新增原因 `undeclaredDepend`）。未知字段、不是自己的树或页面、不是存储树 → `badExports`。

- **是否可用**：依赖已满足（第七轮的规则）且对方导出了这棵树 / 这个页面。依赖不满足时整个插件停用（D343，不变）。依赖满足但没导出时：这个类型**不可用**——不能新建（`denied`，`reason: notExported`，`params.export` = 全名），不出现在“新建”里；已有的资源照“插件停用”显示；`PluginDetail` 只增 `unmetExports: string[]`（全名列表），外壳在插件页写明。对方之后导出了（换版本）自动恢复。
- **放进别人的树**：依赖方的类型可以建在该树的根和分组下；它出现在该树的“新建”里（依赖方 `menus.new` 写的类型，按其 `tree` 归到那棵树）。树的所有者的类型是否接收它为子节点，按所有者的 `accepts`（可写全名）；依赖方类型的 `accepts` 只能写自己的类型。写入权限不变：每个插件只能写自己的类型（`denied/foreignKind`）；所有者读不到依赖方的资源内容（除非另有导出），树上只看到基本信息。
- **用别人的页面**：该类型的资源打开时，`render`、`onEvent` 由**页面所有者**的代码执行（操作者是所有者）；`ctx.resource` 是这条资源（只读），所有者的 `ctx.host.resources` 对它只有 `get`，写 → `denied/foreignKind`。绑定字段的保存照常由框架做（操作者是用户），按依赖方类型的 `fields` 校验。操作区：页面声明里 `role` 为 `save`、`event` 的动作照常；`run`、`save-run` 的不出现（所有者的动作不适用于别人的类型）；依赖方自己的、`kinds` 含该类型的动作排在后面，运行时操作者是依赖方。结果区：`output`、`history` 页签照常；`view` 页签不出现（同 D351：依赖方的运行结果不交给所有者的代码）。
- **权限**：依赖方类型用了别人的页面，等于让那个插件的代码读到这类资源——列在依赖方的安装确认框里：`PluginPermission.id = "pages"`，`detail` 是 `<插件id>:<page>` 列表；进指纹。用别人的树不算权限。
- 切换、停用、移除的限制沿用第七轮（按 `depends`），不新增。

## 5. 收尾三项

- **页面上下文带页面参数（D358）**：`PageContext` 只增 `params: Option<BTreeMap<String,String>>`——页面上 `param: true` 字段当前的值（与 `RunStartParams.params` 同一份）。内核把它作为 `ctx.params` 交给 `render`、`onEvent`、`recompute`（与动作里的 `ctx.params` 同义）；没带时是空对象。`PageEventResult` 只增 `params: Option<BTreeMap<String,String>>`——插件可以改页面参数（如装完后清空选择），界面应用到页面状态，不产生“未保存”。市场插件的“要安装的包”改成 `param: true`。
- **指纹换 SHA-256（D359）**：安装确认与导入确认的指纹改用 SHA-256（新依赖 `sha2`，MIT/Apache-2.0，已记 D359；加在根 `Cargo.toml` 的 `[workspace.dependencies]`）。库里已存的旧算法指纹：已确认的插件版本不得因此变成未确认——打开工作区时按新算法重算并替换（或等价做法，写进交接文件），有升级测试。协议上指纹仍是不透明的字符串。
- **`RunError.params`（D360）**：`RunError` 只增 `params: Option<BTreeMap<String,String>>`，宿主拒绝或失败时带上已有的 `params`（`program`、`layer`、`host`、`name`、`export` 等）。外壳把名字写进文字。

## 6. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3–§5 的内核部分 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、根 `Cargo.toml`/`Cargo.lock`（只为加 `sha2`） |
| 外壳（Sonnet） | 页面的 `page.resolve`/`page.event`/重算带上 `context.params`，应用 `PageEventResult.params`；`RunError.params` 进文字；插件页显示 `unmetExports`、权限 `pages` 的明细；别人的树里“新建”出现依赖方类型、用别人页面的资源的操作区与结果区（核对，尽量不改）；`transfer` 相关原因码与审计操作名的文字；`todo.md` 里外壳的两条小项（见任务书） | 同前几轮 |
| 插件与测试（Sonnet） | 第一阶段：三个夹具插件、市场插件改用页面参数；第二阶段（合并后）：`e2e/round8.spec.ts` | 同前，含 `e2e/fixtures/**` |

## 7. 完成标准

- 内核必须有的测试：`transfer` 三种各自的成功路径（内容逐字节相同；用一个大于沙箱内存上限的文件证明不经过插件内存）；进度回调；网络、文件、程序一端的每种拒绝（不在白名单、`network.allow`、路径在授权外、符号链接逃出、程序未声明、`process.allow`、清单没要能力、不在运行里）；密钥代入与抹除；非 2xx 不写文件；已存在不覆盖 / `overwrite`；取消、超时后没有临时文件、进程组结束；等待时间不计入 60 秒而预算不重置；审计三种及被拒。`exports.trees`、`exports.pages` 清单的每种拒绝；全名 `tree`/`page` 在未声明依赖、未导出、已导出三种情况；`unmetExports` 与自动恢复；别人的树里新建、移动、`accepts`；所有者写依赖方资源被拒、读不到内容；用别人页面时 `render`/`onEvent` 的操作者、只读、操作区与结果区的组成、保存按依赖方 `fields` 校验；权限 `pages` 进确认框与指纹。`PageContext.params` 到 `ctx.params`、`PageEventResult.params`。SHA-256 指纹：安装与导入的确认仍然有效、旧指纹的升级。`RunError.params`。全部用临时目录、本机临时 HTTP 服务、内存密钥库。
- 外壳、测试：同前几轮（`pnpm typecheck`、`lint`、`test`、host 的测试与 clippy、假数据模式 `workbench.spec.ts` 全过且截图不变；`e2e/round8.spec.ts` 连真内核跑通）。
- 交接文件：`docs/handoff/round8-kernel-done.md`、`round8-shell-done.md`、`round8-tests-done.md`。内核的交接文件必须列全：新增的错误原因码、审计操作名、清单新增部分、宿主接口的确切签名、协议上“只增”加的类型与字段。
