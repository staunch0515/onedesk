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
