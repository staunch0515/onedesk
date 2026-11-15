# round3 / kernel（分支 `claude/week1-kernel-9a967c`）：运行、插件状态与设置、命令面板

先合并了 `claude/week1-slice-3b4ae5`（72a3c7c，无冲突）。`round3-plan.md` §3–§7 的内核部分全部做了，没有砍（`run.render`、`plugin.reload`、运行记录树也做了，`plugin.reload` 的范围见“决定”第 14 条）。

## 完成了什么

| 部分 | 文件 | 内容 |
|---|---|---|
| 协议（只增） | `crates/protocol/src/lib.rs` | `ActionDecl.action`、`ActionDecl.confirm`；`CommandEffect::Open` 的 `params`、`envId`。已 `pnpm gen:types` |
| 清单 | `manifest.rs` | `contributes.actions`、`contributes.settings`、页面的 `resultTabs`/`recompute`/`usesEnv`、页面动作项的 `action`、顶层 `author`/`license`/`homepage`；全部严格校验 |
| 迁移 0005 | `migrations/0005_runs.sql` | `runs` 表（§8 的字段 + `seq`、`kept_name`、`in_task_panel`、`resource_kind`、`plugin`） |
| 写入管线 | `pipeline.rs` | `RunInsert`（审计 `run.start`）、`RunProgress`（不审计）、`RunFinish`（审计 `run.end`，操作者是执行动作的插件；做保留规则）、`RunKeep`、`RunClearFinished`、`PluginState`（状态节点的参数）、`Storage`（不审计）；启动时遗留的 `running` 改为 `error/interrupted`；永久删除连同运行 |
| 沙箱 | `sandbox.rs` | `host.actions.handle`；`ctx.progress(fraction, message)`（失败静默）；同步的 `ctx.cancelled()`；每次调用可有自己的时限（动作 60 秒） |
| 宿主能力 | `host.rs` | `params.get`、`storage.get/set/remove/keys`、`settings.get`、`util.sleep` |
| 运行等 | `runs.rs` | §3 的 14 个方法；`plugins`、`runs` 两棵树；新内核命令；命令面板 |
| 页面 | `pages.rs` | `plugin:<id>` → `page:"plugin"`；`run:<id>` → 资源的页面、输入快照、只读；`resultTabs`、`recompute`、`usesEnv`、动作项的 `action`/`confirm` 来自清单；渲染时 `ctx.envId`；停用插件的页面 |
| 停用（D290） | `kernel.rs`、`commands.rs` | 节点 `disabled`；提供树不出现；“新建”、命令面板没有它的项；它的命令、`new:` 返回 `denied`（`pluginDisabled`）；运行得到 `pluginDisabled` |
| 测试插件 | `tests/fixtures/plugins/test.runner/` | 类型 `job`、动作 `run`（表格）和 `say`（文字、不绑定资源、带 `confirm`）、页面 `editor`（重算、事件 `tidy`、`view` 结果页签）、设置三项、命令 `probe` |

## 测试与检查结果

```bash
cargo test -p onedesk-kernel -p onedesk-worker                                  # 97 个，全部通过（新增 15：tests/round3.rs 14 个 + 迁移 0005）
cargo clippy -p onedesk-kernel -p onedesk-worker --all-targets -- -D warnings   # 0 警告
sh scripts/gen-types.sh --check                                                 # 协议类型是最新的
```

