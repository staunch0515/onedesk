# 第十六轮：内核会话交接（2026-11-21）

分支 `claude/r16-kernel-487bdf`（从协调分支 `8863757` 切出），不推送、不合并。第一轮功能提交 `ce41b2a`；审查修正见“审查修正”一节，提交号在那里。

确切名字见 [`round16-protocol.md`](round16-protocol.md)（第一次提交 `127b4e1` 就写好，后来只补了计数说明）。**协议 crate 和生成的 TS 本轮没有改动**（`pnpm gen:types` 之后 `src/workbench/protocol/generated/` 无差异）。

## 核对结果与做了什么

| 项 | 核对前 | 本轮做的 |
|---|---|---|
| 1. X13 `activation` 工作区打开后 | 没有：清单无此字段，只有 `contributes.events`（`resource.changed`、`run.ended`） | 清单顶层 `activation: ["workspace.opened"]`（其它值、重复 → `badActivation`）；处理函数 `host.events.on("workspace.opened", …)`；工作区打开、自动切换版本做完后，对每个已启用、版本已确认的声明者各投递一次（插件 id 顺序，走事件队列，不阻塞打开）；时限 60 秒；规则同事件处理函数（无网络、无程序） |
| 2a. `files` 读授权文件夹（列目录、读文件、mtime） | 已有：`files.list` 的 `modifiedAt`、`readText`、`stat` | 无改动（测试里查询目录式的插件用它们做了一遍索引） |
| 2b. 插件自己目录的 `files.*`（todo） | 没有（只有 `transfer` 与输出文件能用） | 相对路径 = `plugin-data/<id>/`，不需要 `requires.files`；自己目录里的绝对路径也行；`..` 出不去（`denied/outsideGrant`）；`bin/` 不可读写（`denied/ownPrograms`） |
| 2c. 按外部键批量写入、只按字段提交 | 外部键列与唯一索引已有，只有导入用；插件不能写外部键 | `resources.upsertByKey(kind, items, { othersMissing })`：一条管线命令 `Command::Upsert`、一个事务；只提交给出的 `name`/`description`/`body` 键，不接受 `tags`，不动收藏和位置；已删除的按 §3.4 恢复；上限 5000 条 |
| 2d. 资源“失效”状态 | `state` 列已有（默认 `ok`），从没写过、也没显示 | `othersMissing` 把不在本批的有键资源标 `missing`，再出现时恢复；显示为已有的 `broken` + `stateReason: "sourceMissing"`（树节点、`resource.get`、页面描述、收藏/已删除列表）；`search.query` 与插件 `resources.search`（不按 id 查时）不返回；运行记录、历史、标签、收藏不动 |
| 3. E3（X8）从运行记录打开带当时参数 | 已有：`run.reuse` → `Open { target: resource:<id>, params, envId }`，两组都有 | 补 `new:` 标签页里的运行：运行记下 `resourceKind`（从 `new:<类型>` 目标取），`run.reuse` 打开 `new:<类型>` 并带参数，节点右键里也有它。顺带：这类运行有了类型，`run.render` 能找到页面（todo 里 “`new:` 运行的实际 SQL 一直 Loading” 的内核一侧原因，见“需要确认”3） |
| 4. X9 树工具栏命令 | 已有：`trees[].toolbar`、`TreeInfo.toolbar`、`command.execute` 带 `context.tree` | 补：插件命令执行成功后发布它所有提供树的 `tree:<树>` 主题，“一层/两层”切换后树会重取 |
| 5. 被调插件的错误文字带回（todo） | `detail` 有第一行，但调用方 JS 的 `e.message` 只是 `"pluginError"`，不接住再抛时运行错误只剩码；`detail` 未抹密钥 | 调用方的 `e.message`、`e.detail` = 被调方错误首行，按这次运行读过的密钥值抹成 `***`；被调方抛带宿主码的错误时 `detail` 缺省为它的 `message`；调用方不接住时运行错误 `message` 就是这段文字 |
| 6. 禁词 | 内核注释里有 `sqlpool`、`postgresql@*`、“SQL condition” | 本轮新注释不用这些词，旧的三处也改了（`parity`、`tool@*`、`query condition`）。`crates/protocol/src/lib.rs` 里还有 3 处注释提到 `sqlpool`、1 处 `org.onedesk.files`：协议只增不改、注释会进生成的 TS，没动，交协调会话定 |

