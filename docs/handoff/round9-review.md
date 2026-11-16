# 第九轮独立审查（只读的 Opus 子代理，2026-11-16；协调会话整理）

范围 `git diff a9c84fa..5e466b5`。每条修改都要补测试；处理结果写进各自 `round9-*-done.md` 的“审查后的修改”一节。

| # | 级别 | 问题 | 位置 | 处理人 | 处理 |
|---|---|---|---|---|---|
| 1 | 必须修 | 审计结果 `cancelled`/`timeout` 在 `audit.list` 里被映射成 `Error`，又不满足 Error 的筛选条件，任何筛选都选不到；外壳下拉新加的两个选项会被内核按 `AuditResult` 拒绝；外壳用 `as ResultCode` 强转掩盖了问题。 | `crates/kernel/src/round2.rs:543-547,616-620`、`carry.rs:125,205`；`src/workbench/pages/audit-page.tsx:11-13,72` | 内核＋外壳 | D369：`AuditResult` 只增 `cancelled`、`timeout` 两个值，列表与筛选都认；外壳去掉强转，用生成的类型 |
| 2 | 只记录 | 共享 promise 的口子：页面/事件的代码 await 一个由运行 A 去 resolve 的 promise 后，后续代码以 A 的身份执行，可用存下来的 A 的宿主接口；反方向会误伤（运行等页面事件 resolve 的 promise 后自己的接口被拒）。前提是 A 还在跑、同一插件自己配合。 | `crates/kernel/src/sandbox.rs:13-14,762-775` | 协调 | D370 记为已知限制，记 `todo.md`；内核补一条测试把现在的行为固定下来 |
| 3 | 应修 | 伪造的 `.index` 比直接改 `plugins/` 更糟：主进程只比修改时间和大小，相同就沿用缓存里的清单原文；内置插件的版本自动确认清单里的全部权限，伪造的内置清单能一直留着、权限被静默放大。 | `crates/host/src/index.rs:100`、`crates/host/src/plugins.rs`；`crates/kernel/src/versions.rs:139` | 外壳（主进程） | D371：内置插件的包每次刷新一律重读磁盘上的清单，不用缓存 |
| 4 | 应修 | 符号链接不一致：主进程刷新不跟随符号链接的包目录，内核直接扫描却跟随；有 `.index` 时这种包悄悄消失。 | `crates/host/src/index.rs:58`；`crates/kernel/src/manifest.rs:1207` | 内核 | 内核直接扫描也不跟随符号链接的包目录（两边一致：不认） |
| 5 | 只记录 | 运行到时间被丢弃时搬运审计记成 `cancelled`，只有网络层自己的超时记 `timeout`。 | `carry.rs:112-130` | — | 记 `todo.md` |
| 6 | 只记录 | 没被 await 的宿主调用在调用结束后仍会执行完（已有行为）；回收不计这类调用，不会挂住。 | `sandbox.rs:610-625` | — | — |
| 7 | 应修 | `tree.children` 的 `locale` 没校验；`tree.path` 仍传 `null`。 | `kernel.rs:852,928` | 内核 | `locale` 限 35 个字符内的字母、数字、`-`，否则当作没给 |
| 8 | 应修 | 两次刷新并发时共用同一个 `.index.tmp`，改名失败会删掉 `.index`。 | `crates/host/src/index.rs` | 外壳 | 临时文件名带随机后缀，或刷新串行化 |
| 9 | 待核实 | `build.rs` 没写 `rerun-if-changed`；并行构建时有窗口让替身盖掉刚链接好的工作进程；`tauri build --debug` 可能带旧的工作进程。 | `src-tauri/build.rs` | 外壳 | 核实并处理，写明结论 |
| 10 | 应修 | 测试缺口：经 `audit.list` 的审计结果；`.index` 的绝对路径和重复条目；回收与新调用同时发生；共享 promise。 | `crates/kernel/tests/round9.rs` | 内核 | 补 |

没有问题的检查点：存下来的 `ctx.host` 或单个方法从渲染、页面事件、事件处理、另一个并发运行里用都被拒，合法用法不受影响；空闲回收四个不回收条件都在，回收与调用之间不会丢运行环境或挂住，释放后事件照旧投递，环境变量只由工作进程读；主进程刷新“未变不读、变了才读、消失去掉”、损坏重建、原子写；内核拒绝 `..`、绝对路径、隐藏名、不是两段的 `dir`，id/version 与 `dir` 不符被拒；`path` 按字符截断；`RunError.detail` 只留主机；内核与主进程无插件名字，无新依赖、无新迁移，协议只增。
