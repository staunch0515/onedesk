# 第七轮 · 插件与测试 · 第一阶段 完成报告

## 做了什么
1. `plugins/org.onedesk.market/`：清单（`requires.files: true`、`requires.plugins.install: true`）、`main.js`、`locales/en-US.json`、`zh-CN.json`、`main.test.ts`。
2. `plugins/org.onedesk.note/manifest.json` 加顶层 `exports`（`note`：`actions`、`read`），`main.test.ts` 加断言。
3. `e2e/fixtures/plugins/com.example.note-tools/0.1.0/`：`depends` 笔记（`>=0.1.0`）；动作 `count`（统计字数、行数）、`stamp`（`ctx.host.resources.update` 改笔记，错误原样抛出）；英中语言文件。
4. `e2e/fixtures/market/`：`com.example.hello/0.1.0/`（一个类型 `greeting`、一个页面 `editor`，无权限）、`broken/`（清单有未知顶层字段 `surprise`）、`org.onedesk.note/0.1.0/`（内置笔记的逐字节副本）。
5. 夹具的测试在 `plugins/_testing/round7-fixtures.test.ts`（含“笔记副本与内置逐字节相同、版本目录等于内置版本”的检查，内置笔记升版本时会失败提醒）。

## 测试结果（本会话实际运行）
`pnpm test`（37 个文件、282 个用例）、`pnpm lint`（架构 + 界面规范）、`pnpm typecheck` 通过。Rust 与 Playwright 没跑（本阶段不涉及）。所有 JSON 用 `python3 -m json.tool` 校验过。

## 我做的假设（合并后要对着真内核核对）
- **市场的入口**：协议里没有“往 `plugins` 树加入口”的路，所以用了插件自己的提供树 `market`（一个根节点 `local`，目标 `node:org.onedesk.market:market/local`，工具栏 `plugin.grantFolder`），页面 `browse`。计划说“不新增树”——若内核/外壳要求入口放进 `plugins` 树，需要改清单的 `trees` 部分，页面代码不用动。
- **没有授权文件夹时的“选择文件夹…”**：由树工具栏的 `plugin.grantFolder` 提供，页面只写说明文字。
- **“安装”按钮**：视图树里没有按钮节点，所以做成页面动作 `install`（`role: event`）+ 一个 `enum` 字段 `pick`（只列“未安装/可更新”的包，值是包文件夹绝对路径）。事件名按 `onEvent(ctx, event)` 收 `"install"`/`"refresh"`；选中值读 `ctx.draft.pick`，页面 `recompute: true` 让列表在 `onEvent` 返回 `changes: { pick: "" }` 后刷新。需核对：事件动作是否把草稿带进 `ctx.draft`、`changes` 是否触发重算。
- 表格里没有图标列（表格单元格是纯值；插件图标名在 manifest 里，没有可显示的位置）。
- 宿主形状：`files.list(path,{offset,limit})` → `{entries:[{name,path,dir,hidden}], next?}`；包目录不存在清单时 `readText` 抛 `notFound`（其他错误→列为“不可用：读不了清单”）；`plugins.list()` → `[{id,name,versions,active}]`；`requestInstall` 的 `folder` 传包目录（含 `manifest.json` 的那一层）。“已安装”判断：已装版本含该包版本；包版本更高 → “可更新”；包更低 → 仍显示“已安装”。
- 市场只检查清单是不是 JSON、有没有 `id` 和 `version`，**不检查未知字段**：夹具 `broken/` 因此在市场里显示为可安装，点安装后由内核拒绝，应得到 `failed` 并显示原因（不是“不可用”）。
- 页面按语言名从包自己的 `contributes.locales` 读文本（只在包目录内，拒绝绝对路径和 `..`）；读不到就显示清单里的原始键。
- note-tools：动作读的是 `ctx.resource.body.text`（没有则退回 `input["body.text"]`），写用 `ctx.resource.id` 和 `{ "body.text": … }`。需核对依赖方动作的 `ctx.resource` 形状是否如此。字数规则：非空白连续串算一词，每个 CJK 字符单算一词。
- 夹具 `org.onedesk.note/0.1.0` 的目录名与内置笔记版本一致（`0.1.0`）。

