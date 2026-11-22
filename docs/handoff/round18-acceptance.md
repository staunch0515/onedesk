# 第十八轮验收（2026-11-22，第七个协调会话）

范围：`ai-plugins.md`（D426）——AI 工作台 `org.onedesk.ai`（K1–K10）、提供方 `org.onedesk.ai.anthropic`、`org.onedesk.ai.ollama`；内核 X5（结果动作）、X6（搜索 mode/rank/kinds）、X15（插件间接口）、X16（长请求与流式）；决定 D437–D446。集成分支 `claude/onedesk-r18`，验收时 `8d11afb`。

## 结论：通过（全程只用本机假 SSE/NDJSON 服务，没有调用真实 Anthropic，没花钱）

| 检查 | 结果 |
|---|---|
| `pnpm check`（类型、架构、界面规范、vitest、cargo、clippy、e2e） | 全过，退出码 0 |
| vitest | 1122/1122 |
| `cargo test --workspace` | 662 通过 / 0 失败；clippy 无警告 |
| `pnpm e2e` | 352 通过、1 按条件跳过、0 失败；`round18.spec.ts` 23 条、无 `test.fixme` |

## 协调会话亲自验收（真内核 devhost + 本机假 AI 服务，`ONEDESK_SECRET_STORE=memory`）

| 项 | 结果 |
|---|---|
| 表格结果上出现“分析”按钮；预览页直接打开，显示连接、模型、约 314 token、系统提示 | 通过 |
| 发送：流式出现标题、计时、取消按钮；结束后是可读 Markdown，带用量 | 通过 |
| 保存分析：`run_artifacts` 一行（kind `analysis`）；删除已保留的运行后级联清空 | 通过 |
| 审计只有次数、字节、状态，无内容；假密钥在数据目录任何文件里搜不到 | 通过 |

## 审查与修正

`round18-review.md` 17 条，必须修 7 条（工作台读不到提供方连接、K2 搜索为空、K6 首次保存被拒、`snippet` 泄露正文、`uses` 不是权限、`generate` 预览可绕过且发送文字与预览不一致、敏感列遮盖可绕过），全部修复。验收与 e2e 另发现：流中断开要等 60 秒（内核修）、链接输出打开空白页、最终答案不是 Markdown（D446）、Answer/Send 页签重复、分析页选了不存在连接显示裸文字键（`8d11afb`）。

## 没验证的

- 真实 Anthropic / Ollama：从未连过，只验证了与假服务的协议（请求头、SSE、NDJSON）。
- SQL 里“用 AI 写”需要临时 PostgreSQL，只有 e2e 覆盖；`ai.policy` 三档、流中取消、拒答/错误映射同样只有 e2e。
- 桌面窗口画面、打包 `.app`、真钥匙串。
- 小问题：设了默认连接后，预览页“AI 连接”下拉仍显示“选择”。

## 已接受的限制

环境页选择器不按类型过滤；`baseUrl` 无保存时校验；`ai.policy=off` 不让“分析”按钮变灰（点击时给提示）；超过 200 条的未保留运行连同分析被清理；中日译文未经母语审校。
