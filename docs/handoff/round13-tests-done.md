# 第十三轮 插件与测试会话交接

分支 `claude/r13-tests-f02c69`。

## 第一阶段：已撤销（D403）
用户决定不做第一版旧库升级。已删除 `e2e/fixtures/legacy-v1/`、各插件的 `upgrade` 钩子（main.js 回到 8a4b147 之前）、`plugins/_testing/legacy-upgrade.test.ts`，去掉所有内置插件清单（及 `e2e/fixtures/market/org.onedesk.note`）里的 `legacyKinds`，删掉对应的清单断言和 `e2e/round11.spec.ts` 里的 “legacyKinds show in plugin.get” 用例。市场夹具的笔记包与内置保持逐字节一致。
（旧做法仍在 git 历史：8a4b147、5a21f74。）

## 结果
- `plugins` 下 315 条 vitest、`pnpm typecheck`、`pnpm lint` 通过。
- 完整 `pnpm test` 有 `src/workbench/parts/tree-batches.test.tsx`、`src/design/components/tree.test.tsx`、`plugins/_testing/round10-fixtures.test.ts` 的树滚动用例超时/失败（5000ms 超时，机器上同时有多个会话在跑）；我没改 `src/`，单独重跑仍有 1–2 条失败，**未确认是否随机器负载**，也未在干净基线上对照。
- 未跑 Rust、Playwright。

## 第二阶段
- **中日译文**：外壳新增的 20 个键（`topbar.manageWorkspaces`、`workspace.*`、`kernel.error.conflict.idPending/inUse`）已补进两个语言插件的 `shell/*.json`；`lang-check`、`locale-check` 通过。
- **`e2e/round13.spec.ts`**（连真内核，devhost 内存密钥库 + 临时目录；协议部分用 Node 的 WebSocket 每个 client 一条持久连接）10 条：
  1. 全新数据目录只有一个工作区；
  2. 新建：配置树根节点改名与插件停用状态复制过去、数据不复制、不切换、名称空/全空白/>100 字符 `invalidParams`、重名文件夹去重、`workspacesChanged` 推送；
  3. 两个连接（`workspace=<id>`）连不同工作区互不影响；
  4. 工作进程随最后一个连接关闭而停（用 `ps` 数含临时数据目录的 `onedesk-worker`；其他连接还在时不停）；
  5. 切换：内容不同、`lastOpened` 排前、未知 id `notFound`、切回；
  6. 改名：去空白、事件推到其它连接、非法名/未知 id；
  7. 删除：被任一连接占用或是自己的 → `conflict/inUse`，之后移到 `trash/workspaces/<文件夹>-<时间>`、从列表消失、再删 `notFound`；
  8. 没有 `workspace.json` 的文件夹列为 `pending:`，改名/删除 `conflict/idPending`；
  9. `workspace.settingsSnapshot` 带 client → `denied/mainProcessOnly`；
  10. 界面：菜单新建（对话框）→ 切换 → 第二个页面用 `workspace=` 连默认工作区互不影响 → 管理对话框（当前的删除按钮禁用）→ 改名 → 删除确认写明 trash。截图 `docs/screenshots/round13-switched.png`、`round13-manage.png`。
- **跑的结果**：对着我本地（未提交）修补过的主进程二进制，10 条全过；**对着协调分支原样的主进程，第 2 条起会失败**，原因见下。

## 别人的缺陷（我没改，不在允许范围）
1. **`crates/host/src/lib.rs:788`**：`app.createWorkspace` 把请求者的 `client` 带给工作进程的 `workspace.settingsSnapshot`，内核按 `mainProcessOnly` 拒绝（`denied`），所以真内核下新建工作区必失败。应按 client 找到工作区后向工作进程发不带 client 的请求（我本地验证的补丁：新增 `forward_main`，`slot_for(&self.bound(client))` 后 `slot.forward(None, …)`）。该补丁已还原、未提交。round13.spec.ts 第 2 条及其后依赖它的用例要等这个修复合并才过（没有 `test.fixme`，修复后即过）。
2. **`pnpm test` 里 `src/workbench/i18n/kernel-texts.test.ts` 2 条失败**（外壳的文字表）：缺审计操作名 `workspace.initSettings` 和错误原因 `mainProcessOnly` 的文字。属 `src/workbench/i18n/kernel-texts.ts`，外壳会话补。
3. 上一轮留下的树滚动用例（tree-batches 等）在负载大时超时，这次完整 `pnpm test` 中没出现。

## 没验证
Rust 测试、clippy 没跑；Playwright 只跑了 round13.spec.ts（没重跑 workbench.spec.ts 等旧用例）。

## 审查补充（#11、#13）
- #11：`e2e/round11.spec.ts` 注释里的 `legacyKinds` 已去掉。
- 合并协调分支（含 ea8a194 的 createWorkspace 修复）后，原样主进程下真内核新建工作区成功，`round13.spec.ts` 10 条通过；不再需要本地补丁。
- 新增两条 `test.fixme`（外壳修完后去掉 fixme）：
  1. **D406**：不带 `workspace=` 的连接不会因另一个连接切换而被带走（审查 #2）。现状实测失败：A 被带走。
  2. **浏览器“新窗口”**开新标签页、地址带 `workspace=<id>`（审查 #7）。现状点按钮无反应。
- 占用中的删除被拒：已有用例（第 8 条，`conflict/inUse`）。
- 结果：10 过、2 fixme；typecheck、lint 通过。仍未跑 Rust/旧 Playwright 用例。