## 改了哪些文件

- `crates/kernel/src/manifest.rs`：`Manifest.activation`、`ACTIVATIONS`、`badActivation` 校验；注释禁词。
- `crates/kernel/src/events.rs`：`WORKSPACE_OPENED`、`OPEN_TIMEOUT`、`workspace_opened()`；`deliver` 也认 `activation`。
- `crates/kernel/src/kernel.rs`：打开后投递 `workspace.opened`；`Declarations.events` 含 `activation`；节点/资源的失效显示；`Upsert` 的事件与主题。
- `crates/kernel/src/pipeline.rs`：`UpsertItem`、`Command::Upsert`、`Tx::upsert`、`Tx::set_state`、`Outcome.report`。
- `crates/kernel/src/host.rs`：`resources.upsertByKey`、`plugin_resource`（`externalKey`、`missing`）、`own_files`、`files.*` 自己目录。
- `crates/kernel/src/store.rs`：`STATE_MISSING`、`STATE_OK`、`REASON_SOURCE_MISSING`、`shown_state`。
- `crates/kernel/src/sandbox.rs`：JS 侧 `resources.upsertByKey`；被调方错误文字进 `e.message`；宿主码错误的 `detail` 缺省为 `message`。
- `crates/kernel/src/calls.rs`：被调方错误抹密钥。
- `crates/kernel/src/commands.rs`：插件命令后刷新提供树。
- `crates/kernel/src/runs.rs`：`new:` 运行记 `resourceKind`；`run.reuse` 打开 `new:`。
- `crates/kernel/src/pages.rs`、`reach.rs`、`round2.rs`：失效的显示与搜索过滤。
- `crates/kernel/src/transfer.rs`：`Outcome.report` 补字段。
- `crates/kernel/tests/round16.rs`（新，8 条）；`crates/kernel/tests/round6.rs`：`review5` 一条断言改为 `ownPrograms`（写自己的 `bin/` 现在先被这条规则拒绝），并加一条“别的插件的目录仍是 `insideDataDir`”。
- `docs/handoff/round16-protocol.md`、本文件。

## 测试

只用临时目录与内存密钥库（`ONEDESK_SECRET_STORE=memory`、`test_config` 的内存密钥库），没碰钥匙串和 `~/Library/Application Support/onedesk*`。

`crates/kernel/tests/round16.rs`：
- `workspace_opened_activates_and_indexes_by_external_key`：重开工作区时插件被激活，读授权文件夹（`list`/`readText`/`modifiedAt`）并 `upsertByKey`；名字取自键、正文为默认值加给出的键、插件看到 `externalKey`/`missing`。
- `upsert_commits_given_fields_only_and_marks_others_missing`：不变不写；只改正文与说明，标签、收藏、用户改的名字、未给的正文键都保留；`othersMissing` → `broken`/`sourceMissing`（资源、节点、页面），搜索不到；文件回来后恢复、又能搜到；删除后再同步是恢复原记录（同一 id）；`duplicateKey`、`badKey`、`tags`、`tooMany`、`foreignKind`；坏的 `parent` 让整批不写。
- `missing_resources_keep_their_runs`：失效后 `run.listFor` 仍有那次运行。
- `files_in_the_plugins_own_folder_need_no_grant`：没有 `requires.files` 也能读写列自己的目录；返回的绝对路径可再用；`..` → `outsideGrant`；`bin/` → `ownPrograms`；别的绝对路径仍 `notRequested`。
- `activation_values_are_checked`：不认识的值、重复 → `badActivation`；不是数组 → `schema`；启用的插件被调用一次，停用后重开不调用。
- `a_toolbar_command_refreshes_its_provided_tree`：`TreeInfo.toolbar` 有命令；执行后发布 `tree:t.cat:t`，再取得到新模式的节点。
- `reuse_of_a_new_tab_run_reopens_a_new_tab_with_its_values`：`new:` 运行的节点有 `run.reuse`，效果为 `open new:t.q:q` 带参数；保存过的资源的保留结果仍回到 `resource:<id>`。
- `a_called_plugins_error_text_reaches_the_caller_scrubbed`：调用方拿到被调方的文字，密钥为 `***`；带宿主码的错误保留码、`detail` 为文字；不接住时运行错误 `message` 为这段文字，整条运行记录里没有明文。

