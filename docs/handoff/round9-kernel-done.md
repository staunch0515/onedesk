# 第九轮：内核交付（分支 `claude/r9-kernel-bd47e8`）

按任务书 `round9-kernel.md` 的先后做完四项：§6 小修 → §3 清单缓存（内核一半）→ §4 空闲回收 → §5 宿主接口按调用上下文授权。提交见文末。

## 测试结果（全部实际跑过）

- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过（新增 `crates/kernel/tests/round9.rs` 11 个；原有全部仍通过）。
  - 如实记下：机器负载很高时（load average 200–290，别的会话在编译）整套跑了两次，`round4.rs` 的 `network_allow_lists_redirects_loopback_limits_and_counting` 各失败一次（`command.execute` 返回错误；该测试经沙箱搬 8 MB 正文，测试配置的同步片只有 300 ms、调用 5 s）。单独跑 20 次全过，负载降到 ~50 时整套一遍全过。判断是负载造成的超时，不是本轮改动；记 `todo.md`。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：通过。
- `sh scripts/gen-types.sh --check`：最新（生成的 TS 已提交）。
- `pnpm lint`：通过。`cargo check -p onedesk-host --tests`：通过（主进程那边不用改）。
- 测试只用临时目录、本机临时 HTTP 服务（`127.0.0.1:0`；连不上的用 `127.0.0.1:1`）、内存密钥库。

`round9.rs` 覆盖（对照计划 §8）：

| 计划要求 | 测试 |
|---|---|
| 有 `.index` 时不列目录、不开清单，结果与直接扫描逐项相同 | `with_an_index_the_scan_reads_only_it_and_finds_the_same`：同一批包复制到另一个目录但**删掉所有 `manifest.json`**，只放 `.index`；另放一个带清单、不在 `.index` 里的包 `t.extra`。结果（id、版本、清单指纹、语言表、各个问题的路径与原因）与原目录直接扫描逐项相同，`t.extra` 不出现 |
| 坏条目各自成为插件问题、不影响别的 | 同上：`unreadable` → `noManifest`，不是 JSON → `badJson`，不合法 → `schema`，与目录不符 → `versionMismatch`；`dir` 不是 `<id>/<版本>` 的条目被忽略 |
| 没有 `.index` 时照旧 | `without_a_usable_index_the_folder_is_scanned`（不存在、坏 JSON、版本 2、`.index` 是文件夹 → 都直接扫描，结果相同） |
| 重扫读 `.index` | 同第一个测试末尾：主进程刷新 `.index` 后 `rescan` 报出新增的版本 |
| `main.js`、语言文件仍从包里读 | `a_kernel_started_on_an_index_runs_plugins_from_their_folders`（没有任何清单文件的插件目录，插件照常回答；插件树名字按 `zh-CN`/英语） |
| 空闲到时释放、`runtime` 字段与主题、不是停用、没有审计 | `a_quiet_runtime_is_released_and_every_use_brings_it_back` |
| 释放后各种用到方式都能重新激活、`storage` 仍在、事件订阅仍投递 | 同上：运行、渲染、页面事件、提供的树展开、命令、事件投递，每种之前都先等到释放；激活次数相应增加 |
| 每个不回收条件 | `nothing_in_flight_is_released`：运行在等宿主调用、渲染进行中、页面事件进行中、安装请求等用户答复——各自超过空闲时长 3 倍仍在 |
| 运行的 `ctx.host` 存起来后从页面事件、渲染、事件处理里用被拒 | `a_kept_ctx_host_works_only_for_its_own_invocation`：渲染、页面事件、命令、事件处理里用，**同步段和 `await` 之后**都 `staleContext`（含 `network`、`process`、`transfer`）；它们自己的 `ctx.host` 照常 |
| 结束后用被拒 | 同上：运行结束后从渲染里用 → `staleContext`；运行自己留下的异步链在运行结束后用 → `callEnded`（原有码，见决定 4） |
| 合法用法不受影响 | 同上：运行在 `await` 之后、`process.run` 的 `onOutput` 回调里用自己的 `ctx.host` 都成功 |
| 并发两个运行互不串 | 同上：运行 B 用运行 A 的 `ctx.host` 被拒、自己的照常；`two_runs_at_once_keep_their_own_progress_and_writes`：两个运行同时跑，各自的回调、写入、进度都成功且不串 |
| §6 搬运被取消/超时写审计 | `cancelled_and_timed_out_transfers_are_audited`（超时 → `timeout`；下载、capture 被取消 → `cancelled`） |
| §6 `outsideGrant` 带 `path`、`blockedByPolicy` 带 `layerName` | `refusals_name_the_path_and_the_layer`（宿主调用、`RunError.params`、`transfer`；路径截到 200 字符；网络和程序两种策略层） |
| §6 `RunError.detail` 只留主机 | `a_failed_request_names_the_host_not_the_address` |
| §6 `tree.children` 的 `locale`、进度 `fraction` 可空 | `provided_trees_get_the_locale_and_progress_may_have_no_fraction` 和上面的插件树测试 |

