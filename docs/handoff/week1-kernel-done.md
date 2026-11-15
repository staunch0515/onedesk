# week1/kernel（实际分支 `claude/week1-kernel-9a967c`）：内核与工作进程

## 完成了什么

任务书 `week1-kernel.md` 的 1–7 项全部做了，没有砍。`week1-protocol.md` §3 的全部方法都已实现，§2、§4–§8 的约定也都实现了（例外见“还缺什么”）。

| 模块 | 文件 | 内容 |
|---|---|---|
| 工作区 | `crates/kernel/src/workspace.rs`、`migrations/0001_init.sql` | 文件夹、`workspace.json`（缓存；id 以库里为准）、`workspace.db`（WAL）、迁移 0001（§3.2 的八张表，`audit` 有禁止改删的触发器）、文件锁 `.lock`（flock） |
| 写入管线 | `pipeline.rs` | 唯一入口 `Pipeline::execute(操作者, 命令)`，由专用线程 `onedesk-writer` 串行执行；读取用单独的只读连接。命令：`Create`/`Update`/`Move`/`Delete`/`Audit`/`UiSet`。顺序：权限 → 一个事务（核对并发 → 写数据 → `revisions` 整条快照 + 改了哪些字段 → `audit`）→ 提交 → 调用方发事件。失败和被拒绝的命令单独写一行审计（`result = failed:<code>`） |
| 资源与树 | `store.rs`、`kernel.rs` | 存储树 `resources`、插件声明的存储树、不显示的 `core:plugin-state`；`core:group`、`core:plugin-state`；`pos` 排序；分组删除连同后代一批 |
| 协议服务 | `transport.rs` | 按行 JSON；第一条必须是 `hello`；请求并发执行（`hello` 串行）；事件推给连接；`InProc` 是同一套“一行进一行出” |
| 插件 | `manifest.rs`、`sandbox.rs`、`host.rs` | 读 `<plugins>/<id>/<version>/manifest.json`，严格校验，同一 id 取最高版本；rquickjs 沙箱（照小样做法）；惰性激活；`pages`/`trees`/`commands` 三种处理函数；`ctx.host.resources/files/ui`；`ctx.t` |
| 文件能力 | `files.rs` | 规范化 + 解析符号链接后按路径分量比较；2 MB 上限、非 UTF-8、`basis` 冲突；先写临时文件再改名；每次写入记审计 |
| 页面与命令 | `pages.rs`、`commands.rs` | `page.resolve`/`page.save` 三种目标；`command.newItems`/`command.execute`；`plugin.grants`/`grantFolder`/`revokeFolder` |
| 工作进程 | `crates/worker/src/main.rs` | 命令行、退出码 0/1/3、只接受一条连接、连接断开后等在途请求结束并停写入线程再退出 |
| 测试插件 | `crates/kernel/tests/fixtures/plugins/test.alpha`、`test.beta` | `test.alpha`：资源类型 `item`、提供树 `disk`（文件）、页面 `editor`/`file`、命令 `probe`（测试用：按参数调用任意宿主方法并把结果放进 `copy` 效果）；`test.beta`：没有声明 `files`，用于跨插件拒绝 |

## 改了哪些文件

只动了任务书允许的：`crates/kernel/**`、`crates/worker/**`、`Cargo.lock`（新增的锁定项）、本文件、`docs/handoff/todo.md`（末尾追加）。`crates/protocol` 没有改。

## 测试与检查结果

```bash
cargo test -p onedesk-kernel -p onedesk-worker
#   lib 单元测试 18 · tests/pipeline 8 · tests/plugins 14 · tests/protocol 2 · worker 4 —— 共 46 个，全部通过
cargo clippy -p onedesk-kernel -p onedesk-worker --all-targets -- -D warnings
#   0 警告（只有根 Cargo.toml 的 4 条 “unused workspace dependency”，不是这两个包的，见 todo）
sh scripts/gen-types.sh --check      # = pnpm check:types
#   协议类型是最新的
```

`pnpm check` 全量没有跑（外壳和插件的部分在别的分支上）。