| 必须有的测试 | 位置（`tests/round3.rs`，另注明的除外） |
|---|---|
| 运行成功/失败/取消各自的记录与事件 | `run_success_is_recorded_with_events_output_and_audit`、`run_failures_are_error_runs_not_protocol_errors`、`run_can_be_cancelled_…` |
| `run.start` 立即返回且执行期间内核照常应答 | `run_success_…`（< 500 ms）、`run_can_be_cancelled_…`（运行中 `tree.list` + `tree.children` < 250 ms） |
| 输入快照不受之后修改影响 | `input_snapshot_is_kept_and_table_is_truncated_to_1000_rows` |
| 输出与声明类型不符被拒绝 | `run_failures_…`（`wrongtype`、多余字段 → `badOutput`） |
| 表格截断到 1000 行 | `input_snapshot_…`（1500 行 → 1000、`total` 1500、`truncated`） |
| 取消后的宿主调用被拒绝 | `run_can_be_cancelled_…`（取消后插件写 `storage` 不生效） |
| 超时 | `run_times_out` |
| 重启后遗留的运行变为 `interrupted` | `leftover_running_runs_become_interrupted_after_restart` |
| 每资源只留 200 次、保留的不清理 | `only_200_runs_per_resource_are_kept_except_kept_ones` |
| 永久删除连同运行一起清除且文件里无残留 | `purge_removes_runs_and_leaves_no_trace_in_the_files` |
| 停用插件的各项表现与重新启用 | `disabled_plugin_greys_out_hides_and_refuses_then_comes_back`（含停用时正在跑的运行变为 `pluginDisabled`） |
| 设置的校验与默认值 | `settings_are_validated_and_default` |
| `storage` 的隔离（另一个插件、同插件另一个版本）与大小上限 | `storage_is_isolated_per_plugin_and_version_and_limited` |
| `params.get` 的继承与无环境 | `params_get_inherits_from_the_tab_environment_or_finds_nothing` |
| 页面事件返回的修改；重算（带 `draft` 的 `render`） | `page_events_recompute_frame_and_result_tabs` |
| 命令面板不含停用插件的命令 | `disabled_plugin_…`、`palette_plugins_tree_and_broken_packages` |
| 清单新增部分的每种拒绝 | `manifest::tests::manifest_rejects_each_kind_of_error`（新增 14 条） |
| 迁移升级 | `workspace::tests::migration_0005_adds_runs_and_keeps_data` |

## 我做的决定

1. **`run.start` 怎样找到动作**：`action` 含 `:` 时是完整 id；否则先在资源（或 `new:` 目标的类型、`node:` 目标的树）的页面里找同 id 的动作项、用它的 `action`，找不到再当作该插件的动作短名。找不到 → `unknownAction`。动作声明了 `kinds` 而运行没有这种类型的资源 → `invalidInput`。
2. **运行的标题和图标**：有资源时是资源名和类型图标；没有时标题是完整动作 id（外壳可按 `actionLabel` 显示），图标取动作的，没有则 `play`。
3. **插件的输出形状**：表格 `{type:"table", columns, rows, total?, truncated?}`，`total` 省略时取行数；`text`、`link`（目标须是 §9.1 的写法）、`none` 照 `RunOutput`。返回值顶层只允许 `output`、`summary`（`rows?`、`message?`），多出字段即 `badOutput`。`summary.rows` 省略时用表格的 `total`；`durationMs` 由内核量。
4. **失败原因码**：`unknownAction`、`invalidInput`、`pluginDisabled`、`badOutput`、`timeout`、`interrupted`、`pluginError`（插件抛出：`message` 是异常的第一行，`detail` 是全文），以及插件没接住的宿主错误的 `code`（如 `denied`、`conflict`）。
5. **取消**：`run.cancel` 让该次调用的令牌失效：插件正在等的宿主调用立即被拒绝，此后的宿主调用一律 `denied`（`reason: callEnded`），`ctx.cancelled()` 返回 `true`，进度被丢弃；运行记为 `cancelled`。停用插件同样取消它的运行，但记为 `error/pluginDisabled`。不在本进程里执行、却还是 `running` 的行（理论上不会有），取消时直接关掉。
6. **进度**：同一运行每 100 ms 至多写一次（写入 `runs.progress`，结束时清空），并发 `runs` 和 `run:<id>`；不审计。`fraction` 截到 0–1。
7. **审计**：`run.start` 的操作者是发起人（`user`）；`run.end` 的操作者是执行动作的插件（`plugin:<id>@<version>`），内核自己拒绝的（未知动作等）是 `core`。摘要只有动作 id、资源 id、状态和原因码，不含输入和输出。保留/取消保留记 `run.keep`/`run.unkeep`。
8. **保留规则**在每次运行结束时、同一事务里执行：同一资源（没有资源时同一动作）除保留的以外只留最新 200 次。`run.listFor`、运行记录树、`run.tasks` 最多给 200 条。
9. **`run:<id>` 页面**：用运行所属资源的类型的页面渲染，`ctx.run` 是这次运行（不带输出），`ctx.draft` 和 `values` 是输入快照，`readOnly`、`runId`，面包屑末尾 `#<seq>`。资源还在时 `ctx.resource` 是现在的资源叠上快照里的 `name`/`body.*`；资源已删除（或从没有）时用快照拼出一个。插件停用时 `state: disabled`、无视图。
10. **插件状态节点**：`enabled`（只在停用时写 `"false"`，启用即删掉这个参数）与 `settings.<name>` 都是状态节点 body 里参数表的条目，经写入管线（有历史，审计 `plugin.state`）。授权文件夹仍在 body 的 `files.folders`（第一轮的写法，未迁移）。
11. **设置的校验**：`number` 可解析为有限数（存去掉首尾空白的原文）；`boolean` 只接受 `"true"`/`"false"`；`enum` 必须是选项之一；`text` 任意。清单里默认值也按同样规则校验（`badSetting`），`enum` 必须有选项、其他类型不能有选项。
12. **`storage`**：值按 JSON 存，`set(key, null)` 等于删除；键 1–200 个字符、值序列化后 ≤ 256 KB，否则 `invalid`（`badKey` / `tooLarge`）。不审计（插件自己的数据），但走写入线程。
13. **`util.sleep`** 单次上限 10 秒（超出按 10 秒），负数按 0；取消会立即结束等待。
14. **`plugin.reload`**：只丢弃运行环境（下次用到时重新读包里的 JS），**不重读清单**：注册表在内核启动时建好、本轮是不可变的，改清单要重启工作进程。完整的重读放到“安装与多版本”那一轮一起做。
15. **插件树**：每个插件一个节点（`kind: core:plugin`，标签是插件名的 en-US 文字，`badge` 是版本），右键 `node.open`、`plugin.enable`/`plugin.disable`；清单被拒绝的包按文件夹名列出，`state: broken`，`stateReason` 是拒绝原因码（如 `schema`、`apiVersion`），`plugin.get` 给出 `load.state: error`。**运行记录树**：最近 200 次（`kind: core:run`），标签 `#<seq> <标题或保留名>`，`badge` 是状态，失败的 `state: broken`；右键 `node.open`、`run.cancel`（进行中）、`run.keep`/`run.unkeep`、`run.openResource`、`run.reuse`（有资源时）。
16. **命令面板**：内核项 `node.newGroup`、`env.newChild`、`open.audit`、`open.deleted`（组 `core`），加上每个启用插件的清单命令和“新建”项（组是插件名）。
17. **`plugin.get`**：`versions` 只有当前这一个（`installedAt: 0`）；`permissions` 本轮只有 `files`（声明了时；`granted` = 有授权文件夹）；`builtin` 恒为 `false`（内核不知道哪些是内置的，主进程知道）；`load.at/ms` 不记录。
18. **停用插件的命令**：`command.execute` 它的命令或 `new:` 它的类型 → `denied`（`reason: pluginDisabled`）；`page.event` → `pluginError`（`pluginDisabled`）。