## 协议（只增）

| 类型 | 新增 | 说明 |
|---|---|---|
| `TreeChildrenParams` | `locale?: string` | 界面语言（BCP 47）。内核作为 `ctx.locale` 交给提供树的 `children`；插件树（`plugins`）的节点名按它取（缺失回退英语） |
| `PluginDetail` | `runtime?: PluginRuntime` | 内核总是给：当前活动版本有运行环境 → `live`，否则 `idle`（装不上的包也是 `idle`） |
| `PluginRuntime`（新类型） | `"live" \| "idle"` | |

`RunProgress.fraction` 本来就是可选的（`fraction?: number`），保持不变：插件 `ctx.progress(null, …)` 或 `ctx.progress(undefined, …)` → 进度里**没有** `fraction` 字段，只有 `message`。外壳按“没有 `fraction` 不显示百分比”即可。

## 清单缓存（内核一半，D364）

- 文件：`<插件目录>/.index`，格式按计划 §3（`version: 1`，`entries[].dir/mtime/size/manifest/error`）。内核**只读**，不写不删。
- 存在且可读、是 JSON、`version` 为 1 → 只读它：不列 `plugins/` 下的任何目录、不打开任何 `manifest.json`；每条的 `manifest` 原文照直接扫描时完全相同的规则校验（同一个函数 `manifest::parse_package`）；语言文件和 `main.js` 仍从包目录读。`mtime`、`size` 内核不看。
- 条目的问题：没有 `manifest`（`"error": "unreadable"` 或干脆缺）→ 该包 `noManifest`（`detail` 是 `error` 的值）；原文不是 JSON → `badJson`；不合法 → 相应的原因码（`schema`、`idMismatch`…）。`dir` 不是“两段、都不以 `.` 开头”的条目忽略并写一行日志；同一 `dir` 出现两次只取第一条。
- `.index` 不存在 → 照旧直接扫描。**存在但读不了、不是 JSON、`version` 不认识 → 也直接扫描**（写一行日志）：缓存只是省事，文件夹才是事实（见决定 1）。
- `plugin.rescan` 同样先看 `.index`（主进程在 `rescan` 之前刷新它）。
- 内核里新增的公开名字：`manifest::INDEX_FILE`（`".index"`）、`manifest::INDEX_VERSION`（1）、`manifest::parse_package(dir, bytes, check_folder)`。

## 空闲回收（D365）

- `KernelConfig.plugin_idle`（默认 `DEFAULT_PLUGIN_IDLE` = 10 分钟）。工作进程读 `ONEDESK_PLUGIN_IDLE_MS`（整数毫秒，小于 1000 按 1000，读不出用默认）传进来；内核不读环境变量。
- 每个插件版本的槽记“进行中的调用数”和“最近一次调用开始/结束的时间”。凡是进入插件代码的都经 `call_version`（运行、渲染、页面事件、事件投递、`migrate`、树处理函数、命令），从激活前到调用结束都算进行中；宿主调用、等待安装答复都发生在调用之内，所以被它覆盖。
- 回收任务每 `plugin_idle / 4`（夹在 50 ms–30 s 之间）看一遍：进行中为 0、距最近一次 ≥ `plugin_idle`、且槽没有被别人锁着（正在激活）→ 释放运行环境，发一次 `plugins` 主题。新建运行环境时也发一次 `plugins` 主题（`runtime` 变成 `live`）。
- 释放不改插件状态、不写审计；下次用到时与首次一样自动激活（激活失败的处理不变）。卡死/超内存的照旧整个丢弃（不变）。
- `Kernel::active_plugins()`（测试用）照旧；新增 `Inner::runtime_live(id)`、`Inner::release_idle()`。

## 宿主接口按调用上下文授权（D366）