任务书点名的测试与对应位置：

| 要求 | 测试 |
|---|---|
| 管线的事务/历史/审计一致 | `tests/pipeline.rs::pipeline_transaction_history_and_audit_agree` |
| 按字段并发（不同字段都生效、同一字段冲突） | `pipeline_concurrency_is_per_field` |
| 没有变化不记 | `pipeline_unchanged_values_record_nothing` |
| 整批删除 | `pipeline_group_delete_is_one_batch` |
| 审计表不能改删 | `workspace::tests::audit_table_rejects_update_and_delete`、`pipeline_audit_rows_cannot_be_changed_or_removed` |
| 移动的各种非法情形 | `tree_move_rejects_every_illegal_destination`（自己、后代、自己的子节点旁边、不接受的目标、目标不存在、节点不存在、提供树 `unsupported`、未知树、缺目标） |
| 清单校验的每种拒绝 | `manifest::tests::manifest_rejects_each_kind_of_error`（23 种：未知字段、缺字段、apiVersion、id/版本与文件夹不符、坏版本号、坏 id、main 不存在或越出包、引用不存在的页面/树/命令/类型、提供树不能放类型、重名、短名带 `:`、缺 en-US、语言文件坏、未知 role） |
| 沙箱里没有 require/process/fetch 等；模块只能加载包内文件 | `tests/plugins.rs::sandbox_has_no_require_process_fetch_or_other_ambient_globals`、`sandbox_modules_load_only_files_of_the_package` |
| 死循环被打断且内核继续应答 | `sandbox_dead_loop_is_interrupted_and_kernel_keeps_answering`（插件空转时 `tree.list` + `tree.children` 在 250 ms 内答复；之后重新激活） |
| 超内存后运行环境被丢弃、下次能重新激活 | `sandbox_out_of_memory_discards_the_runtime_and_reactivates` |
| 视图校验拒绝未知字段 | `view_validation_rejects_unknown_fields_and_node_types` |
| `files` 的每种越权各一个被拒绝 | 宿主层（经协议、插件调用）：`host_files_outside_granted_folder_is_denied`、`host_files_dotdot_is_denied`、`host_files_symlink_pointing_outside_is_denied`、`host_files_same_name_prefix_is_denied`、`host_files_without_manifest_request_is_denied`；路径判断本身另有 `files::tests::files_*` 五个 |
| `resources` 读写别的插件的类型被拒绝 | `resources_of_another_plugins_kind_are_denied`（get/update/move/remove/list/create 别人的类型、改 `core:group`、建 `core:group`） |
| 给清单里没有的页面注册被拒绝 | `registering_a_page_missing_from_the_manifest_fails_activation` |
| 第二个工作进程退出码 3 | `crates/worker/tests/worker.rs::second_worker_on_the_same_workspace_exits_with_code_3` |
| 杀掉后重启，已提交的数据都在 | `killed_worker_restarts_with_all_committed_data`（SIGKILL） |
| 主进程连接断开后工作进程退出 | `worker_exits_with_0_when_the_main_connection_closes`（退出码 0，锁已释放） |
| 测试插件经协议走通全流程 | `tests/protocol.rs` 的 `suite()`：建分组 → `new:` 保存成资源 → 改名 → 移动 → 删除；授权临时文件夹 → 提供树列出文件 → `node:` 页面打开、保存、再打开内容已变（另含过期 `basis` 冲突、撤销授权）。**同一个函数**跑进程内（`protocol_suite_in_process`）和套接字（`protocol_suite_over_socket`）各一遍 |

## 我做的决定