## 新依赖

没有。

## 协议变更

只增：`ActionDecl.action?: string`、`ActionDecl.confirm?: Label`；`CommandEffect` 的 `open` 增加 `params?: Record<string,string>`、`envId?: string`。生成的 TS 已更新（`ActionDecl.ts`、`CommandEffect.ts`）。

外壳需要的新 id（按 id 配文字）：树 `plugins`、`runs`；节点类型 `core:plugin`、`core:run`；命令 `plugin.enable`、`plugin.disable`、`run.cancel`、`run.keep`、`run.unkeep`、`run.openResource`、`run.reuse`；运行失败原因码（见决定 4）；错误原因 `unknownSetting`、`badValue`、`badKey`、`tooLarge`、`pluginDisabled`、`callEnded`。

## 还缺什么 / 没验证的

- 计划“不做”的部分都没做（安装、多版本、其余宿主能力、策略、定时运行、`blobs/`、CSV 导出、空闲回收）。
- `plugin.reload` 不重读清单（决定 14）。
- “取消后的宿主调用被拒绝”的测试是间接的：取消后插件尝试写 `storage`，断言库里没有那个键；被拒的调用本身没有留下记录（`callEnded` 在进入宿主之前就拒绝了，不经过审计）。
- 动作的 60 秒时限只在测试里用 0.8 秒验证过；真实的 60 秒没跑。
- 运行的输出存在 `runs.output`（JSON 文字），单次上限 8 MB；200 次 × 8 MB 的极端情况没有量过库的大小。
- 一个插件的多个运行同时进行时，看门狗打断会让这个插件所有在途调用一起失败（沙箱的已知限制，第一轮起就是这样）。

## 审查后的修改（`docs/handoff/round3-review.md` 中标给内核的各条）

