# 第十七轮内核会话：完成情况

分支 `claude/r17-kernel-6cb08c`。提交：`de2e73b`（协议与 `process.run` 按行）、`9e9a207`（其余实现与测试），以及写这份文件的提交（最后提交号见本文件所在提交，`git log -1 -- docs/handoff/round17-kernel-done.md`）。

协议新增的确切名字全部在 [`round17-protocol.md`](round17-protocol.md)（也复制到了协调会话的共享笔记文件夹 `round17-protocol.md`）。

## 1. 先核对的结果

- `round17-plan.md` 说 `files.*` 已有 copy、move、remove、open——**代码里没有**。已有的只有 `roots/list/stat/readText/writeText`（加上内部用的 `part_file`、`open_source`）。这一轮全部补上。
- 授权文件夹的增（`plugin.grantFolder`）、查（`plugin.grants`、`files.roots`）、移除（`plugin.revokeFolder`）已有；缺“改”和移除的审计（之前只记一行隐藏状态资源的 `resource.update`）。
- `process.run` 已有：超时、取消立即结束进程组（SIGTERM，2 秒后 SIGKILL）、`onOutput` 按块交出。缺：按行、标明 stdout/stderr 的结果、行数上限、超时后保留已有输出、部分输出推给外壳。
- 搜索已有：3 个字符以上走 trigram 索引、更短的走子串、多词同时满足。缺：短词的“模糊匹配”（之前只是子串），两处（`search.query` 与插件的 `resources.search`）各写一份。

## 2. 做了什么

| 项 | 内容 | 测试 |
|---|---|---|
| X10 | `LineTone`、`TextAppearance`；文字节点与 `RunOutput::Text` 的 `lineTones`/`appearance`；`RunOutput::Table` 的 `appearance`/`toneColumn`/`lineColumn`（数据文件输出也能带） | `round17.rs` `x10_…`；`datafile` 单元测试 `round17_a_file_output_keeps_…` |
| X17 | `process.run` 的 `lines`、`maxLines`（默认/上限 100000）；结果 `lines: [{stream, text}]`、`stopped`；`lines` 时超时不抛错而返回已有行；`onOutput` 在 `lines` 时按整行；审计摘要带 `stopped`。`ctx.host.runs.partial(output)` → `Run.partial` | `x17_output_comes_back_as_lines…`、`x17_line_limit_and_timeout…`、`x17_cancelling…`、`x17_partial_output…` |
| X18 | `files.mkdir/copy/move/trash/remove/open/reveal/find/addRoot/replaceRoot/removeRoot`；同名 `fail/overwrite/skip/keepBoth`；`plugin.replaceFolder`；`pick-folder.replace`；授权增、改、移除各一行审计；`KernelConfig.trash_dir`、`KernelConfig.opener`；工作进程读 `ONEDESK_TRASH_DIR`、`ONEDESK_OPEN_LOG` | `x18_mkdir_copy_move…`、`x18_trash_remove_open_reveal_and_find`、`x18_granted_folders…`、`x18_pick_folder_effects…`；`files` 单元测试 `round17_keep_both_names…` |
| X6 | `round2::search_words`：短词（1–2 字符）在名字里按顺序匹配（`ab` 找到 `a-x-b`），或在其它文字里作子串；两处共用 | `x6_long_words_use_the_index…` |

所有测试只用临时目录：废纸篓是临时目录，打开/显示写进临时日志文件；`tests/common` 的 `test_config` 默认把废纸篓设成一个不存在的临时路径、打开设成什么都不做，**绝不碰真的 `~/.Trash`，也不弹 Finder**。

## 3. 自行决定的（设计没写到的，请主会话确认并编号）