1. **回答 `hello` 之前的其他请求**：返回 `invalid`，`params.reason = "helloFirst"`。
2. **授权的存放**：`core:plugin-state` 节点的 `name` 是插件 id，`body["files.folders"]` 是规范化后的路径数组。操作者是 `user`。`plugin.grantFolder` 对清单没有 `requires.files: true` 的插件返回 `denied`（`reason = "notRequested"`）；路径不是绝对路径或不是已存在的文件夹返回 `invalid`（`notAbsolute`/`notFolder`）。授权变化发 `plugins` 和该插件每棵提供树的 `tree:<id>`。
3. **隐藏的树**：`core:plugin-state` 不出现在 `tree.list`，`tree.children`/`resource.get`/`resource.delete`/`page.resolve` 都当它不存在（`notFound` 或 `null`）。
4. **并发核对的字段名**：`name`、`description`、`tags`、`body.<键>`、`parent`、`pos`；新建记为 `*`（之后任何字段都与它冲突，只在 basis 早于创建时才会碰到）。`conflict` 的 `params` 带 `field` 和当前 `rev`。
5. **`pos`**：同级从 0 连续编号；移动时重排目的地的兄弟，只有被移动的节点记历史（兄弟的序号变化不算修改）。
6. **`tree.move` 的错误原因**（`invalid` 的 `params.reason`）：`self`、`descendant`、`notAccepted`、`targetNotFound`、`otherTree`、`notInTree`；把分组放到它自己的子节点“之前/之后”算 `self`（等于放进自己）。
7. **删除**：一批共享一个 `delete_batch` id；每行各一条历史（op `delete`），审计一行汇总（`count`、`ids`）。`node.delete` 的效果是批内每个非分组资源一条 `close-target`。
8. **`resource:<分组id>` 的页面**：`found: true`、视图为空、`hasInfo: true`（只显示信息面板）。资源的插件不在时 `page.resolve` 返回 `pluginError`（`reason = "notLoaded"`）。
9. **`new:` 页面**：`title` 和名字的默认值取 `newName` 在 `context.locale` 下的文字（回退 en-US、再回退键）；`values` 按视图里的 `bind` 从清单 `defaults` 取。
10. **`node:` 页面保存后**：内核发 `tree:<树id>`；插件经 `files.writeText` 写文件时内核也发该插件每棵提供树的 `tree:<id>`。保存结果的 `basis` 取重新 `render` 的值，`render` 没给时用 `save` 返回的。
11. **插件处理函数没接住的宿主错误保留原 code**：`conflict`/`denied`/`invalid`/`notFound`/`invalidParams` 原样作为协议错误返回（否则文件保存冲突只会显示成“插件出错”）。其他异常是 `pluginError`（`reason = "threw"`）。`pluginError` 的 `reason` 还有 `badOutput`（视图或返回值不合格）、`outOfMemory`、`notLoaded`、`engine`。
12. **提供树节点**：插件返回 `{key, label, icon, expandable?, target?, badge?}`（严格校验）；树声明了 `page` 而节点没给 `target` 时，内核补 `node:<树id>/<URL 编码的 key>`；`kind` 填树 id；有目标的节点右键是 `node.open`。
13. **树的工具栏与空白处右键**：`resources` 树 = `node.newGroup` + 放进该树的类型的 `new:` 项；插件存储树 = 清单 `toolbar` + 同上；提供树 = 清单 `toolbar`。`command.newItems` 列全部（不分树），第一个插件项带 `separatorBefore`。
14. **内核命令的图标**（lucide 名字）：`node.open` `external-link`、`node.rename` `pencil`、`node.newGroup` `folder-plus`、`node.delete` `trash-2`、`plugin.grantFolder` `folder-input`；`resources` 树 `library`；分组 `folder`；缺插件的类型 `puzzle`；找不到的页面 `circle-help`。外壳可以按 id 换掉。
15. **`host.files.list`**：目录在前、按名字（不分大小写）排序，默认 200 条、最多 1000 条；指向授权范围之外的符号链接按链接本身列出（`dir:false`、`size:0`），不跟随，也就不泄露外面文件的大小和时间。`basis` 是内容指纹（FNV-1a 64 + 长度），不是修改时间。
16. **`host.resources`** 的形状：`create` 返回新资源；`update(id, changes, rev?)` 返回 `{rev}`；`move(id, {parent?, before?})`；`remove(id)`；`list({kind?, parent?})` 只列自己的类型；`get` 读别人的类型是 `denied`、不存在是 `null`。类型可写短名。
17. **沙箱的限制**按协议 §7：32 MB、看门狗 1 秒、激活 10 秒、每次调用 15 秒；看门狗或超内存后丢弃该插件的运行环境（`active_plugins()`、`activation_count()` 供测试观察）。`activate(host)` 拿到的 `host` 只有 `pages/trees/commands.handle`，没有任何宿主能力；`ctx.t(key)` 在沙箱内查表（激活时把本插件全部文字交进去），不经宿主调用。
18. **工作进程**：等主进程连接最多 30 秒，超时退出码 1；收到连接后删除套接字文件。启动时校验不过的插件包写到 stderr（`onedesk: plugin package … not loaded: <reason>`），其余照常。
19. **随机 id**：32 位十六进制，来自标准库的随机键哈希，不加依赖。

