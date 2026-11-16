# 第八轮外壳交接（r8-shell）

## 改了什么
1. **页面参数（D358）**：`PageContext` 在外壳侧加可选 `params`（`protocol/types.ts`），real-client 随 `page.resolve`/`page.event` 发出。`view-page.tsx` 的重算、事件、`page-host.tsx` 的首次 resolve 都带 `params`（页面上 `param: true` 字段当前值，同 `run.start` 的 `runParams`；首次 resolve 时字段表未知，发 `tab.params` 中非空的值）。`PageEventResult.params`（本地类型里可选）合并进 tab 的 `params`（值 `""` 即清空），不经草稿，所以不产生“未保存”。参数变化也触发（有 `recompute` 的页面）重算。
2. **`RunError.params`（D360）**：`Run.error` 本地类型带 `params`；`i18n.runError` 先找带名字的文字（`kernel-texts.ts` 的 `RUN_ERRORS_NAMED`，键 `<code>.<reason>|参数名…`，参数齐的最长条目胜出），没有 `params` 时沿用原笼统文字。覆盖 `blockedByPolicy`（program/host + layer）、`undeclaredProgram`、`notFound/program`、`hostNotAllowed`、`localAddress`、`secretNotAllowed`/`unknownSecret`（name）、`notExported`（export）。
3. **插件页**：`PluginDetail.unmetExports`（本地可选字段）→ 警告条“以下类型不可用”+每条“对方没有导出 …”。权限 `pages`：新增权限名文字、`PagesNotice`（`parts/pages-notice.tsx`），在安装确认框和插件页“确认权限”框里列出名单并说明；权限表 detail 列本来就显示列表。
4. **文字**：`notExported`、`undeclaredDepend`（清单原因与错误原因）、`exists`（搬运目标，文字补充）、`notInRun`（加上“搬运文件”）；审计操作名 `transfer.download/upload/capture`（英、中）；测试的原因码列表同步。
5. **todo 两条**：已删除页“永久删除”的被引用数、信息面板“引用”不显示内部字段名——代码里早已做好（`deleted-page.tsx` 的 `refs.incoming`、`info-panel.tsx` 只用 `fieldLabel`），本轮没改；`e2e/round5.spec.ts` 里已没有 `test.fixme`。
6. **核对（第 4 项）**：没有真内核，只读了代码，未实际走过。别人的树的“新建”来自内核 `menus`，外壳按内核给的列表画；操作区和结果区由页面描述（`actions`、`resultTabs`）决定，外壳按其画，没有写死“某类型有 view 页签”；新建被拒 `denied/notExported` 走 `error()` 的文字（已加）。未改代码。

## 测试结果
`pnpm typecheck`、`pnpm lint`、`pnpm test`（38 文件 302+ 条）、`cargo test -p onedesk-host`、`cargo clippy -p onedesk-host -- -D warnings` 通过。假数据模式 `workbench.spec.ts`：一次整跑 22 过 1 败（“tree: drag onto a group…”，负载下偶发），单独重跑通过；截图已 `git checkout -- docs/screenshots`。主进程（host/src-tauri）没改。

## 假设（内核合并后要对）
- 字段名：`PageContext.params`、`PageEventResult.params`、`RunError.params`（均 `Record<string,string>`）、`PluginDetail.unmetExports: string[]`、权限 id `pages`（detail 为逗号分隔的 `<插件id>:<page>`）。生成类型合并后，把 `protocol/types.ts` 里的本地补充删掉。
- `RunError.reason` 对 notFound 外部程序是 `program`（`notFound.program`），`params` 键为 `program`/`host`/`layer`/`name`/`export`；`layer` 原样显示（不翻译）。
- `PageEventResult.params` 是“合并”语义，不是整体替换。
- 页面首次 resolve 时 `params` 取 `tab.params` 非空项（不按字段表过滤）。

## 没做 / 没验证
- 没连真内核；第 4 项只读代码；`pages` 权限在真安装框里的样子没看过。
- 没新增 view-page 的组件测试（只加了 real-client 与 runError 的单元测试）。
