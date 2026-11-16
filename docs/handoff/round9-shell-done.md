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