## 新依赖

都是根 `Cargo.toml` 的 `[workspace.dependencies]` 里已有的（D269 已登记），没有新增第三方包：

| crate | 用到的包 | 许可证 |
|---|---|---|
| onedesk-kernel | serde、serde_json、rquickjs 0.14、tokio、rusqlite 0.42（bundled）、semver；测试 tempfile | MIT / MIT OR Apache-2.0 |
| onedesk-worker | tokio；测试 tempfile、serde_json | 同上 |

`Cargo.lock` 新增的锁定项是 rquickjs 及其依赖（`rquickjs-core`、`rquickjs-sys`、`relative-path`、`allocator-api2` 等），与阶段 0 小样相同；许可证结论见 `stage0-kernel-slice.md`（含 Zlib 的 `foldhash`）。

## 协议变更

没有。`crates/protocol` 未改。

给外壳与插件会话的说明（都在协议范围内，只是写明）：

- 插件页面的 `render` 返回值严格校验，多出字段即 `pluginError`（`badOutput`）；提供树的 `children` 返回值同样严格。
- 插件处理函数抛出的宿主错误带 `e.code`（`ErrorCode` 的值）和 `e.params`。
- `ui` 事件的 `client` 是发起这次调用的请求的 `client`；没有 `client` 的请求发出的 `ui` 事件没有 `client`（= 发给全部）。

## 还缺什么 / 没验证的

- **审计的“合并计数”**（§4.3）没做：`audit` 表被触发器禁止 UPDATE，要合并只能换一种存法（例如另一张计数表），留到以后加迁移。
- **取消**：内核内部有按调用的取消（`CancelToken`，超时会取消并拒绝之后的宿主调用），但协议里本周没有取消方法，也没有“取消后再发宿主调用被拒”的专门测试（小样测过同样的做法）。
- **插件代码与协议收发不共用线程**：插件调用在 tokio 多线程运行时的单独任务里跑，连接读取在另一个任务里；死循环期间内核在 250 ms 内应答已有测试。但这是“不同任务”，不是专门的线程池；一个空转的插件最多占住一个工作线程 1 秒。
- 内核没提供定时器、文字编码、随机 id 等基础工具（设计 §7.4），本周插件用不到。
- 只做了一个只读连接（加锁），读多时会排队；本周规模够用。
- 没有在 Apple Silicon 上编译过（这台是 Intel）。
- 没有经主进程（`onedesk-host`）两跳的端到端测试：那是外壳分支的事；工作进程侧的命令行、退出码、断开即退出都有进程级测试。
- 套接字路径长度由调用方保证（≤103 字节），工作进程不检查，超长时 `bind` 失败、退出码 1。

## 审查后的修改（`docs/handoff/week1-review.md` 中标给内核会话的各条）

先合并了 `claude/week1-slice-3b4ae5`（无冲突）。五条全部修了，没有只记 todo 的。