做法（`sandbox.rs` 文件头有说明）：引擎（QuickJS）没有异步上下文的钩子，所以由内核掌握**每一个进入插件代码的入口**，并在每个入口里把任务队列跑空：

1. 处理函数的同步开头（`dispatch`）：标记“当前调用 = 这次调用”，调用后把它排出的所有 promise 任务跑完，再清除标记。
2. 每个宿主调用的答复：宿主调用不再用引擎自带的异步函数，而是立刻返回一个票号；答复在 tokio 任务里算好后，进入引擎、标记“当前调用 = 发出这个宿主调用时正在运行的那次调用”、兑现 promise、把任务队列跑空、清除标记。

因为没有计时器（D287），插件代码的每一段异步继续都源于这两种入口之一，于是每段代码都知道自己属于哪次调用。发出宿主调用时：所用的 `ctx.host` 属于调用 X、当前运行的是调用 Y：

- Y ≠ X（包括 Y 未知）→ `denied`，`reason: staleContext`，不进入宿主方法。
- Y = X 但 X 已结束 → `denied/callEnded`（原有行为）；X 被取消/超时 → `cancelled`/`timeout`（原有行为）。

**做到了**：别的调用的代码拿存下来的 `ctx.host` 用，不论在同步段还是任意次 `await` 之后，都按“正在执行的是谁”判断并被拒——页面、事件、渲染、命令、另一个运行都一样；两个并发运行互不串。
**剩下的口子**：调用 B 的代码 `await` 一个由调用 A 的代码兑现的 promise（共享 promise）时，B 接下来的代码被算作 A 的。于是：
- 页面代码等一个运行兑现的 promise，之后可以用运行的 `ctx.host`（需要插件自己的运行代码配合，等于运行替页面做事，仍在运行的生命周期里）；
- 反过来也可能误拒：缓存了“第一次加载”的 promise 被两个调用共用时，后来的那个在 `await` 之后用自己的 `ctx.host` 会得 `staleContext`。插件应为每次调用各自加载，或只缓存结果而不缓存 promise。

宿主调用被 `staleContext` 拒绝时不写审计（和原来的 `callEnded` 一样，在进入宿主方法之前就拒了）。

## 小修（§6，D367–D368）

- 搬运被取消（运行取消、调用结束时宿主调用被丢弃）→ 审计一行，结果 `cancelled`；超时（`invalid/timeout`）→ 结果 `timeout`。两者的对象同被拒行（插件给的主机/程序名），摘要 `{ ms }`。被拒和失败照旧 `failed:<code>`。
- `denied/outsideGrant` 的 `params.path`：调用给的路径原样（最多 200 个字符），`files.*`、`transfer.*` 的文件端、`process.run` 的 `cwd`、`plugins.requestInstall` 的 `folder` 全部带上。
- `denied/blockedByPolicy` 只增 `layerName`（那一层节点的名称）。程序端原来就有 `layer`（节点 id）；网络端原来没有，现在 `layer` 和 `layerName` 都有。
- 网络失败：错误 `detail` 是“`<主机>: <错误文字及其原因链>`”，HTTP 库的文字去掉了 URL（`reqwest::Error::without_url`）；读正文时失败只有错误文字。并且宿主错误的 `detail` 现在经过插件一直带到 `RunError.detail`（原来在沙箱的信封里丢了，`RunError.detail` 一直是空的；见决定 5）。
- `tree.children` 的 `locale`：见“协议”。只有提供的树（`source: provided`）有插件处理函数；“自供子节点”在现在的内核里没有单独的路径（存储树的节点由内核出），所以只做了提供的树和插件树。
- 进度的 `fraction` 可空：见“协议”，不用改。

## 新增的错误原因码与审计（列全）

| 码 | 何时 |
|---|---|
| `denied` / `reason: staleContext` | 用的 `ctx.host` 不属于正在执行的调用 |
| 参数 `path`（`outsideGrant`） | 见上 |
| 参数 `layerName`（`blockedByPolicy`）；网络端新增 `layer` | 见上 |
| 清单问题 `noManifest` 的新来源 | `.index` 条目没有 `manifest` |

审计操作名没有新的；`transfer.download`/`upload`/`capture` 多了两种结果 `cancelled`、`timeout`（写审计的新命令 `Command::Stopped`，内部用）。

## 我做的决定