1. **按行标色放在哪**：文字用 `lineTones` 数组（按 `\n` 切行，`null` = 默认），表格用 `toneColumn`（一列的值就是语气名），而不是每行一个数组——这样分页的表、数据文件输出也成立。多出的项、写错的列名内核不报错，外壳按默认处理。
2. `LineTone` 比计划多一个 `warning`；`Tone`（旧的三值）没动，免得外壳的 `Record<Tone,…>` 要改。
3. **`lines: true` 时超时不抛错**，返回 `stopped: "timeout"` 和已有的行（服务器命令要看到超时前的输出）；不带 `lines` 的旧行为不变。
4. **部分输出由插件推**（`runs.partial`），内核不自动把程序输出变成部分输出：输出的样子（表或文字、列名）是插件的事。只在内存、不写库、不审计；按声明的输出类型检查；不接受数据文件。
5. **两个路径的操作可以跨“自己的目录”和授权文件夹**（例如备份先下载到 `plugin-data/<id>/`，再复制到用户的文件夹）；每个路径各自先按原规则检查。
6. **符号链接**：新操作的最后一段不跟随（删除链接只删链接；复制链接复制成链接；覆盖一个指向外面的链接只替换链接本身）。
7. **废纸篓**：直接移进 `~/.Trash`（同名按“保留两份”起名），不用系统的 `NSFileManager trashItem`（那需要新依赖 objc），所以 Finder 里没有“放回原处”。不同卷上的文件 → `invalid/trashUnavailable`，插件可改用永久删除（二次确认）。
8. **打开、在 Finder 中显示**由工作进程直接调 `/usr/bin/open [-R] <绝对路径>`（清空环境），不经外壳、主进程——不需要外壳和主进程配合。
9. **移除授权的审计**由用户身份记（`plugin.revokeFolder`，`actor` = user），即使是插件调 `files.removeRoot` 发起的（那也总是用户在插件界面上点的）。
10. `files.find` 跳过 `.` 开头的文件夹，最多看 100000 个条目（`capped: true`）。
11. 授权文件夹本身不能 `move/trash/remove`（`invalid/isRoot`）；要“移除”它用 `removeRoot`。

## 4. 验证

本机、本工作树（`target/` 只在这里一份）：

