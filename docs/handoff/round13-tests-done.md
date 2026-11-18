# 第十三轮 插件与测试会话交接

分支 `claude/r13-tests-f02c69`。

## 第一阶段：已撤销（D403）
用户决定不做第一版旧库升级。已删除 `e2e/fixtures/legacy-v1/`、各插件的 `upgrade` 钩子（main.js 回到 8a4b147 之前）、`plugins/_testing/legacy-upgrade.test.ts`，去掉所有内置插件清单（及 `e2e/fixtures/market/org.onedesk.note`）里的 `legacyKinds`，删掉对应的清单断言和 `e2e/round11.spec.ts` 里的 “legacyKinds show in plugin.get” 用例。市场夹具的笔记包与内置保持逐字节一致。
（旧做法仍在 git 历史：8a4b147、5a21f74。）

## 结果
- `plugins` 下 315 条 vitest、`pnpm typecheck`、`pnpm lint` 通过。
- 完整 `pnpm test` 有 `src/workbench/parts/tree-batches.test.tsx`、`src/design/components/tree.test.tsx`、`plugins/_testing/round10-fixtures.test.ts` 的树滚动用例超时/失败（5000ms 超时，机器上同时有多个会话在跑）；我没改 `src/`，单独重跑仍有 1–2 条失败，**未确认是否随机器负载**，也未在干净基线上对照。
- 未跑 Rust、Playwright。

## 第二阶段（待通知）
`e2e/round13.spec.ts`：多工作区（新建、切换内容不同、改名、删除、占用中删除被拒）、多连接（两页连不同工作区互不影响）；补中日译文。未开始。
