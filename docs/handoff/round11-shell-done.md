# 第十一轮外壳：交接（Sonnet）

分支 `claude/r11-shell-0235cc`。没有推送、没有合并。

## 改了什么
- **语言（D379）**：`src/workbench/app.tsx` 的 `useLanguage(configured)`：取 `client.i18n.languages()`（订阅 `languages` 主题刷新）、所选语言消失则回到英语、取 `i18n.shell(locale).texts` 作覆盖。`src/workbench/i18n/index.tsx` 的 `buildI18n(locale, texts?)`：文字 = 自带英语 + 覆盖，缺键、空串、非字符串回退英语；日期/数字用当前语言（运行时不认识的标签用英语格式）。`Locale` 改为字符串。语言选择器（状态栏、命令面板）来自 `i18n.languages`，选了写 `ui.language`。URL 参数 `lang` 仍照旧（main.tsx 写 `ui.language`）。
- **协议客户端**：`ProtocolClient.i18n?`（`languages`/`shell`）、`platform.openExternal?`；真客户端调 `i18n.languages`、`i18n.shell {locale}`；传输层 Tauri 版调主进程 `open_external`。混合客户端：`i18n` 用内核的，`page:` 目标归内核。
- **openExternal（D380）**：`crates/host/src/external.rs`（校验 http/https/mailto、≤2048、无空白/控制字符，带测试；用 `/usr/bin/open -- <url>`）；`src-tauri` 命令 `open_external`；外壳 `actions.openExternal` 与 `ui` 主题效果 `{type:"openExternal",url}`；外壳也先校验，浏览器里 `window.open(..., noopener)`。
- **Markdown（D381）**：`src/design/components/markdown-text.tsx`（`MarkdownText`，`markdown-it`，`html:false`，只留 http/https/mailto 链接，`[[名称]]` 内联规则，图片显示替代文字，标题下移一级，表格包一层）；样式追加到 `markdown.css`（只用 token）。`view-nodes.tsx`：`text` 节点 `format:"markdown"` 用它；`[[…]]` 用当前标签页 `resource:<id>` 的 `refs.outgoing` 解析，解析不到/已删除显示失效样式且不可点。
- **启动页（D382）**：`state/startup.ts` 的 `openStartupPage`，只在 main.tsx 启动时调用一次：没有任何标签页时打开 `workspace.info().startupPages[0]`。
- 新文字：英语、中文各一条 `link.refused`。
- 依赖：`markdown-it`、`@types/markdown-it`（D381）。

## 测试（实际跑过）
- `pnpm typecheck`、`pnpm lint` 通过；`pnpm test`：54 个文件、444 个全过（含新增：`markdown-text.test.tsx`、`i18n/overlay.test.tsx`、`parts/round11.test.tsx`、`state/startup.test.ts`）。
- `cargo test -p onedesk-host` 通过（含 `external` 的 3 个）；`cargo clippy -p onedesk-host --all-targets -D warnings` 通过；`cargo check -p onedesk`（src-tauri）通过。
- 假数据模式 `workbench.spec.ts`：见本文末“e2e”。

## 我做的假设（合并后对真内核要核对的）
1. `i18n.languages` 返回 `LanguageInfo[]`，第一项 `en-US`；`i18n.shell {locale}` 返回 `{locale, texts}`。类型现在在 `protocol/types.ts` 本地定义，合并后改用生成的。
2. `workspace.info.startupPages` 是 `page:<插件id>/<页面id>` 字符串；外壳取第一个以 `page:` 开头的。合并后核对 `page:` 目标能 `page.resolve`。
3. `ui` 主题发来的效果就是 `{type:"openExternal", url}`（按 `ui` 事件的现有路径进 `runEffects`）。
4. 文字节点 `format` 字段本地补在 `TextNode`；生成类型有了就删。`WorkspaceInfo` 同。
5. 假数据模式：`i18n.shell("zh-CN")` 直接给 `zh-CN.ts`，语言只有英、中。合并后：导入语言插件 JSON、删 `zh-CN.ts`（`harness.tsx`、mock、几个测试还在引用它）。
6. 内核错误/确认/权限等词表（`kernel-texts.ts`）仍只有英、中：日语等其他语言在这些地方回退英语（`I18n.kernelLocale`）。若要日语，需把这些词表也放进语言插件文件，是接口决定，留给主会话。
7. 工作区配置页的“界面语言”下拉由内核页面给选项（真内核）/ 假数据写死英、中；外壳没有特殊处理，选项是否随 `i18n.languages` 变，取决于内核的配置页声明。**未做、未验证**。
8. `[[引用]]` 只按“当前标签页的资源”的已存引用解析；未保存草稿里新写的 `[[x]]` 显示为失效，直到保存。

## 没做 / 没验证
- 没有对真内核、真桌面窗口走过（`open_external` 只做了单元测试和编译；没真的拉起浏览器）。
- 日语语言文件、语言插件、`welcome` 页面不在我这里（插件会话）。
- 没有为启动页、`languages` 主题做端到端检查（只有单元测试）。

## e2e
`E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts`：23 通过，1 跳过（“review shots”，本来就跳过）。跑完已 `git checkout -- docs/screenshots`（无变化）。