- `cargo test --workspace`：全部通过（含新的 `tests/round17.rs` 10 个、单元测试 2 个）。
- `pnpm clippy`：通过（警告即失败）。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`（vitest）：78 个文件、767 个测试通过。
- `sh scripts/gen-types.sh --check`：最新。
- **没运行**：`pnpm e2e`（Playwright）、完整的 `pnpm check`（其中的 e2e 部分没跑）、真机 `pnpm start` 手动试 `files.open/reveal`（只用日志记录器测过；`Opener::system()` 没有自动测试）。真的 `~/.Trash` 一次都没用过。

## 5. 范围外（发现但没改）

- `round17-plan.md` §3 说 `files.*` 已有 copy、move、remove、open，实际没有（见 §1）；插件会话若按计划以为已有，请改照 `round17-protocol.md`。
- 外壳要做的：`pick-folder` 带 `replace` 时调 `plugin.replaceFolder`；运行中读 `Run.partial` 并在 `run:<id>` 时重取；`lineTones`/`appearance`/`toneColumn`/`lineColumn` 的显示；新原因码 `intoItself`、`isRoot`、`trashUnavailable`、`notFound/grant` 的文字。
- 测试会话：e2e 启动工作进程时请设 `ONEDESK_TRASH_DIR`（临时目录，且与测试文件同卷）和 `ONEDESK_OPEN_LOG`，否则 `files.trash` 会进真的废纸篓、`files.open` 会真的打开（内核源码里指向 `~/.Trash` 的只有 `default_trash_dir()` 一处）。
- `decisions.md` 需要主会话为 §3 的决定编号（我没有改它）。

## 6. 第二批（协调会话补充的项，提交 f6fe796，先快进合并了 `claude/onedesk-r17` 的 c8eb5d7）

| 项 | 内容 | 测试 |
|---|---|---|
| D428 | `confirm` 加 `choices`（`ConfirmChoice { id, label?, danger? }`，1–8 个）、`choiceArg`（外壳默认 `conflict`）、`irreversible`；插件命令可以返回指向**本插件自己命令**的 `confirm`（之前一律拒绝），否则 `pluginError`；内核的 `run.delete`、`deleted.purge` 带 `irreversible: true` | `round17.rs` `d428_confirm_choices…` |
| D429 | 清单页面动作 `command`（与 `action` 二选一，`actionAndCommand`、`unknownCommand`）；`ActionDecl.command` 为全名 | 同上；`manifest` 单元测试 |
| Basic | `{{secret:名|basic:用户}}`、`{{secret:名|base64}}`，内核自带 base64（无新依赖）；编码后的值也抹除；不认识的写法 `invalid/badSecretFormat` | `secrets` 单元测试；`round4.rs` 对本地服务器核对实际请求头 |
| `~/` | `searchPaths` 接受 `~/`；`searchPaths` 找到的程序所在位置（含上级文件夹）属于他人或他人可写时不用：`unsafeLocation`（补第十五轮审查 #15） | `process` 单元测试（不碰真的家目录里的程序） |
| writeText | `executable`、`conflict`（不给 = 照旧替换） | `x18_write_text_can_make_executables…` |
| 时长 | `process.run`、`transfer.capture` 上限 2 小时（默认不变） | `process` 单元测试 |

- 文件接口名：按协调会话的要求**保持第一版的名字**，曾短暂加过的 `createFolder/addFolder/renameFolder/removeFolder/onConflict` 已全部去掉（没有提交过）。`files.addRoot()`、`replaceRoot()` 返回 `null`。
- 外壳文件只动了两行（协调会话同意）：`en-US.ts` 与 `kernel-texts.ts` 的 `reason.unsafeLocation`。
- 验证：`cargo test --workspace`、`pnpm clippy`、`pnpm lint`、`pnpm typecheck`、`gen-types --check` 通过。`pnpm test`：920 过、4 个失败，全在 `plugins/_testing/lang-check.test.ts`（中日语言包缺 11 个键：10 个是外壳本轮新加的 `confirm.choice.*`、`kernel.error.*` 等，1 个是我的 `unsafeLocation`）。合并前集成分支上就缺那 10 个，译文归测试会话。e2e 没跑。
- 范围外：`plugins/_testing/view-check.ts` 还不认识 X10 的新字段和 D429 的 `command`（测试会话的文件）；外壳要为清单原因 `actionAndCommand` 和 `invalid/badSecretFormat` 配文字。

## 7. 第三批：D430（提供树节点的菜单、拖动、可放入）

- 先合并了 `claude/onedesk-r17` 的最新提交。`PNode` 加 `menu`、`draggable`、`accepts`（之前 `deny_unknown_fields`，带这些键的整批会失败）；提供树按 3.8 节校验后透传，非法命令丢掉并写一次工作进程标准错误里的警告。资源类型的子节点接受但忽略。
- 测试：`round17.rs` `d430_provided_nodes_carry_…`。检查同第二批（`cargo test`、clippy、lint、typecheck、gen-types 通过；vitest 只有中日语言包那 4 个旧失败）。
- 范围外：“插件警告”目前只写到标准错误，界面上看不到；若要在插件页显示，需要协议加字段（主会话决定）。

## 8. D431：运行记录树根层“已保留结果”在前

- `runs.rs` 根层顺序改为 `@runs:saved`、`@runs:recent`；`tests/round3.rs` 的顺序断言一起改。`cargo test --workspace`、clippy、lint 通过。
- 范围外：`e2e/round16.spec.ts:278` 还断言旧顺序 `["Recent runs", "Saved results"]`，需测试会话改成新顺序（e2e 没跑）。

## 9. 第十七轮审查的修复（#1、#2、#3、#5、#6、#10、#13、#14、#16，D432，D433 的 `|url`）

先合并了集成分支 `abe9fb4`。每条都补了测试；`round17.rs` 里新的 `review1/2/3/5/16` 和改过的 `d430` 测试，**放到修之前的代码上跑 6 个都失败**（用临时工作树核对过），修之后都通过。

| # | 修法 | 测试 |
|---|---|---|
| 1 | `open`/`reveal` 只用于授权文件夹（自己的目录 → `outsideGrant`）；解析真实路径后再核对授权；`open` 拒绝可执行文件与会被系统执行的扩展名（`unsafeOpen`）；打开真实路径 | `review1_open_never_runs_anything…` |
| 2 | (dev, ino) 相同时 `move` 直接改名、`copy` 报 `intoItself` | `review2_a_case_only_rename…`（卷不分大小写时才有意义；本机是） |
| 3 | `overwrite` 的目标、`move` 的源、`trash`、`remove` 是授权根或含授权根 → `isRoot`；自己的目录同样 | `review3_overwrite_remove_and_trash…` |
| 5 | 按行模式只扫新字节；64 KB 无换行就切一行 | `review5_output_without_newlines…` |
| 6 | 组可写只允许组 0；链接本身所在的各层也查；执行真实路径 | `process` 单元测试 |
| 10 | 父文件夹钉住后用 `renameatx_np(RENAME_EXCL)`、`mkdirat`、`openat(O_EXCL)`、`symlinkat`、`unlinkat` | `files` 单元测试 `review10_…` |
| 13 | 工作进程的两个测试变量只在 `ONEDESK_TEST_HOOKS=1` 时生效 | 工作进程单元测试 `review13_…` |
| 14 | 提供树菜单里只留 `node.open` | 改过的 `d430_…` |
| 16 | 多行密钥按行再抹；`toneColumn`/`lineColumn` 核对列；stdout/stderr 顺序近似写进协议 | `review16_…`、`secrets` 单元测试 |
| D433 | `{{secret:名|url}}` 百分号编码 | `secrets` 单元测试 |

- 外壳文件只加了 `reason.unsafeOpen` 的英文（`en-US.ts`、`kernel-texts.ts` 各一行）。
- 验证：`cargo test --workspace`、`pnpm clippy`、`pnpm lint`、`pnpm typecheck`、`gen-types --check` 通过；`pnpm test` 只有中日语言包那 4 个旧失败。e2e 没跑。
- 留下的：删除**文件夹**时内部仍按路径删（标准库 `remove_dir_all`，它自己不跟随链接，但顶层父目录在检查与删除之间被换掉的窗口没有完全关上）；复制文件夹时顶层是钉住的，里面的层按路径复制到本次新建的文件夹里。
- 给测试会话：e2e 启动工作进程要加 `ONEDESK_TEST_HOOKS=1`，否则 `ONEDESK_TRASH_DIR`、`ONEDESK_OPEN_LOG` 不生效。

## 10. “移到废纸篓”在真机上不能用：原因与修法

- **原因（已确认，没碰真的废纸篓）**：本会话里对 `~/.Trash` 只做了 `open(O_RDONLY|O_DIRECTORY)`（加不加 `O_NOFOLLOW` 都一样）和 `listdir`，都得到 **`EPERM`（Operation not permitted）**；`lstat` 正常（`drwx------`，属于当前用户，`st_dev` 16777231，与授权文件夹同一卷）。属主是自己、权限 0700 却得到 `EPERM` 而不是 `EACCES`，是 macOS 隐私保护（TCC）在拦：没有“完全磁盘访问”的进程不能读 `~/.Trash`。原实现 `trash()` 先 `Pinned::new(<废纸篓>/<名字>)`，也就是打开 `~/.Trash`，失败后被 `map_err(|_| trashUnavailable)` 报成了“另一个磁盘”。正式使用时对所有没给完全磁盘访问的用户都不能用。
- **修法**：正式路径改为 `NSFileManager trashItemAtURL:resultingItemURL:error:`（不需要打开 `~/.Trash`，与 Finder 相同，可放回原处）；原来的改名实现只在 `KernelConfig.trash_dir = Some(..)` 时用，也就是工作进程在 `ONEDESK_TEST_HOOKS=1` 下读到 `ONEDESK_TRASH_DIR` 时。错误按 3.3 节映射：权限问题为 `denied/trashDenied`，不再报成“另一个磁盘”。
- **新依赖（规则 9）**：
  - 用途：调用 `NSFileManager trashItemAtURL:`。
  - 加的是 `objc2 = "0.6"`（锁定 0.6.5，MIT）与 `objc2-foundation = "0.3"`（锁定 0.3.2，MIT），后者关掉默认特性，只开 `std`、`NSFileManager`、`NSURL`、`NSError`、`NSString`。这样引入的子依赖只有 `objc2-encode` 4.1.0（MIT）、`bitflags` 2.13.2（MIT OR Apache-2.0）、`libc`（MIT OR Apache-2.0，原来就有）；`objc2-exception-helper`、`block2`、`objc2-core-foundation`、`objc2-proc-macros` 都是可选的，没开。**这些包原来都已在 `Cargo.lock` 里（Tauri 用它们）**，`Cargo.lock` 只多了内核包对这两个名字的引用，没有新包。
  - 替代方案：`trash` crate（同样调这个系统接口，但会多带 `log`、`once_cell` 等，也做跨平台我们用不到）；自己用 `objc_msgSend` 写 FFI（不安全代码更多）；调 `/usr/bin/osascript` 让 Finder 删（会弹出自动化授权，而且慢）；继续自己改名（就是现在的问题）。
- **测试**：`files` 单元测试 `round17_trash_errors_say_what_happened`（不许打开的废纸篓文件夹 → `trashDenied`；不存在 → `trashUnavailable`；系统错误码的映射）；`round17.rs` 里原有的废纸篓测试仍走测试用的文件夹；工作进程单元测试改为默认 `None`。真接口只有一条 `#[ignore]` 的手动测试 `system_trash_moves_a_temporary_file_into_the_trash`（把临时目录里的一个测试文件移进真的废纸篓），要手动跑：`cargo test -p onedesk-kernel --lib -- --ignored system_trash`。**用户 2026-11-21 在主仓库里手动运行，通过**（1 passed）。
- 外壳文字：只加了 `denied.trashDenied` 的英文（`en-US.ts`、`kernel-texts.ts` 各一行）。
- 验证：`cargo test --workspace`、`pnpm clippy`、`pnpm lint`、`pnpm typecheck`、`gen-types --check` 通过；`pnpm test` 只有中日语言包那 4 个旧失败。

## 11. D435：动作返回 `failed`，失败但保留输出

- 先合并了集成分支 `f90d120`。`ActionOut` 加 `failed: { message }`（同样 `deny_unknown_fields`），`output` 在有 `failed` 时可省（用最后一次 `runs.partial`）。状态 `error`、`error.code = "pluginError"`，`message` 抹密钥、截到 2000 字符；`output`、`summary` 照常检查并保存。
- 测试：`round17.rs` `d435_a_failed_run_keeps_its_output_summary_and_history`（状态、码、抹除与截断、`summary`、`output`、`run.rows`、`run.render`、`run.listFor`、只有 `failed` 时用部分输出、没有 `failed` 时缺 `output` 仍报 `badOutput`）。旧代码里 `failed` 是未知键，这类运行会以 `badOutput` 结束。
- 验证：`cargo test --workspace`、`pnpm clippy`、`pnpm lint`、`pnpm typecheck`、`gen-types --check` 通过；`pnpm test` 只有中日语言包那 4 个旧失败。e2e 没跑。
