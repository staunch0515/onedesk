# week1/plugins（分支 claude/week1-plugins-15d46f）：第一阶段完成

## 完成了什么
- `plugins/org.onedesk.note/`：类型 `note`（`resources` 树，body `{text}`）、页面 `editor`（占满高度的 `longtext`，`bind: body.text`）、保存操作、“新建”里的“笔记”、右键命令 `duplicate`（`resources.get/create` + `ui.open`，副本名 `<原名> (副本|copy)`）。
- `plugins/org.onedesk.files/`：`requires.files: true`；树 `files`（顶层 = 授权文件夹；下面文件夹在前、按名字排序、隐藏文件不列、每批 200、`next` 带续传偏移；节点 key = 绝对路径；文件节点 `target = node:org.onedesk.files:files/<URL 编码路径>`，文件夹无 target）；页面 `text`（`code` 字段 `bind: content`、按扩展名给 `language`；`readText` 失败时显示 `muted` 文本节点说明 tooLarge/notText/denied/notFound/其它；`save` 用 `writeText` 并带 `basis`，错误原样抛给内核）；面包屑 = 从授权文件夹起的路径；`path` 同。
- 两个插件都有英、中语言文件；纯 JS ES 模块，无 `console`/`setTimeout`/`fetch`；清单已用 `python3 -m json.tool` 校验。
- 测试：`plugins/*/main.test.ts` + 共用的 `plugins/_testing/view-check.ts`（假 host、ViewNode 严格校验镜像、registry）。
- `scripts/check-arch.mjs`、`scripts/check-ui.mjs` 改为新结构规则（见下）。
- `e2e/week1.spec.ts`（连真 devhost，浅/深各一组，截图到 `docs/screenshots/week1-<主题>-<名>.png`）。**写完，没有运行。**

## 测试与检查结果
- `pnpm test`：12 个文件、75 个测试全过（插件 23 个）。
- `pnpm lint`：通过（有一条关于旧 `src-tauri` 代码的警告，见下）。
- `pnpm typecheck`：通过。
- `pnpm e2e`：见文末“e2e 运行情况”。`week1.spec.ts` 在没有 `target/debug/onedesk-devhost` 时整体跳过（并给出原因），合并后构建出来才会真正执行。

## 我做的决定
1. **检查脚本的例外**：`check-arch` 对 Rust 文件不扫注释和 `#[cfg(test)]` 之后的内容（协议 crate 的文档注释写了 `org.onedesk.files`、测试里有 `"Note"` 字符串）。旧的第一版 Rust（`src-tauri/src/{commands,db,plugins,secrets,time,transfer}.rs`，含大量 `sql`）列为 LEGACY，只警告不失败；外壳会话替换掉它们后，请删掉脚本里的 `LEGACY`。
2. 插件里“副本”后缀取自插件语言文件（`copy.suffix`），按 `ctx.locale` 取 Label 的对应语言，缺则 en-US。`text` 视图节点只接受普通字符串，所以说明文字同样按 locale 取出。
3. 测试辅助放在 `plugins/_testing/`（不是插件，没有清单；`check-arch` 只扫有 `manifest.json` 的文件夹）。
4. 测试里的 `import ... from "./main.js"` 用 `// @ts-ignore`（tsconfig 无 `allowJs`，不归我改）。
5. `week1.spec.ts` 的授权文件夹用协议直接调 `plugin.grantFolder`（浏览器里没有系统文件夹对话框）；“选文件夹对话框”那条路径留给桌面应用手动验收。
6. 授权之外路径的检查：直接 `page.resolve` 一个 `node:` 目标，断言结果（无论是错误还是页面）都不含文件内容。

## 对内核或外壳的要求（spec 里依赖的假设，第二阶段对齐）
- devhost 二进制：`target/debug/onedesk-devhost`（可用 `ONEDESK_DEVHOST_BIN` 改）；cwd 为仓库根时能找到 `./plugins` 作内置插件；找到工作进程（同目录或 `ONEDESK_WORKER_BIN`）；`--data-dir/--port/--token`，stdout 一行 `READY`。**若 devhost 并不默认读 `./plugins`，需要它提供参数或环境变量。**
- WebSocket：`ws://127.0.0.1:<端口>/?token=<令牌>`，文本帧一条一条 JSON（spec 的 `rpc()` 辅助函数这样假设；外壳界面用的是 `?kernel=…&token=…`）。
- 外壳界面：树节点 `data-tree-key`（存储树里用标签文字找，文件树用绝对路径）、标签 `data-tab-id` + `od-tab--dirty` 类、活动栏按钮名 “Files”、“New” 按钮 + “New group”/“Note” 菜单项、右键菜单 “Rename/Duplicate/Delete”、改名输入框名 “New name”、关闭未保存的对话框含 “unsaved changes” 和 “Cancel”、双击节点 = 展开/打开。这些都集中在 spec 顶部的 `ui` 对象和各步里，对不上就改 spec。
- `node.newGroup` 之后 `rename` 效果应让界面进入行内改名并接受键盘输入。
- 杀工作进程用 `pkill -9 -f "onedesk-worker.*<数据目录>"`，要求工作进程命令行里含工作区路径（协议 §2 已是如此）。

## 新依赖 / 协议变更
无。

## 没做 / 没验证
- `e2e/week1.spec.ts` 从未运行，选择器、WebSocket 细节都是按协议文档推的，第二阶段需要实际调。
- 插件没有在真沙箱（rquickjs）里跑过，只在 vitest（Node）里用假 host 测；`main.js` 里用了 `async/await`、展开运算符、可选链都属于 ES2020+，QuickJS 支持，但未实测。
- `playwright.config.ts` 没改（现有配置已能同时跑两个 spec；webServer 仍是 vite）。
- `pnpm check` 里的 Rust 部分不在我范围，没跑。

## e2e 运行情况
`E2E_PORT=1432 pnpm exec playwright test`：`workbench.spec.ts` 23 通过、1 个本来就跳过；`week1.spec.ts` 5 个因无 devhost 二进制被跳过（未执行）。耗时约 8 分钟。