| # | 修改 | 测试 |
|---|---|---|
| 2 | `files.writeText` 的写盘和审计放进一个单独的 tokio 任务（`tokio::spawn`）。插件调用超时或被取消只是不再等结果，这个任务照样跑完，写了盘就一定有审计行 | `tests/plugins.rs::file_write_finished_after_call_timeout_is_still_audited`：用 FIFO 让写入前的 basis 读取卡住，调用以 `pluginTimeout` 结束，之后放行，文件已改且 audit 有 `files.write` 行 |
| 3 | 宿主调用被拒（`denied`）时，经写入管线的新命令 `Command::Refused` 单独写一行审计（`result = failed:denied`，操作者是插件，`op` 是宿主方法名，`object` 是第一个参数里的 id、路径或 kind）。插件调用的权限检查都在进入管线之前，所以不会重复记 | `refused_host_calls_are_audited`：越权的 `resources.update`、授权范围外的 `files.readText`、没有声明的 `files.roots` 各多一行失败审计 |
| 4 | 插件命令返回的效果：`pick-folder`、`confirm` 一律拒绝；`open` 的目标必须是 §9.1 的写法；违反即 `pluginError`（`reason = "badOutput"`），一个都不交给界面 | `plugin_commands_cannot_return_consent_effects_or_bad_targets` |
| 6 | 授权改为写入线程里一个事务内的“读-改-写”（新命令 `Command::Grant {plugin, folder, add}`）；没变化不记 | `tests/pipeline.rs::concurrent_grants_lose_nothing_and_make_one_state_node`：8 个并发授权，全部保留，只有一个状态节点 |
| 8 | `page.save` 的 `node:` 目标若不是提供树，返回 `notFound` | `page_save_on_a_node_of_a_stored_tree_is_not_found` |

结果：`cargo test -p onedesk-kernel -p onedesk-worker` 共 51 个测试全部通过（新增 5 个）；`cargo clippy -p onedesk-kernel -p onedesk-worker --all-targets -- -D warnings` 无警告。#7（改名前目录被换成符号链接）按审查意见留在 todo，没有动。

## 收尾

先合并了 `claude/week1-slice-3b4ae5`（d7169ae，无冲突）。

1. **命令的 `ctx.locale`（D272）**：`command.execute` 把 `context.locale` 作为插件命令处理函数的 `ctx.locale`（以前固定为 `null`）；没给时仍是 `null`。测试 `tests/plugins.rs::command_context_locale_reaches_the_plugin_handler`。
2. **审查 #7**：`files::write_text` 不再按路径写。先从 `/` 起逐级用 `openat(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)` 打开已解析的目录（任何一级是符号链接都失败 → `denied`），之后的 basis 读取（`openat(O_NOFOLLOW)`）、读取目标的权限（`fstatat(AT_SYMLINK_NOFOLLOW)`）、建临时文件（`openat(O_CREAT|O_EXCL|O_NOFOLLOW)`）、`renameat` 都以这个目录描述符为基准。目录在此之后被换成符号链接，写入仍然落在原来那个真实目录里；目标名字上被人放了符号链接，改名替换的是链接本身，不跟随。
   - 测试（确定性的，不靠竞争时机）：`write_text_with` 带一个钩子，在目录被固定之后、写临时文件之前执行。`files::tests::files_folder_swapped_for_outside_symlink_during_write_leaves_outside_alone` 在钩子里把授权目录移走、换成指向外面的符号链接，外面同名文件未被改动，内容写进了被移走的原目录，外面没有临时文件残留。`files_link_planted_at_the_target_name_is_replaced_not_followed` 在钩子里把目标名换成指向外面的链接，外面的文件不变。
   - 没覆盖：`resolve()` 与逐级打开之间某一级被换成链接——此时逐级打开会因 `O_NOFOLLOW` 失败，返回 `denied`，不会写到外面，但没有专门测试。读操作（`readText`/`list`/`stat`）仍按路径，只读不写，留在 todo 的范围里。
   - 新依赖：`libc = "0.2"`（锁定 0.2.191，MIT OR Apache-2.0），只在 `crates/kernel/Cargo.toml` 里直接写。

结果：`cargo test -p onedesk-kernel -p onedesk-worker` 共 54 个测试全部通过（新增 3 个）；`cargo clippy -p onedesk-kernel -p onedesk-worker --all-targets -- -D warnings` 无警告。
