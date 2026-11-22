# 第十九轮：MCP（让外部 AI 客户端只读使用 OneDesk，K11）

依据：`docs/redesign/ai-interface.md`（D415，用户已确认）、D447、D448、`v1-plan.md` 第 19 行。协调分支 `claude/onedesk-coord-7`（已含第十八轮，main `c6c4448`）。

## 1. 做完是什么样

- 命令行程序 `onedesk-mcp`（说 MCP 的标准输入输出，不开端口）：应用开着就连主进程；没开就自己起无界面工作进程，用完退出；启动参数指定一个工作区，默认是默认工作区。
- 内核：操作者 `ai`；通用工具 `search`、`describe`、`run`、`get_run`；插件工具 `aiTools`（名字带插件前缀、JSON Schema 校验）；`mcp.policy`（总开关默认关、每分钟上限、行数上限、允许自由查询）；审计（工具名、参数摘要、行数、耗时、成败，可按操作者 `ai` 过滤）；一切写入类请求对 `ai` 一律拒绝。
- 外壳：信息面板“对 AI 可见”开关（含分组“含下级”）、工作区 AI 设置页（`mcp.policy`、AI 用的环境）、审计页按操作者过滤、一段给用户复制到 Claude Desktop 配置里的说明（路径来自 `.app`）。
- 插件：SQL、查询目录、表插件声明 AI 可用的只读动作和 `aiTools`（`list_tables`、自由查询 `run_sql`，默认关）。
- 内核源码里不出现具体插件名；新增禁用词 `mcp`（仅内核与协议里作为插件名时不允许……见 §3 tests 会话判断，`pnpm lint` 要过）。

## 2. 内核要补的（协议名字先写进 `round19-protocol.md`，内核会话**第一次提交就写**）

`Actor::Ai`、`ai_visible` 迁移（D448①，迁移只增）、清单 `ai`/`aiTools` 字段、`mcp.*` 命令（建议：`mcp.search`/`mcp.describe`/`mcp.run`/`mcp.getRun`/`mcp.tools`，名字由内核会话定）、策略与限流、审计字段、错误码、截断、无界面工作进程的启动方式（`crates/worker` 已是独立进程，确认能无窗口使用）、Rust 测试（每条拒绝、限流、行数截断、`ai_visible=0` 搜不到也读不到、密钥值不出现）。

## 3. 分工

| 会话 | 模型 | 做什么 | 允许修改 |
|---|---|---|---|
| `r19-kernel` | Opus | §2；第一次提交写 `round19-protocol.md` | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增）、生成的 TS、`round19-protocol.md`、`round19-kernel-done.md` |
| `r19-mcp` | Opus | `onedesk-mcp` 程序（MCP 协议的标准输入输出、连主进程的本机套接字并按用户校验、无界面启动）、打包进 `.app`、给用户的配置说明 | 新 crate `crates/mcp/**`、`crates/host/**`、`src-tauri/**`（打包配置）、`Cargo.toml` 的 workspace 成员、`round19-mcp-done.md` |
| `r19-shell` | Sonnet | 外壳：AI 可见开关、AI 设置页、审计过滤、复制配置说明；文字只加英语；`protocol/mock` 同步 | `src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`round19-shell-done.md` |
| `r19-plugins` | Sonnet | SQL、查询目录、表插件的 `ai` 声明与 `aiTools`；`locales/`；vitest | `plugins/org.onedesk.sql/**` 及其它相关内置插件（先看哪些有“查询/表”）、`round19-plugins-done.md` |
| `r19-tests` | Sonnet | 第一阶段：`scripts/check-arch.mjs` 的新禁用词（只此会话改）、假 MCP 客户端夹具（标准输入输出，放 `e2e/_mcp/**`）；第二阶段：`e2e/round19.spec.ts`（每个工具、每条拒绝、限流、截断、审计、`ai_visible`），中日译文 | `e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`plugins/org.onedesk.lang.*/**`、`docs/screenshots/`、`round19-tests-done.md` |

规则同前几轮：一个文件同一时间只有一个写入者；会话间只通过 `docs/handoff/` 交流；范围外问题写进各自 done 文件的“范围外”；协议名字以 `round19-protocol.md` 为准，要改先问协调会话。Rust 构建一律 `CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target`，只有内核会话在自己工作树里建 `target/`。

## 4. 安全与测试底线

- 默认全关；`ai` 操作者永远不写、不读密钥值；结果在离开内核前按策略截断；密钥靠 `{{secret:…}}` 只在宿主代入，审查专门查。
- 自动测试不联网。假 MCP 客户端连真内核跑；人工验收用 Claude Desktop 或自写的最小客户端，只读、不花钱（MCP 本身不调 AI 服务商）。

## 5. 完成标准

完整 `pnpm check` 通过；`round19.spec.ts` 无 `test.fixme`；每个工具、每条拒绝都有“修之前失败”的测试；之后协调会话：集成分支 `claude/onedesk-r19` 合并 → 对齐 → 独立审查（`round19-review.md`，只读 Opus）→ 第二阶段 e2e → 亲自验收（真内核 + 最小 MCP 客户端，应用开着和没开两种）→ 完整检查 → `round19-acceptance.md` → 经用户同意合并 main。
