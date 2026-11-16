# 第九轮外壳：完成记录

分支 `claude/r9-shell-054169`（不推送、不合并）。

## 改了什么
1. **清单缓存（主进程）**：新增 `crates/host/src/index.rs`。`Host::start`（内置插件复制之后）和每次 `rescan` 之前（安装、移除）刷新 `plugins/.index`；devhost 走同一个 `Host::start`，所以同样。格式照计划 §3：`{version:1, entries:[{dir,mtime(ms),size,manifest}|{dir,mtime,size,error:"unreadable"}]}`，按 `dir` 排序，写临时文件 `.index.tmp` 再改名；内容没变时不写。`plugins/` 下以 `.` 开头的目录（`.tmp`、`.removed`）跳过。缺失/坏/`version` 不认识 → 全部重读。刷新失败只打一行 stderr，并删掉旧 `.index`（过期的缓存比没有更糟）。主进程不解释清单内容。
2. **`src-tauri/build.rs`**：占位不再是空文件盖掉真工作进程——`target/<profile>/onedesk-worker` 已存在且非空时，占位就是它的副本（Tauri 复制后内容不变）。没有真工作进程时仍写空占位（保证 clippy 不需要先跑 `prepare-bundle.sh`），之后 `cargo build -p onedesk-worker` 会重新链接出真文件。
3. **`tree.children` 带语言**：`ProtocolClient.tree.children(tree, parent, offset, locale?)`、`loadChildren(..., locale?)`；侧栏和“设置”入口传当前语言；语言切换后侧栏已载入的各层重新读取（`locale` 进了刷新 effect 的依赖）。
4. **插件页**：显示 `runtime`（`idle`：状态区一行“未在运行，用到时自动启动。”＋顶部“未在运行”徽标；`live`：“正在运行。”；字段缺失则什么都不显示）。假数据模式里只会弹“原型里没有”的按钮（检查更新、打开插件文件夹、卸载、“安装”）隐藏；真内核模式里“授权文件夹…”本来就只在声明 `files` 时显示（有测试）。
5. **文字（英、中）**：`blockedByPolicy` 带 `layerName`（含与 `program`/`host` 的组合）、`outsideGrant` 带 `path`、`staleContext`、审计结果 `cancelled`/`timeout`（含筛选项）、`plugin.idleBadge/runtimeLive/runtimeIdle`；进度的 `fraction` 只有是数字才显示百分比（状态栏、任务面板、结果区）。

## 测试结果（全部实际跑过）
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（40 文件 341 例）通过。
- `cargo test -p onedesk-host`：22 单元（含 9 个 `index`）+ 20 集成通过；`cargo clippy -p onedesk-host --all-targets -- -D warnings` 通过。
- 删掉 `src-tauri/binaries/`、`target/debug/onedesk-worker` 后 `cargo build -p onedesk-worker -p onedesk-host && cargo clippy --workspace --all-targets -- -D warnings`：通过，`target/debug/onedesk-worker` 仍是 34 MB 可执行文件。反过来（先 clippy 再构建工作进程）也得到真文件。**没有**跑完整的 `pnpm check`。
- `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts`：22 过、1 跳过、1 失败（“drag onto a group”，已知的负载下偶发，`todo.md` 已记；单独重跑通过）。跑完已 `git checkout -- docs/screenshots`。注意：这次跑完 env/sql/tasks/plugin 的截图文件有变动——plugin 的变化是预期的（假数据模式下按钮隐藏了），其余几张我没逐张比对，原因未查（可能只是抗锯齿）。
- 1 万个包（临时目录，debug 构建，APFS）：首次刷新约 4.2 s（读 1 万个清单），**第二次刷新 2.4 s、读清单 0 个**（时间花在列 2 万个目录和 1 万次 stat，不是读文件）；release 构建 3.6 s / 2.2 s。启动时的目标是“不开清单”，这个达到了；如果要更快，只能不 stat（改成只比对目录的修改时间），我没做。

## 假设（等内核合并后要对）
- `tree.children` 参数名 `locale`，值是外壳的 `"en-US"` / `"zh-CN"`（和 `ctx.locale` 对不对要看内核）。
- `PluginDetail.runtime?: "live" | "idle"`、审计结果 `"cancelled"`/`"timeout"` 现在是外壳的本地类型（`protocol/types.ts`、`audit-page.tsx`）；生成类型有了以后可以删。
- 内核读 `.index` 时的格式按计划 §3 一字不差；`.index` 里 `dir` 用 `/` 分隔。我写 `.index` 的时机：每次 `plugin.rescan` 之前。如果内核在启动时（worker 启动，早于 `rescan`）读，需要的就是 `Host::start` 里那次刷新，已在 worker 启动前完成。
- `RunError.params` 里的名字按计划：`layerName`、`path`；文字表键 `reason.blockedByPolicy|layerName` 等。
- `staleContext` 的原因码若内核保留了别的码（见计划 §5），要在 `kernel-texts.ts` 补一条。