## 没验证的
没有对着真内核跑过（第二阶段 `e2e/round7.spec.ts` 才做）：清单是否被内核接受（`exports`、`depends`、`requires.plugins`）、`broken/` 是否确实被拒、市场页面在真外壳里的显示和点击流程、依赖方动作的运行与只读限制。

---

# 第二阶段（合并后，连真内核）

`git merge claude/onedesk-coord-2-91a88b` 后写了 `e2e/round7.spec.ts`，用真 devhost（`ONEDESK_SECRET_STORE=memory`、临时数据目录）跑：`E2E_PORT=1435 pnpm exec playwright test e2e/round7.spec.ts` → **13 通过、1 `test.fixme`**（0 失败）。截图 `docs/screenshots/round7-*.png`（market-empty、market-list、market-install-dialog、market-installed、plugin-depends）。另跑了 `pnpm typecheck`、`pnpm lint`、插件 vitest，通过。没跑 Rust 测试、`workbench.spec.ts`。

## 用例
市场页无授权文件夹的说明；授权 `e2e/fixtures/market` 后三种状态（未安装 / 不可用+原因 / 已安装）；未声明 `plugins.install` 的插件（新夹具 `com.example.no-install`）被拒 `denied/notRequested`；授权范围外的文件夹被拒（`outsideGrant`，且无登记的请求）；同时两个请求第二个被拒（市场捕获 `conflict/pendingRequest` 并提示，请求仍只有一个，答复后结束）；框架确认框标题带“Plugin market”，取消后什么都没装且 `plugin.installRequests` 为空；确认后装上、列表“Installed 0.1.0”、插件树里出现；note-tools 的确认框权限 `resources` 的明细含 `org.onedesk.note:note`；笔记页出现 `count`，结果“5 words, 2 lines”；`stamp` 被拒 `denied/foreignKind`、笔记不变、审计里有 note-tools 作操作者的 `resources.update` 被拒行；插件页依赖/被依赖（协议 + 一张截图）；笔记停用被拒 `conflict/dependents`，`params.plugins = com.example.note-tools`，`plugin.checkRemove` 同；先停 note-tools 才能停笔记；笔记停用时启用 note-tools → `load.message = dependsUnmet`、`count` 不出现，重新启用笔记后恢复；只读策略下 `count` 被拒 `denied/readonly`。

## 对着真内核核对后的修正与发现
- 夹具新增：`e2e/fixtures/market/unreadable/`（残缺 JSON，让“不可用”有例子）、`e2e/fixtures/plugins/com.example.no-install/`。
- `plugin.grantFolder` 的参数是 `path`；`page.event` 的 `context.draft.pick` 带选择，市场页和 note-tools 的假设都对上了（`ctx.resource.body.text`、`id`、`resources.update` 被拒的错误原样抛出，真内核给出 `denied/foreignKind`）。
- **运行记录的操作者是 `user`**（谁点的运行），不是 note-tools；note-tools 是它在这次运行里做的宿主调用的操作者（审计行 `actor = plugin:com.example.note-tools@0.1.0`）。用例按这个断言。
- 依赖方不满足时，对它的动作 `run.start` 没有被同步拒绝（返回 run id；用例只断言不会成功）。如果期望是同步拒绝，是内核行为待定。
- 协议类用例用一个连着 mock 数据的 `workbench.html`（不连内核）当 WebSocket 载体，因为 `about:blank` 连不上 devhost；这样不会有真外壳去自动答复安装请求。
- 市场页的“选包”下拉有 Radix 的 “Select is changing from uncontrolled to controlled” 控制台警告（外壳问题：`pick` 的值初始为空串后变受控）。不影响用例，未改。

## fixme
1. `removing the note version through the app is refused`：`app.removePlugin` 要等外壳把 `plugin.checkRemove` 接到主进程（`crates/host`）；`plugin.checkRemove` 本身的拒绝已在协议层用例里测过（通过）。

## 没验证
没在桌面应用（Tauri）里跑，只在 devhost + 浏览器里；右键菜单里的依赖方动作（内核说还没做）没测；5 分钟过期没测（内核测试里有）；中文界面的文字没断言。
