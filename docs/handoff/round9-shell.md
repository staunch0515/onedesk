# 任务：第九轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round9-plan.md` 里定死的名字写（协议类型合并后才生成，先在外壳里按可选字段和本地类型写），假实现补上对应数据。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round9-plan.md` §7 外壳一行）
1. 清单缓存的主进程一半（§3）：`crates/host` 里维护 `plugins/.index`（格式定死），启动时、安装或移除之后、`rescan` 之前刷新；devhost 同样。测试见计划 §8“主进程必须有的测试”（含 1 万个包的读文件计数与实测耗时）。
2. `src-tauri/build.rs` 的空占位不再盖掉真的工作进程（§6 外壳第一条）：全新工作树里 `pnpm check` 不需要先跑 `prepare-bundle.sh`。改完自己验证：删掉 `src-tauri/binaries/` 和 `target/debug/onedesk-worker` 后 `cargo build -p onedesk-worker -p onedesk-host && cargo clippy --workspace --all-targets -- -D warnings`，`target/debug/onedesk-worker` 仍是可执行的真文件。
3. `tree.children` 带当前语言，语言切换后重取树。
4. 插件页：`PluginDetail.runtime`（`live` / `idle`）的显示；还没实现的按钮隐藏；没声明 `files` 的插件不显示“授权文件夹…”。
5. 文字（英、中）：`layerName`、`path` 进错误文字；没有 `fraction` 的进度不显示百分比；`staleContext`；审计结果 `cancelled`、`timeout`。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round9-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round9-plan.md`、`docs/decisions.md` D363–D368、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。主进程里不写插件名字。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round9-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round9-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
