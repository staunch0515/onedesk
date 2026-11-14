---
description: 运行全部检查（类型、架构、界面规范、单元/集成测试与覆盖率、Rust 测试、clippy、界面测试），汇总结果
---
在项目根目录依次运行，每条都运行，不要因前一条失败而跳过后面的：

1. `pnpm typecheck`
2. `pnpm lint`（架构边界 + 界面规范）
3. `pnpm coverage`（vitest，内核覆盖率门槛 80%）
4. `pnpm test:perf`（1 万条搜索，单独运行；机器高负载时可能失败，需空闲时重跑）
5. `pnpm test:rust`
6. `pnpm clippy`（警告视为错误）
7. `pnpm e2e`（Playwright，浏览器预览模式；会更新 docs/screenshots/）

最后用一个表格汇总：检查项、结果（通过/失败）、失败时的前几行错误。任何一项失败都要明确写“不能提交”。不要修改代码，只报告。