先合并了 `claude/week1-slice-3b4ae5`（c75425a，含 D293–D295）。标给内核的 #1–#6、#8、#9、#11、#13 全部修了；#10、#12 按审查意见留 todo（见末尾）。

| # | 修改 | 测试（`tests/round3.rs`） |
|---|---|---|
| 1 | 没有资源时用 `new:<类型>` 目标里的类型判断动作是否适用：未保存的新页面上能运行 | `review1_runs_on_an_unsaved_new_page` |
| 2 | 带资源的运行：资源的类型必须属于该动作的插件，否则 `invalidInput`，不交给插件（环境、配置、分组、别的插件的资源都不行） | `review2_actions_never_get_resources_of_other_plugins` |
| 3 | 停用插件的类型：`page.save`（`resource:` 与 `new:`）、`tree.rename` 返回 `denied`（`reason: pluginDisabled`）；删除仍允许 | `review3_disabled_plugin_resources_cannot_be_saved_created_or_renamed` |
| 4 | D294：`page.event` 的 `changes` 只保留本次渲染（带同一份 `draft`）的视图里出现的绑定路径 | `review4_event_changes_are_limited_to_bound_fields` |
| 5 | D295：`run.start` 的 `input`、`params` 序列化后各 ≤ 8 MB（超出是一条 `invalidInput` 的运行）；`page.resolve`、`page.event` 的 `draft` ≤ 8 MB（超出 `invalidParams`，`reason: tooLarge`）；协议一行 ≤ 32 MB：超长的行不进内存，回一条 `id: 0` 的 `invalidParams/tooLarge` 并跳过到下一个换行，连接继续可用 | `review5_oversized_input_draft_and_lines_are_refused`（含经套接字的 33 MB 行） |
| 6 | D293：`run.start` 的 `locale` → 动作的 `ctx.locale`；`run.render` 的 `locale` → 结果页签的 `ctx.locale` | `review6_locale_reaches_actions_and_result_tabs` |
| 8 | 运行行写好之后再遇到内核内部错误，不再以协议错误返回、把运行留在 `running`：改为以 `error` 结束（原因 `pluginError`，`detail` 是内部错误） | （没有能稳定触发的路径，未单独测试） |
| 9 | 被拒的宿主调用的原因：取消 → `cancelled`，调用超时或看门狗 → `timeout`，调用已结束或激活时的调用 → `callEnded` | （插件在取消后无法把被拒原因报出来，未单独测试） |
| 11 | D295：`storage` 每个插件版本最多 1000 个键（`invalid/tooManyKeys`）、值总量 16 MB（`invalid/tooLarge`；覆盖已有键按差额算）；设置值 ≤ 4 KB（`invalid/tooLarge`） | `review11_storage_and_setting_size_limits` |
| 13 | 启动时把遗留运行改为 `interrupted` 的同时，每条写一行 `run.end` 审计（操作者 `core`，摘要 `{status:"error", code:"interrupted"}`） | `leftover_running_runs_become_interrupted_after_restart`（加了断言） |

结果：`cargo test -p onedesk-kernel -p onedesk-worker` 共 104 个测试全部通过；clippy 无警告；`sh scripts/gen-types.sh --check` 协议类型是最新的。

### 内核实际会写的审计操作名（`audit.op`）

成功的行：

| 操作名 | 何时 |
|---|---|
| `resource.create` | 新建资源（含分组、环境、配置节点、插件状态节点；插件经 `host.resources` 建的也是） |
| `resource.update` | 改资源字段（含授权文件夹的增删：落在插件状态节点上） |
| `resource.move` | 移动 |
| `resource.delete` | 删除（一批一行） |
| `resource.undelete` | 整批恢复 |
| `resource.purge` | 永久删除 |
| `resource.restore` | 按字段从历史恢复（恢复父节点时是 `resource.move` 一行，修订的 op 记为 `restore`） |
| `params.set` / `params.unset` / `params.acknowledge` | 参数命令（含 `workspace.setConfig`；`page.save` 改配置页的参数仍记 `resource.update`） |
| `plugin.state` | 插件启用/停用、设置项 |
| `files.write` | 插件经 `host.files.writeText` 写文件 |
| `run.start` / `run.end` | 运行开始、结束（含启动时补记的 `interrupted`） |
| `run.keep` / `run.unkeep` | 保留 / 取消保留 |