命令与结果（最后一次运行）：
- `ONEDESK_SECRET_STORE=memory cargo test --workspace --no-fail-fast`（含 `src-tauri`、host、worker、protocol）：**581 通过，0 失败**。
- 修完 clippy 的一处提示后再跑 `round16`（8）与 `round6`（28）：全部通过（只改了一行，去掉多余的 `map_err`）。
- `pnpm clippy`（`cargo clippy --workspace --all-targets -- -D warnings`）：通过。
- `pnpm lint`：通过。`pnpm typecheck`：通过。`pnpm gen:types`：生成的 TS 无变化。
- 磁盘：跑完后剩约 5.5G（本工作树 `target/` 是唯一的一份）。

## 我做的决定（请协调会话编号记入 decisions）

1. 失效不新增 `NodeState` 值，用已有 `broken` + `stateReason: "sourceMissing"`：新增枚举值会让外壳的三张 `Record<NodeState,…>` 表类型检查失败（第十三轮出过一次），而外壳正在并行改。
2. 失效只由 `upsertByKey` 设置与清除；用户不能手工标，也没有单条的 `setMissing`。查询目录的“重新同步”整批交即可。
3. `upsertByKey` 对已删除的同键资源按 §3.4 恢复（整批恢复），不新建；用户在应用里删掉的目录条目会在下次同步时回来（文件是源头，A2）。
4. 计数互斥：恢复（删除或失效回来）优先于“更新”。
5. 改变 `state` 不写历史、不单独审计（不是内容变化）；整次同步记一行 `resources.upsert`（只有计数）。
6. 名字不给时取键最后一个 `/` 之后的部分；给了名字则对已有资源也提交名字（插件决定是否传）。
7. `workspace.opened` 是“激活事件”而不是新的入口函数：用已有的事件注册与队列，`activation` 里声明的名字自动算作可注册的事件。之后启用的插件不补调（只在工作区打开时）。
8. 插件自己的目录对 `files.*` 不需要 `files` 能力，`bin/` 读也不行（与 `transfer` 的规则一致）。
9. 工具栏切换没有“按下”状态；每次插件命令后都刷新它的提供树（不区分是否从工具栏点的），代价是多一次重取。
10. 被调方错误文字只取第一行，抹除用这次运行已读过的全部密钥值（与运行输出同一套）。宿主码错误把 `message` 作为缺省 `detail` 对所有插件生效（不只跨插件调用），解决 todo “带宿主码的插件错误到界面只剩码”。

## 范围外（请协调会话汇总进 todo）

- `crates/protocol/src/lib.rs` 注释里的 `sqlpool`（3 处）与 `org.onedesk.files`（1 处）：只增不改的规则下没动；`scripts/check-arch.mjs` 现在不查注释。
- `new:` 标签页的运行用 `run.reuse` 重开时只带参数，不带当时未保存的正文（打开效果没有“初始正文”）。
- 失效资源在插件 `resources.search` 里按 id 查（`ids`）时仍返回（与已删除的同样处理），没有标记字段告诉插件它失效了（`ResourceInfo` 是协议类型）。
- `workspace.opened` 处理函数超时 60 秒：上万个文件时可能不够；插件可分批（每批 5000），但一次事件只能跑 60 秒。
- 被调方的错误若来自它自己 `process.run` 的输出，已经在那里抹过一次；这里再抹一次。

## 需要确认的

1. 失效用 `broken` + `sourceMissing`（决定 1）外壳是否同意；外壳需给 `sourceMissing` 配文字（树节点提示、页面状态条）。
2. 删除后同步即恢复（决定 3）是否符合预期。
3. `new:` 运行现在有 `resourceKind`，`run.render` 会去找页面并调插件的 `renderResultTab`（`ctx.resource` 为 `null`）；todo 里的 “Loading…” 是否就此好了要看外壳与 SQL 插件，我没在界面里验证。

## 审查修正（`round16-review.md` 中归内核的，2026-11-21）

先把协调分支 `claude/onedesk-coord-6`（`23d9380`）合进本分支（快进）。

