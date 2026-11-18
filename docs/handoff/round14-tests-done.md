# 第十四轮 插件与测试（Sonnet）——第一阶段完成

分支 `claude/r14-tests-e532eb`。第二阶段（外壳新增文字的中日译文）等协调会话通知，尚未做。

## 做了什么

- `e2e/round14.spec.ts`（连真内核，临时目录 + `ONEDESK_SECRET_STORE=memory` + 本机 HTTP 夹具），没有 `test.fixme`：
  - **D1** 启动即欢迎页；活动栏四个树（资源、环境、插件、设置）；“新建”菜单列出 6 种类型。
  - **D2** 从欢迎页的入口在界面里建网址、提示词、笔记、HTTP 请求并 ⌘S 保存，库里各一条；从树里逐个点开，各自页面的输入框显示保存的内容。
  - **D3** 停用 HTTP 请求插件：新建菜单没有它、资源仍在树里、`resource.get` 的内容与名称不变；重新启用后菜单回来、页面内容还在。
  - **D4** ⌘K 按名称、标签、正文都找到；无匹配有提示；⌘⇧P 命令面板过滤并执行“主题：深色/浅色”。
  - **D5** 浅色、深色各一遍：欢迎、网址、提示词、综合（展开）、笔记（树+页）、集合、HTTP 请求与结果、示例、插件市场、文件、环境、工作区配置、插件页、设置菜单、命令面板、工作区管理，共 16 页 × 2 = 32 张 `docs/screenshots/round14-{light,dark}-*.png`。每页自动扫描所有可见文字对比度（含祖先背景叠加），低于 3:1 即失败；两套都 0 条。我也逐张看了 7 张（深色 http/plugin/welcome/tree-note/market，浅色 workspaces），没有错位或看不清。
  - **D6** 内核测试覆盖：读 `crates/kernel` 里的 Rust 测试源码（309 个），按资源增删改查、插件加载、清单校验、动作执行分类各 >10 个。**这条只检查“有没有测试”，真正运行是 `pnpm test:rust`**（我把它放进 e2e 是因为编译 3 分钟、不适合在 e2e 里跑）。
- `pnpm lint`、`pnpm typecheck`、`vitest run plugins`（19 文件 315 条）通过。

## 处理过的 todo 条目（插件范围）

| 条目 | 结论 |
|---|---|
| 清单里的 `legacyKinds`（第十三轮） | 已不存在（第十三轮测试会话已删），无事可做 |
| 插件市场清单有错的包显示原始键、可选（第七轮） | 已修：市场页现显示“不可用”+原因（截图 round14-*-market 可见 broken/unreadable 两行） |
| 市场下拉选后显示“未保存”（第七轮 V3） | 已修：round8 有用例，本轮市场页截图无此现象 |
| 网址输出文字不随语言（第十一/十二轮） | **以后**：输出 `label` 在协议里是 `string`，要变成 `Label` 是改协议，本轮“协议只增”；新运行的文字已随语言。 |
| 日语译文为自译 | **以后**：需母语者审阅，不是代码问题 |
| 市场里清单可读但装不了的包（夹具 broken-pack）安装前就标出 | **以后**：插件看不到内核的校验结果，需内核给一个“检查包”的宿主接口 |
| 各插件页在深色下的问题 | 已查：扫描+看图，没有发现；见上 |
| 表格单元格不支持图标/Label（第十二轮） | 以后（协议只增，需新列类型，非日常阻碍） |

## 我做的决定

- D6 用读源码计数而不是在 e2e 里 `cargo test`（原因见上）。
- 对比度门槛 3:1（大字/界面元素的 WCAG 下限），不用 4.5:1：外壳的次要文字（灰色辅助字）按 4.5 会有一批，需要外壳先定色；本轮没有 <3 的。想收紧可把 `ratio < 3` 改成 4.5 看结果。
- 扫描跳过 `<textarea>` 里的文字（文本节点在 DOM 里不是渲染文字）和 disabled 元素。
- 本机 1421 端口被别的会话占着，我用 `E2E_PORT=1473` 跑；配置本身没改。

## 看到但不在我范围（外壳，已追加到 todo.md）