## 没做 / 没验证
- 没有对真内核走一遍（内核未合并）；`E2E` 只跑了假数据的 `workbench.spec.ts`。
- 没有给“没有 fraction 不显示百分比”写单独的界面测试。
- 没跑完整 `pnpm check`、`pnpm e2e`。

## 合并后对齐（协调分支 `5e466b5` 合并之后）

**类型**：`PluginDetail.runtime` / `PluginRuntime`、`TreeChildrenParams.locale` 已在生成类型里，外壳的本地 `runtime` 类型已删。`AuditResult` 生成类型**仍只有** `ok | denied | error`，所以外壳里 `cancelled`/`timeout` 的本地放宽保留（见下面缺陷 1）。原因码/参数名与 `round9-kernel-done.md` 一致：`staleContext`、`layerName`、`path`；`kernel-texts` 测试通过（352 例）。

**对着真内核走了一遍**（devhost：`ONEDESK_SECRET_STORE=memory`、`ONEDESK_PLUGIN_IDLE_MS=3000`、数据目录在会话 scratchpad、本机传输服务器；用一个临时 Playwright 脚本驱动，脚本留在 scratchpad，没有提交）：
- `plugins/.index`：启动后存在，条目（5 个）与 `plugins/` 下的包逐项一致；删掉后重启重建；装 keeper、再装 transfer 后各多一条，仍与包一致。✔
- keeper：打开页面并 `remember` 后插件页“正在运行。”；不操作几秒后**自己**变成“未在运行，用到时自动启动。”＋“未在运行”徽标；改了文本再点 `recall` 自动激活，`remember` 的内容还在，`runtime` 回到 `live`；`slow`（20 秒）期间每 0.5 秒查一次 `runtime`，一直是 `live`。✔
- 插件页：没有“检查更新”“打开插件文件夹”，keeper 没声明 `files`，没有“授权文件夹…”。✔
- 切换界面语言（命令面板）：市场树节点“Local packages”→“本地插件包”，keeper 树节点“Keeper node (en-US)”→“保管员节点（zh-CN）”，不用刷新页面。✔
- transfer：`/nolength/1500000000` 下载时状态栏“WJob 1 — 239206400 bytes”、任务面板“… 1269694464 bytes”，都没有百分号；`network.allow` 拒绝的文字“The setting of “Workspace” (network.allow) does not allow the address “127.0.0.1:61386”.”；路径在授权外的文字里有完整路径。✔
- 被取消的 `/slow` 下载在库里有 `cancelled` 审计行。✔（界面显示见缺陷 1）
- `stash` 后点 `abuse`：被拒，页面提示的文字是“denied”（不是 `staleContext` 的文字），见缺陷 2。✘（按要求的文字没出现）