1. `.index` 坏了（读不了、不是 JSON、版本不认识）时内核直接扫描，而不是当作空：内核拿到空列表会以为一个插件都没有；主进程一侧的“当作空缓存全部重读”是它重建缓存的方式，两者不矛盾。
2. 空闲时长从“最近一次调用开始或结束”算起；进行中的调用数是唯一的“忙”判断（计划列的四个条件都发生在调用之内）。
3. 新建运行环境也发 `plugins` 主题（`runtime` 从 `idle` 变 `live`）。界面第一次打开某插件页面时会多收到一次 `plugins` 主题。
4. 运行结束后自己留下的代码再用 `ctx.host` 仍是 `callEnded`（计划允许“保留已有码”）；别的调用用它是 `staleContext`。
5. 宿主错误的 `detail` 交给插件（`e.detail`）并带到 `RunError.detail`：网络失败时界面/日志能看到是哪台主机连不上；其它宿主错误的 `detail` 本来就只是给开发者看的文字（会经过运行结束时的密钥抹除）。
6. 宿主调用改成“票号 + 内核兑现”后不再用引擎的异步函数（`rquickjs::function::Async`）；行为上对插件不可见。`rearm` 照旧保留。

## 没做 / 没验证

- 1 万个包的实测耗时属于主进程一侧（`crates/host`），这里没测；内核读 `.index` 只做了正确性测试。
- 外壳、e2e、`pnpm check` 全套没跑（只跑了 lint、Rust 部分和 `cargo check -p onedesk-host --tests`）。
- `migrate` 里拿别的调用的 `ctx.host`：代码路径与命令/渲染相同，没单独写测试。
- “共享 promise”的口子见上，没有堵。

## 提交

| 提交 | 内容 |
|---|---|
| `b3f427d` | §6：`outsideGrant` 带 `path`、`blockedByPolicy` 带 `layerName`、请求失败只留主机、搬运取消/超时写审计 |
| `6c12b23` | §3：有 `plugins/.index` 时只读它 |
| `94c8c90` | §4 空闲回收与 `PluginDetail.runtime`；§6 `tree.children` 的 `locale`；协议只增与生成的 TS；工作进程读 `ONEDESK_PLUGIN_IDLE_MS` |
| `33d963f` | §5：`ctx.host` 只在自己的调用上有效（`staleContext`）；宿主错误的 `detail` 带到 `RunError.detail` |
| `e0d4e35` | `round9.rs` 测试与本文件 |

## 审查后的修改（`round9-review.md`，内核部分）

先合并了协调分支 `claude/onedesk-coord-3-f0c048`。

| # | 怎么改的 | 测试 |
|---|---|---|
| 1 | D369：`AuditResult` 只增 `cancelled`、`timeout`（生成的 `AuditResult.ts` 已更新）。`audit.list` 把库里的 `cancelled`/`timeout` 映射成这两个值（原来落进 `error`），筛选 `result: cancelled|timeout` 按它们选；`error` 仍只选 `failed:%`（不含 `failed:denied`），不包括这两种。外壳的强转由外壳会话去掉。 | `cancelled_and_timed_out_transfers_are_audited` 末尾：经 `audit.list` 看结果、按两种值筛选、`error` 里没有它们 |
| 4 | 直接扫描不再跟随符号链接：`id` 层和版本层都用不跟随的文件类型判断（与主进程 `crates/host/src/index.rs` 一致），链接既不加载也不报问题。 | `a_scan_does_not_follow_symlinked_package_folders` |
| 7 | `tree.children` 的 `locale` 只认 35 个字符内的字母、数字、`-`，否则当作没给（`kernel::valid_locale`；对提供的树和插件树都一样）。`tree.path` 仍传 `null`：`TreeNodeParams` 没有 `locale`，加字段是协议变更，本轮没定，留着。 | 单元测试 `locales_are_checked`；`provided_trees_…` 里三种坏值 |
| 10 | 补测试：经 `audit.list` 的结果（同 #1）；`.index` 里绝对路径的 `dir` 被忽略、同一 `dir` 两条只取第一条（`with_an_index_…`）；回收与新调用同时发生（`releases_racing_new_calls_lose_nothing`：空闲 5 ms，60 次调用与运行全部成功、写入不丢、期间确有释放）；D370 把共享 promise 的现有行为固定下来（`a_shared_promise_continues_as_the_invocation_that_settled_it`：页面事件等运行兑现的 promise 后能用运行存下的接口；运行等页面事件兑现的 promise 后自己的接口被拒 `staleContext`）。 | 见左 |