- 连真内核时状态栏仍显示“部分演示数据”（`Some demo data`）。
- 控制台警告：`kernel-texts.ts` 缺 `network.allow`、`ui.theme` 两个参数名的文字。

## 没做 / 没验证

- 第二阶段（中日译文）。
- 没有桌面窗口（Tauri）里的截图，只有 Chromium 预览 + 真内核。
- 全部 e2e 的结果见下方“全套 e2e”一节。

## 全套 e2e

`cargo build -p onedesk-worker -p onedesk-host` 后 `E2E_PORT=1473 pnpm exec playwright test`：**237 条全部通过**（24.5 分钟）。跑完用 `git checkout -- docs/screenshots` 还原了基准截图。`pnpm test:rust`、`pnpm clippy`、完整 `pnpm check` 我没有跑（不在本阶段范围，D6 的实际运行归它们）。

## 审查后的修改（round14-review #4–#7，D411）

- **#4** D6：改成按主题列出 19 个具体 Rust 测试名，逐个断言在 `crates/kernel` 里存在；注明只查存在，执行与通过归 `pnpm test:rust`。
- **#5** 对比度扫描按 D411：正文 4.5:1，大字（≥24px，或 ≥18.66px 粗体）与禁用态 3:1；文字色乘上元素及所有祖先的 `opacity`；`input`/`textarea` 的值与占位文字也扫（代码编辑器那种叠在高亮层上的透明 textarea 跳过，高亮层本身按文字扫）。扫描结果写到 `test-results/round14-contrast-{light,dark}.txt`；浅色、深色各一条 `D5 … contrast meets D411` 用例，有问题时 `test.fixme`，问题清零后自动变成真检查。
  **扫出的问题（共 1 类，14 处，两套主题 × 7 页）：禁用的“保存”按钮标签 `span.od-button__label`**
  - 浅色：文字 `rgb(162,168,177)`，背景 `rgb(243,244,246)`，**2.18:1**（需 3:1）
  - 深色：文字 `rgb(94,99,108)`，背景 `rgb(33,35,40)`，**2.6:1**（需 3:1）
  - 出现在：link、prompt、composite、tree-note（笔记）、collection、http、sample 页（凡有未改动的保存按钮的页面）。需要外壳改禁用态文字的 token 到 ≥3:1。
  其余文字（含输入框的值和占位文字、灰色辅助字）全部达 4.5:1。
- **#6** `ONEDESK_E2E_REQUIRE_DEVHOST=1` 时缺 devhost 直接失败，否则仍跳过。
- **#7** D3 断言该资源在树里的状态是 `disabled`；D5 去掉吞错误的 `.catch(() => undefined)`（那一行本来是多余的点击）。
- 验证：`pnpm typecheck` 通过；`round14.spec.ts` 里 D1–D4、D5 setup、D5 两套截图、D6 通过，两条 D411 用例为 fixme（上面的 14 处）。**没有**重跑全套 e2e。

## 第二阶段与合并后的全套 e2e

- 合并协调分支（外壳 c1e654a 之后）；补了 8 个键的中日译文（`kernel.label.ui.theme/ui.density/network.allow/process.allow/protection.readonly/protection.no_export`、`kernel.error.reason.readonly|layerName`、`kernel.error.reason.noExport|layerName`）；`vitest run plugins src/workbench/i18n` 22 文件 342 条通过（含语言一致性检查）。
- 全套 e2e（`ONEDESK_E2E_REQUIRE_DEVHOST=1`）：233 通过、3 跳过、**4 失败**，全在 `e2e/workbench.spec.ts`（假数据模式）：`screenshots light/dark › plugin page`、`tabs: pin, reorder…`、`plugin: disabling greys…`。单独重跑该文件，同样 4 条失败，不是负载问题。原因：它们 `tab(page,"SQL")` 找不到，页面快照里那个插件页标签的标题变成了 “…”（其余标签正常）。第一阶段合并前全套 237 条通过，所以是外壳在第十四轮的改动（审查 #1：切换语言后给后台标签改名/`tab-fields.ts`，假数据模式下插件页标签的标题被改成 “…”）引起的回归。属外壳文件，我没改。