| # | 结论 | 怎么做的 | 测试 |
|---|---|---|---|
| 3 | 已修 | `execute_quiet` 的 `granted_before` 加上 `Command::Upsert`：取这批键对应的**未删除**已有资源 id；新建与从删除恢复的按空集处理，所以恢复带回的授权记 `network.grant`，已有的不重复记 | `round16.rs::review3_upsert_audits_grants_it_brings_back`（插件写授权字段仍是 `denied/grantField`；用户保存记一行；同步改说明不再记；删除后同步恢复再记一行） |
| 4 | 已修 | 被调方错误的 `params` 每个值也按这次运行读过的密钥值抹除 | `review4_callee_error_params_are_scrubbed` |
| 15 | 已修 | `plugin_resources`：一批行的 `external_key` 用一条查询（`json_each`）取；`resources.list` 走它 | 既有 round16 用例覆盖 `externalKey` |
| 16 | 已修并补测试 | `bin/` 判断不再靠 `canonicalize` 改大小写：`carry::in_own_bin` 取自己目录之后的第一段，忽略大小写比较 `bin`；`files.*` 与 `transfer`/输出文件共用 | `review16_18_own_folder_case_links_and_dotdot`：`BIN/x`、`Bin/tool` 写、`BIN/tool` 读都是 `ownPrograms` |
| 18（内核部分） | 已补测试 | — | 同上一条：自己目录里指向外面的链接 → `outsideGrant`（读、列）；指向 `bin/` 的链接 → `ownPrograms`（读、写）；绝对路径带 `..` 先解析：出了自己目录按授权文件夹（这里没有 → `notRequested`），`bin/../a.txt` 可读，`x/../bin/tool` 拒绝。`review18_workspace_opened_rules`：未确认版本不调用；处理函数里 `network.request` → `denied/notInRun`；处理 6 秒（超过普通事件的 5 秒）照常完成；它自己写的资源不对它触发 `resource.changed`。60 秒上限本身没测（要等 60 秒，时限不可配） |

D421（`actions.call` 只能在运行里）：内核不用改。

改的文件：`crates/kernel/src/kernel.rs`（#3）、`calls.rs`（#4）、`host.rs`（#15、#16）、`carry.rs`（#16 `in_own_bin`）、`crates/kernel/tests/round16.rs`（4 条新用例，共 12 条）。

测试：`ONEDESK_SECRET_STORE=memory cargo test --workspace --no-fail-fast` **585 通过、0 失败**（含合并进来的外壳、插件改动；`round16.rs` 12 条）；`pnpm clippy` 通过；`pnpm lint` 通过。提交：`5f203bb`。

## e2e 发现的修正（`round16-review.md` “e2e 发现”，2026-11-21）

先快进合入协调分支 `2e37488`。参考补丁 `round16-probe-patches.diff` 只改插件，内核按下面自己改。

| # | 怎么做的 | 测试（`round16.rs`） |
|---|---|---|
| 19 | `pages.rs` 资源页：`render` 返回的 `values` 合进 `PageDescriptor.values`（覆盖存储的值，跳过密钥字段）；`readOnly: true` → 只读 | `e2e19_render_values_and_read_only_are_used` |
| 20 | `runs.rs` `run_start`：`node:` 目标、树属于运行的插件时 `ctx.node = { tree, key }` | `e2e20_actions_on_a_node_page_get_the_node` |
| 22（D423） | `crates/protocol`：`RunOutput::Link.params: Option<BTreeMap<String,String>>`（只增），`pnpm gen:types` 只改了 `RunOutput.ts`；`check_output` 按页面事件参数的上限（64 键、4 KB）检查 | `e2e22_link_output_carries_params` |

决定：#19 插件的 `readOnly: false` 不能解除内核定的只读（借用页、停用等）；#20 只给树的所属插件（别的插件的动作在别人的节点页上不拿键）；#22 的 `params` 随运行输出存进运行记录（运行本来就存 `params`），抹密钥同输出。

测试：`ONEDESK_SECRET_STORE=memory cargo test --workspace --no-fail-fast` **588 通过、0 失败**（`round16.rs` 15 条）；`pnpm clippy`、`pnpm typecheck`、`pnpm lint` 通过。提交：E2E_COMMIT。

## 没运行过的

- e2e（Playwright）、`pnpm test`（vitest）、完整 `pnpm check`：本轮内核改动不涉及界面，归测试会话与协调会话。
- 真实应用里的运行（devhost）。