检查（实际跑过，机器负载 260–300）：`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol` 全过（`round9.rs` 14 个）；clippy `-D warnings` 通过；`sh scripts/gen-types.sh --check` 最新；`pnpm lint`、`pnpm typecheck`、`cargo check -p onedesk-host --tests` 通过。

## 追加：包很多时工作进程启动太慢

先合并了协调分支（`6ea41c6`）。

### 实测（debug 构建，1 万个包，`node e2e/fixtures/make-many-plugins.mjs <目录> 10000`，`.index` 按计划格式事先建好）

计时脚本直接启动 `target/debug/onedesk-worker`，记录 socket 出现（开始监听）和 `hello` 得到答复（内核打开完成）的时间。机器负载一直在变，数字都标了负载。

| | 开始监听 | `hello` 答复（内核就绪） |
|---|---|---|
| 改之前，首次（load ~60–100） | 41.9 s（内核打开完才监听） | 同左 |
| 改之前，第二次 | 9.2 s | 同左 |
| 改之后，首次（load ~20） | 2.5 s（几乎全是新编出的二进制第一次被系统加载） | 15.3 s |
| 改之后，第二次及以后（load ~20） | 0.03 s | 2.6 / 3.1 / 2.6 s |
| 改之后，第二次（load ~170，只计监听前的旧版做法） | — | 2.9–3.9 s |

改之前时间花在（`sample` 取样）：注册表扫描（每个清单校验、读语言文件，单线程，5–13 s）、首次登记（**每个插件一次查询、每个新插件一个写事务**：首次 26 s，第二次 2–4 s）、选活动版本（每个插件再查一两次，约 2 s）。

### 改了什么

1. **工作进程先监听再打开内核**（`crates/worker/src/main.rs`）：主进程连上后连接在 backlog 里等，`hello` 在内核就绪后答复。主进程那边的“15 秒内开始监听”因此与包数无关；它发 `hello` 后的等待没有时限（`crates/host/src/lib.rs` 现有代码），首次 1 万个包约 15 s 在 `hello` 上等。打开失败照旧以 1 退出（并删掉 socket）。
2. **扫描多线程校验**（`manifest.rs`，`in_parallel`：最多 8 个线程，少于 64 个包时单线程，结果按原顺序）。`.index` 和直接扫描两条路都用。不加依赖（`std::thread::scope`）。
3. **启动时插件状态一次读出**：`Kernel::open` 里首次登记和选活动版本期间，所有插件状态行用一条查询读进快照（`Inner::state_snapshot`），`plugin_param`、`confirmed_sets` 从快照取；首次登记写完后重读一次快照，选完活动版本后清空（之后照旧逐个查库）。
4. **首次登记在一个事务里写完**：新命令 `Command::PluginStates`（内部），对每个插件做与 `PluginState` 完全相同的事（建行、修订、审计 `plugin.state` 各一行），只是在一个事务里。
5. 写资源的几条语句（插入、更新、修订、搜索索引）改用预编译缓存（`prepare_cached`），取样里一半时间在反复解析 SQL。

首次 15 s 剩下的主要是 1 万个插件状态行本身的写入（每个一行资源、一条修订、一条审计、搜索索引）。要再快得改“首次登记”存什么（例如不为每个插件建资源行），那是数据结构的变更，本轮没做；但因为先监听，它已经不会撞主进程的 15 秒时限。若外壳或 e2e 对 `hello` 另有等待时限，首次需要约 15 s（debug，空闲机器）。

### 测试

`round9.rs` 的 `opening_with_thousands_of_packages_reads_and_writes_plugin_state_in_bulk`：2000 个包、有 `.index`，同一工作区打开两次；每次发给写线程的命令 ≤ 2（改之前首次约 2000 个）、逐个查插件状态 0 次（新加的测试计数 `Kernel::writes_sent()`、`Kernel::state_queries()`），2000 行状态都在；时间只设 120 s 的宽松上限。工作进程“先监听”没有单独的自动测试（现有 `crates/worker/tests/worker.rs` 5 个照常通过）。

检查（实际跑过）：`cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol` 全过（`round9.rs` 15 个）；clippy `-D warnings` 通过；`gen-types --check` 最新；`pnpm lint`、`cargo check -p onedesk-host --tests` 通过。没有跑 e2e 的“2000 packages”用例。
