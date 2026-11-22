# 第十八轮：AI（Anthropic、Ollama 与 AI 工作台）

依据：`docs/redesign/ai-plugins.md`（D426，用户已确认）、`sqlpool-parity.md` K1–K10、`round18-protocol.md`（协议名字，协调会话先定死）、D437–D440。协调分支 `claude/onedesk-coord-7`（从 main `5df3985` 切出）；各会话从它切出工作树。

## 1. 做完是什么样

- **内核**：X5 结果区动作；X6 搜索“任一词命中、按相关度、限定类型”；X15 插件接口（`implements`/`uses`/`interfaces.call`）；X16 运行中长请求（10 分钟）与流式（`stream`/`onChunk`/`idleTimeoutMs`），取消立即断开。
- **`org.onedesk.ai.anthropic`**：连接资源（名称、API 密钥进钥匙串、模型、档位、最大输出、备用模型开关、`baseUrl`）；`chat` 流式（SSE）、`models`、`test`；错误映射；拒答；只放行连接里写的主机。
- **`org.onedesk.ai.ollama`**：连接资源（地址、模型、`num_ctx`、`keep_alive`、可选认证头）；`chat` 流式（NDJSON）、`models`、`test`；本机地址明确写出才放行；载入模型的进度。
- **`org.onedesk.ai`**：K1 分析按钮、K3 预览页（可编辑、勾选参考文档、显示连接/模型/token 估算）、K4 脱敏、K2 资料索引、K6 保存分析（`run_artifacts`）、K7–K9 `generate` 动作与 SQL 插件的“用 AI 写”（提议、检查、接受）、K10 设置（默认连接、脱敏规则、文档文件夹）、`ai.policy`（off/preview/allow）、审计（不记内容）。
- **外壳**：结果区按钮（来自 `result.actions`）、运行中部分输出实时显示（文字，Markdown 可读）、预览页交互需要的节点。
- 内核源码里不出现 `ai`（作为插件名）、`anthropic`、`ollama`、`claude`、`sse`、`ndjson` 等专有词（并入 `pnpm lint` 禁用词；`ai.policy` 是插件自己的环境参数，内核不认识）。

## 2. 内核要补的（名字见 `round18-protocol.md`，内核会话第一次提交后确认）

X5、X6、X15、X16，各自的错误码、审计、Rust 测试（含取消立即断开、两块之间超时、10 分钟上限只在运行中、`runs.read` 只在被点击期间可用、没声明 `uses` 被拒、找不到实现）。

## 3. 分工

| 会话 | 模型 | 做什么 | 允许修改 |
|---|---|---|---|
| `r18-kernel` | Opus | §2；第一次提交先把 `round18-protocol.md` 里要补的细节定好 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS、`scripts/check-arch.mjs`（只加禁用词）、`docs/handoff/round18-protocol.md`、`round18-kernel-done.md` |
| `r18-shell` | Sonnet | 结果区按钮（`result.actions`）；运行中部分输出显示（含 Markdown）；预览页需要的外壳支持；新文字只加英语；假协议客户端（`protocol/mock`）同步 | `crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`round18-shell-done.md` |
| `r18-providers` | Sonnet | `org.onedesk.ai.anthropic`、`org.onedesk.ai.ollama`；`locales/`（英中日）；假 host 的 vitest；假 SSE/NDJSON 服务夹具放 `plugins/_testing/fake-ai/**`（`r18-tests` 之后复用） | `plugins/org.onedesk.ai.anthropic/**`、`plugins/org.onedesk.ai.ollama/**`、`plugins/_testing/fake-ai/**`、`round18-providers-done.md` |
| `r18-workbench` | Opus | `org.onedesk.ai`（K1–K10、`generate`、`ai.policy`、审计）；SQL 插件“用 AI 写”入口；`locales/`；vitest | `plugins/org.onedesk.ai/**`、`plugins/org.onedesk.sql/**`、`round18-workbench-done.md` |
| `r18-tests` | Sonnet | 第一阶段：`scripts/check-arch.mjs` 的禁用词（与内核会话协调：由 tests 会话只改禁用词列表之外的？——**由 tests 会话改，内核会话不改此文件**）；假服务商的 e2e 脚手架（用 `r18-providers` 的夹具，不重复造）；第二阶段（合并后由协调会话通知）：`e2e/round18.spec.ts` 按 K1–K10 逐行；外壳新键的中日译文 | `e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`plugins/org.onedesk.lang.*/**`、`plugins/_testing/**`（`fake-ai/` 之外）、`docs/screenshots/`、`round18-tests-done.md` |

规则同前几轮：一个文件同一时间只有一个写入者；会话间只通过 `docs/handoff/` 交流；范围外的问题写进各自 done 文件的“范围外”一节，不改 `todo.md`；协议新增字段以 `round18-protocol.md` 为准，需要改名字先问协调会话。磁盘有限：只有内核会话在自己工作树里建 `target/`，其他会话需要 Rust 构建时用 `CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target`。

## 4. 安全与测试底线

- 绝不调真的 Anthropic 或 Ollama：测试和验收用本机假 SSE/NDJSON 服务；没有任何会话读取或使用真实 API 密钥。
- API 密钥只在钥匙串；插件拿不到原值（占位符由宿主代入）；日志、审计、导出里没有。
- 审计不记提示词和回答的内容。

## 5. 完成标准

- 完整 `pnpm check` 通过；`round18.spec.ts` 没有 `test.fixme`；K1–K10 每一行在交接文件里写“通过/不通过/按新需求改了”和怎么验证。
- 之后由协调会话：集成分支 `claude/onedesk-r18` 合并 → 对齐 → 独立审查（`round18-review.md`）→ 第二阶段 e2e → 亲自验收（真内核＋本机假服务）→ 完整检查 → `round18-acceptance.md` → 经用户同意合并 main。