失败或被拒的行（`result` 以 `failed:` 开头）用的是那条命令的操作名：上面所有的名字，再加 `plugin.grant`（授权文件夹失败；成功时记的是 `resource.create`/`resource.update`）、`workspace.startup`（启动命令失败）；以及插件被拒的宿主调用，操作名就是宿主方法名：`resources.get`、`resources.list`、`resources.create`、`resources.update`、`resources.move`、`resources.remove`、`files.roots`、`files.list`、`files.stat`、`files.readText`、`files.writeText`、`settings.get`（这些只在 `denied` 时写）。不写审计：`ui.set`、收藏与最近使用、运行进度、清除任务面板、插件 `storage`。

`audit.result`：`ok`、`failed:<ErrorCode>`（`failed:denied`、`failed:invalid`、`failed:conflict`、`failed:notFound`、`failed:invalidParams`、`failed:internal`）。

### 运行失败原因（`RunError.code`）

内核自己的：`unknownAction`、`invalidInput`、`pluginDisabled`、`badOutput`、`timeout`、`interrupted`、`pluginError`（插件抛出：`message` 是第一行；也用于内核内部错误）。

另外透传插件没接住的宿主错误的 `ErrorCode`：常见 `denied`、`invalid`、`conflict`、`notFound`、`invalidParams`，理论上可能有 `internal`。`cancelled` 不是失败原因而是运行状态。

### 错误原因（`ProtocolError.params.reason`）

| 错误码 | `reason` |
|---|---|
| `invalid` | `emptyName`、`unknownKind`、`parentNotFound`、`otherTree`、`notAccepted`、`notInTree`、`self`、`descendant`、`targetNotFound`、`noGroups`、`notParamNode`、`reservedField`、`secretUnsupported`、`duplicateName`（另带 `name`）、`notDeleted`、`notRestorable`、`nothingBefore`、`notAbsolute`、`notFolder`、`notFile`、`tooLarge`、`notText`、`badTarget`、`badKey`、`tooManyKeys`、`unknownSetting`、`badValue`、`helloFirst` |
| `denied` | `foreignKind`、`notRequested`、`outsideGrant`、`notAbsolute`、`undeclaredSetting`、`pluginDisabled`、`callEnded`、`cancelled`、`timeout` |
| `conflict` | `changedOnDisk`（文件）；资源与参数的字段冲突不带 `reason`，带 `field` 和 `rev` |
| `invalidParams` | `tooLarge`（`draft` 或协议一行过大）；其余参数错误不带 `reason`，只有 `detail` |
| `unsupported` | `providedTree` |
| `pluginError` | `threw`、`badOutput`（另带 `plugin`）、`outOfMemory`、`cancelled`、`engine`、`notLoaded`、`pluginDisabled` |
| `pluginTimeout` | `timeout` |
| `notFound` | 不带 `reason`，带 `what`：`resource`、`node`、`tree`、`kind`、`page`、`plugin`、`command`、`target`、`entry`、`run`、`tab`、`path`、`config` |
| `versionMismatch` | 带 `expected`、`got` |
| `unknownMethod` | 带 `method` |

插件树里被拒绝的包，`stateReason` 是清单拒绝原因：`noManifest`、`badJson`、`schema`、`apiVersion`、`badId`、`idMismatch`、`badVersion`、`versionMismatch`、`mainMissing`、`badName`、`duplicate`、`unknownPage`、`unknownTree`、`unknownCommand`、`unknownKind`、`missingAction`、`unknownAction`、`badSetting`、`localeMissing`、`badLocale`。

## 界面检查后的修改（K-R1、K-R2）

- **K-R1**：`page.resolve` 对 `new:<类型>` 目标也带上清单页面的 `resultTabs`、`recompute`、`usesEnv` 和动作项的 `action`/`confirm`（与资源目标同一段代码 `page_frame`）。测试 `tests/round3.rs::new_pages_carry_the_page_frame_from_the_manifest`。
- **K-R2（D296）**：清单 `commands[]` 增加可选的 `palette`（布尔，默认 `false`，类型不对即清单被拒）。命令面板只列 `palette: true` 的插件命令；只出现在类型 `menu` 里的命令仍只在右键菜单。内核命令仍是不需要节点的四个：`node.newGroup`、`env.newChild`、`open.audit`、`open.deleted`（“新建”项照旧）。测试 `palette_plugins_tree_and_broken_packages`（加了断言）、清单校验多两条。
- **给插件会话**：内置插件要进命令面板的命令须在清单里加 `"palette": true`，否则从面板消失。
- 105 个测试全部通过，clippy 无警告。