**build.rs 在合并后的树上**：删掉 `src-tauri/binaries/` 和 `target/debug/onedesk-worker` 后 `cargo build -p onedesk-worker -p onedesk-host`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test -p onedesk-host`（22 + 20）全过，`target/debug/onedesk-worker` 是 34 MB 的可执行文件。✔

**缺陷（不是我的文件，没改）**
1. 内核：`audit.list` 把库里 `result = 'cancelled'`（以及预计的 `timeout`）的行显示成 `error`（审计页上是红色“出错”）。复现：装 transfer 夹具、授权文件夹、`network.allow` 放行本机服务器，下载 `/slow/20` 后 `run.cancel`，库里是 `transfer.download|cancelled`，`audit.list` 给 `result: "error"`。要让外壳的“已取消/已超时”标签生效，需要把 `AuditResult` 加上 `cancelled`、`timeout` 并让列表原样给出（外壳已按这两个值写好，筛选项也有）。
2. 夹具 `com.example.keeper`（`plugins` 与测试会话）：`abuse` 返回 `String(err.message)`，而宿主调用的拒绝错误的 `message` 只有 `denied`，原因在别的字段里（`reason`），所以页面上看到的是“denied”而不是原因。夹具应返回 `err.reason`（或整个错误），才能在界面上看到 `staleContext`。`staleContext` 的文字本身有单元测试（`kernel-texts.test.ts`）。
3. 夹具说明：`stash` 存下来的 `ctx.host` 放在模块变量里，运行环境空闲释放后变量就没了（`abuse` 回“没有保存句柄”）。所以 `abuse` 必须在 `stash` 之后空闲时长内点；验收脚本要注意。

**检查**：`pnpm typecheck`、`pnpm lint`、`pnpm test`（41 文件 352 例）通过；假数据模式 `E2E_PORT=1433 … workbench.spec.ts`：23 过、1 跳过、0 失败（这次连偶发的拖动用例也过了），跑完已 `git checkout -- docs/screenshots`。

## 审查后的修改（`round9-review.md` 中处理人含“外壳”的条目）

- **#1（界面一半）**：`audit-page.tsx` 去掉本地 `ResultCode` 和 `as` 强转，直接用生成的 `AuditResult`（合并后已含 `cancelled`、`timeout`）；筛选下拉的两个新选项因此是内核认得的值。新增 `src/workbench/pages/audit-page.test.tsx`：列表里的 `cancelled`/`timeout` 显示为“Cancelled”/“Timed out”，不并进“Error”。
- **#3（D371）**：`index::refresh(plugin_root, builtin)` 多了内置包列表（`<id>@<version>`）；列表里的包每次都重读磁盘上的清单，不沿用缓存；`Host::start` 和每次 `rescan` 前都传主进程记着的内置列表（被用户移除的版本不在其中）。测试 `builtin_manifests_are_always_read_from_disk_not_taken_from_the_cache`：缓存里两个包的清单都被改写、磁盘没动（修改时间和大小不变）；刷新后内置那个恢复成磁盘上的内容（读了 1 个），另一个按原规则沿用缓存（与直接改 `plugins/` 同等风险，D371 如此）。
- **#8**：临时文件名改为 `.index.tmp-<进程号>-<序号>`，刷新用一把进程内的锁串行化；改名失败时只删自己的临时文件，不动 `.index`（并把错误交给调用方，调用方会删掉可能过期的 `.index` 并让内核直接扫描）。测试 `concurrent_refreshes_each_leave_a_valid_index_and_no_temporary_file`（8 个线程各刷新 5 次）；原有“残留临时文件不影响”的测试改用新名字。
- **#9（`build.rs`，核实后的结论）**：
  - 缺 `rerun-if-changed`：确实会让替身滞后于重新链接出来的工作进程。现在真工作进程存在时输出 `rerun-if-changed` 指向它（并显式列出 `build.rs`、`tauri.conf.json`、`capabilities`，因为一旦有了这类指令 cargo 就不再默认监视整个包）；不存在时不输出，保持默认。
  - 会不会因此每次都重跑：不会。实测 Tauri 在内容相同时不写目标文件（修改时间不变），我们自己只在内容不同时才写替身。验证：连续两次 `cargo check -p onedesk`，第二次不再编译 `onedesk`；`touch crates/worker/src/main.rs` 后 `cargo build -p onedesk-worker` 重新链接，再 `cargo check -p onedesk` 会重跑 build.rs，`cmp` 证明替身与新工作进程字节相同；再跑一次又不重跑。
  - 并行窗口：只剩一种——同一次 cargo 调用里，`onedesk-worker` 的链接恰好发生在 `onedesk` 的 build.rs 复制替身和 Tauri 把替身复制回去之间的几毫秒；这时旧内容会盖掉新链接的文件。无法在不让 `src-tauri` 依赖工作进程的前提下彻底消除（那样会改依赖图）；发生后下一次 `cargo build -p onedesk-worker` 不会自动修复（cargo 认为它是新的），要 `touch` 工作进程的源码或删掉 `target/debug/onedesk-worker` 重建。日常用法（先构建工作进程再检查/构建界面，或 `pnpm check` 的串行步骤）不触发。我没能构造出这个窗口来复现，所以这一条是推理加上述实测，不是复现出来的。
  - `tauri build --debug`：`beforeBuildCommand` 先跑 `scripts/prepare-bundle.sh`，把当时的工作进程复制成侧载文件，所以打包用的不会是旧的。我没实际跑 `tauri build`。

**这一节的检查**（删掉 `src-tauri/binaries/` 和 `target/debug/onedesk-worker` 后重来）：构建、全工作区 clippy 通过，`onedesk-worker` 仍是 34 MB 可执行文件；`cargo test -p onedesk-host` 24 单元 + 20 集成通过；`pnpm typecheck`、`lint`、`test`（42 文件 353 例）通过。没有重跑假数据 `workbench.spec.ts`（本节只动了审计页的类型和主进程）。
