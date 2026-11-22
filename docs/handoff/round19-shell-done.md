# 第十九轮 外壳（r19-shell）完成记录

## 做了什么
- 信息面板“对 AI 可见”开关（`info-panel.tsx` 的 `AiVisibleSection`）：默认关；分组节点文字为“对 AI 可见（含下级）”，调用 `resource.setAiVisible(id, visible, withChildren)`，成功后提示改了几项。环境、配置节点不显示。
- AI 设置页 `src/workbench/pages/ai-settings-page.tsx`（外壳目标 `shell:ai`，像密钥页一样由外壳自己画）：总开关、每分钟调用上限(1..600)、单次行数上限(1..2000)、允许自由查询、AI 用的环境选择；读写走 `workspace.getConfig/setConfig`（`mcp.enabled` / `mcp.rate_per_minute` / `mcp.max_rows` / `mcp.allow_free_query` / `mcp.env`），显示 `mcp.status` 的可用工具数。入口：顶栏设置菜单、命令面板“AI access”。
- “在 Claude Desktop 里使用”说明：程序路径 + 配置片段（`claudeDesktopSnippet`），可复制。路径与配置文本来自 `client.app.mcpInfo()`（D449，主进程方法 `app.mcpInfo` → `{path, exists, config}`）；纯演示模式没有 `app`，显示默认 `.app` 路径并注明是推测；`exists` 为 false 时提示。
- 审计页：新增“来源”过滤（全部 / 仅 AI，传 `AuditFilter.source = "ai"`）；`mcp.call` 行解析 `detail` 的 JSON，显示工具名、参数摘要、行数、耗时、失败码（`failed: <code>`）。
- 协议客户端：`ProtocolClient.resource.setAiVisible`、`ProtocolClient.mcp.status`；real / mixed / mock 同步（mock 带 `aiVisible`、`mcp.*` 默认值、AI 审计样例行、`source` 过滤）。
- 文字只加了英语（`en-US.ts`）；审计操作名 `resource.aiVisible`、`mcp.call`、`mcp.refused` 与新错误原因（`badArguments` 等 10 个）也已在 `kernel-texts.ts` 登记并加了英语。
- 测试：`parts/round19-shell.test.tsx`（开关、分组、策略、片段、审计过滤）；`kernel-texts.test.ts` 的清单补了新操作与原因。

## 给 tests 会话：要补的中日译文（`en-US.ts` 新增的键）
- `ai.title`
- `ai.hintTitle`
- `ai.hint`
- `ai.policy`
- `ai.enabled`
- `ai.enabledHint`
- `ai.rate`
- `ai.rateHint`
- `ai.rows`
- `ai.rowsHint`
- `ai.range`
- `ai.freeQuery`
- `ai.freeQueryHint`
- `ai.env`
- `ai.envHint`
- `ai.envNone`
- `ai.toolCount`
- `ai.connect`
- `ai.connectBody`
- `ai.programPath`
- `ai.copyPath`
- `ai.copiedPath`
- `ai.configSnippet`
- `ai.configHint`
- `ai.copyConfig`
- `ai.copiedConfig`
- `ai.pathGuess`
- `info.ai`
- `info.aiVisible`
- `info.aiVisibleGroup`
- `info.aiHint`
- `info.aiHintGroup`
- `info.aiChanged`
- `audit.tool`
- `audit.args`
- `audit.rows`
- `audit.duration`
- `audit.by`
- `audit.byAi`
- `audit.byAny`
- `audit.failedWith`
- `kernel.error.reason.badArguments`
- `kernel.error.reason.needAction`
- `kernel.error.reason.aiNotAllowed`
- `kernel.error.reason.aiRateLimit`
- `kernel.error.reason.aiReadOnly`
- `kernel.error.reason.aiOff`
- `kernel.error.reason.aiOnly`
- `kernel.error.reason.notAiAction`
- `kernel.error.reason.aiFreeQuery`
- `kernel.error.reason.aiEnvMissing`
- `kernel.audit.resource.aiVisible`
- `kernel.audit.mcp.call`
- `kernel.audit.mcp.refused`

现在 `plugins/_testing/lang-check.test.ts` 的 4 条（zh-cn、ja-jp 的键齐全与占位符）会因缺这些键而失败，补译后恢复。

## 检查结果
`pnpm typecheck` 通过；`pnpm test`：1123 通过，4 条为上面的译文缺口；`check-ui` 通过；`pnpm lint` 里 `check-arch` 的 43 条全部在 `crates/**`（内核里的 `ai`），需 tests 会话放行，外壳无一条。

## 范围外
- 内核给 AI 的错误原因文字外壳基本不会显示（只给 AI 客户端），已登记仅为通过“每个原因都有文字”的检查。
- 新增英语键 `ai.pathMissing` 也需译文。
