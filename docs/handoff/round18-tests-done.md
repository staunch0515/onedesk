# 第十八轮 · 测试会话（r18-tests）· 第一阶段完成

## 1. `scripts/check-arch.mjs`
内核侧（crates/kernel、worker、protocol、host、src-tauri）禁用词整词（不分大小写）新增：`anthropic`、`ollama`、`claude`、`ai`、`sse`、`ndjson`。
- 边界是“不是字母数字下划线”，所以 `"org.onedesk.ai"`、`"ai.policy"` 里的 `ai` 段会命中（符合预期：内核不认识这些）；`maintain`、`said`、`details` 等不命中。
- Rust 注释和 `#[cfg(test)]` 之后不扫（沿用原规则）；`tests/` 目录里的文件不扫词。
- 已验证：加入含 `ollama`/`SSE`/`claude`/`ndjson`/`org.onedesk.ai`/`ai.policy` 的临时内核文件各自报错，注释里的 `ai`、`maintain` 等不报；现有源码零命中，`pnpm lint`、`pnpm typecheck` 通过。临时文件已删。
- 注意给内核会话：内核里需要英文词 “sse” 的地方不能出现（如变量名 `sse_`——下划线算词内，不会命中；但 `Sse` 单独一词会）。

## 2. e2e 脚手架
- `e2e/fixtures/fake-ai.ts`：**我自写的最小假服务**（`r18-providers` 的 `plugins/_testing/fake-ai/` 当时还没有）。Anthropic 风格 SSE（`/v1/messages`、`/v1/models`）与 Ollama 风格 NDJSON（`/api/chat`、`/api/tags`、`/api/version`）；可设分块、间隔、HTTP 错误状态、`refusal`、`hang`（只发头不发数据）；记录每个请求（方法、URL、头、正文）；统计被客户端中途断开的连接数 `aborted`。**第二阶段若 providers 的夹具到位且约定不同，改 import 即可**。
- `e2e/round18.spec.ts`：启动 devhost（临时数据目录、`--plugins plugins/`、内存密钥库）、辅助函数（`call/create/startRaw/waitRun`）、1 个脚手架自检用例（通过）、K1–K10 与 X5/X6/X15/X16/外壳共 17 条 `test.fixme` 占位，每条写了第二阶段要断言什么。
- 绝不连真 Anthropic/Ollama：只有 127.0.0.1 上的假服务。第二阶段连接资源里要把 `baseUrl` 指向 `ai.origin`（并让资源明确写出这个本机主机和端口）。
- 跑法：`ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost pnpm exec playwright test e2e/round18.spec.ts`。当前：1 通过、17 fixme。

## 3. 需要的内核事实（第二阶段前请确认）
1. 两个服务商连接资源的完整 kind id（我暂写 `org.onedesk.ai.anthropic:connection`、`org.onedesk.ai.ollama:connection`）和字段名（`baseUrl`、`model` 等）以合并后的清单为准。
2. `ONEDESK_SECRET_STORE=memory` 下，表单密钥字段经 `page.save` 写入是否同样进内存密钥库（K5 要查“数据目录里没有明文”）。
3. 假 AI 在 127.0.0.1 随机端口：Anthropic 连接的“只放行连接里写的主机”是否允许 `baseUrl` 写本机地址（D308：本机地址要明确写出），否则 K3/K5 的 Anthropic 用例无法指向假服务。
4. 取消运行的 RPC 名（预期 `run.cancel`），以及 `result.actions`、`search` 新参数、`interfaces.*` 在 devhost 里能否直接 `rpc` 调用（X15 的 `denied/notUsed` 需要一个没声明 `uses` 的测试插件——可能要在 `plugins/_testing/` 放一个或用 `ONEDESK_TEST_HOOKS`）。
5. 长 >60s 的用例不能真等：需要内核有可配置的测试时限（如环境变量缩短 `idleTimeoutMs` 的默认值），否则只测 `idleTimeoutMs` 显式传小值。

## 范围外
无。

最后提交号：见 `git log -1 -- docs/handoff/round18-tests-done.md`。
