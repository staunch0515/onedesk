# 第二十轮：发布收尾（完成版 v1.0）

依据：`docs/redesign/v1-plan.md` §2 第 2–4 条与第 3 节第 20 行、D452。协调分支 `claude/onedesk-coord-7`（已含 main `175d3f1`，第十八、十九轮）。

## 1. 做完是什么样

1. **能装能用**：`pnpm tauri build`（或等价脚本）打出的 `.app` 从 Finder 双击能启动；版本 1.0.0；本机自签名；首次启动有欢迎页；任何已发布迁移版本的库升级到最新都能打开（升级测试）；工作进程崩溃后自动重启（在 `.app` 里验证）；`onedesk-mcp` 在 `.app` 里的路径正确（`app.mcpInfo`）；MCP 应用开着时的真套接字路径验过。
2. **质量**：完整 `pnpm check` 通过且完整 e2e 在高负载下不再偶发失败（第十九轮留的脆弱点）；`todo.md` 分诊完，影响日常使用的 1.0 前清零，其余进 `post-1.0.md`；浅色/深色 × 中/英/日各主要页面都看过并修了问题。
3. **sqlpool 90 项逐行验收**：`sqlpool-parity.md` §3 每行在真运行的 OneDesk 里做一遍（用同一份查询目录、同一个 PostgreSQL，结果行与 sqlpool 一致），结果“通过/不通过/按新需求改了”，写进 `round20-parity.md`。
4. **文档**：用户手册（安装与首次打开、数据目录、备份与恢复、数据源、查询目录、AI 设置、MCP 在 Claude Desktop 里的配置）、`plugins/README.md` 补全。

## 2. 分工

| 会话 | 模型 | 做什么 | 允许修改 |
|---|---|---|---|
| `r20-package` | Opus | §1 第 1 条：版本号、打包脚本、自签名、欢迎页、迁移升级测试、崩溃重启在 `.app` 中验证、`.app` 冒烟脚本（启动、窗口、`onedesk-mcp`、插件齐全） | `src-tauri/**`、`crates/host/**`、`scripts/prepare-bundle.sh` 及新打包脚本、版本号（`package.json`、各 `Cargo.toml`）、`round20-package-done.md` |
| `r20-parity` | Opus | §1 第 3 条：逐行验收 90 项；发现缺陷写进 `round20-parity.md` 的“缺陷”表（行号、复现、归属），**不自己改内核/插件/外壳**，由协调会话派 | 只读源码；可新增 `e2e/parity/**` 脚本与证据（截图/日志放 `docs/screenshots/parity/`）；`round20-parity.md` |
| `r20-polish` | Sonnet | §1 第 2 条：先写 `round20-todo-triage.md`（逐条判“1.0 前/1.0 之后”并给理由，发协调会话看一眼），再修外壳与插件范围的 1.0 前项；浅深 × 中英日逐页截图检查，修界面文字与布局问题；内核范围的项列出来交协调会话派 | `src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`plugins/**`（`_testing` 除外）、`docs/handoff/post-1.0.md`、`round20-todo-triage.md`、`round20-polish-done.md` |
| `r20-docs` | Sonnet | §1 第 4 条：`docs/manual/**`（中文，附英文摘要页）、`plugins/README.md` | `docs/manual/**`、`plugins/README.md`、`round20-docs-done.md` |
| `r20-tests` | Sonnet | 让完整 e2e 在高负载下稳定（查 `round12` http、`week1` files dark、`round14` D5 截图、`round19` 外壳开关这类偶发；拆重截图用例、调 worker 数、改等待写法，**不靠加长超时糊过去**）；`.app` 冒烟的 e2e 或脚本接 `r20-package`；最后跑完整检查给我数据 | `e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`round20-tests-done.md` |

规则同前几轮：一个文件同一时间只有一个写入者；会话间只通过 `docs/handoff/` 交流；范围外的问题写进各自 done 文件“范围外”；内核需要改动由协调会话派（`r20-kernel` 若需要再开）。Rust 构建用 `CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target`；磁盘有限（剩约 21G）：打包会占几个 G，用共享 `target/`，不要在自己工作树建。

## 3. 安全与底线

不调真实 Anthropic（D447：真实验收由用户在 `.app` 打出后自己填密钥）；不动用户的钥匙串和 `~/Library/Application Support/onedesk*`（测试用临时数据目录 + `ONEDESK_SECRET_STORE=memory`）；不 `git push`、不合并 main。

## 4. 完成标准

完整 `pnpm check` 通过；`round20-parity.md` 90 行每行有结论；`todo.md` 分诊完；`.app` 冒烟通过；文档齐。之后协调会话：集成分支 `claude/onedesk-r20` 合并 → 缺陷派发 → 独立审查（`round20-review.md`）→ 亲自验收（用 `.app`）→ 完整检查 → `round20-acceptance.md` → 经用户同意合并 main，打 `v1.0.0` 标签（标签推送也需用户同意）。
