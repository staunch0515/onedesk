# 任务：第十一轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round11-plan.md` 里定死的名字写（协议类型合并后才生成，先在外壳里按可选字段和本地类型写），假实现补上对应数据。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round11-plan.md` §6 外壳一行）
1. §3 外壳：界面文字 = 自带英语 + 所选语言插件的文字覆盖；语言选择器来自 `i18n.languages`，选择写工作区配置 `ui.language`；`languages` 主题；`lang` URL 参数仍可覆盖；日期、数字、排序用当前语言。第一阶段保留 `zh-CN.ts`（假数据模式用）；合并后协调会话会请你改为导入语言插件的 JSON 并删掉它。
2. §4：`ui` 主题的 `openExternal` 效果（桌面版经主进程用系统浏览器打开并再校验协议；浏览器里开新标签页）；文字节点 `format: "markdown"` 的渲染（`markdown-it`，D381 已记；关闭原始 HTML、链接协议过滤、`[[引用]]`、不加载图片；样式在 `src/design`）；启动页（`workspace.info.startupPages`）。
3. 新增文字（英语；中文、日语由语言插件提供——第一阶段中文先加在 `zh-CN.ts`，合并后随文件一起转走）。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round11-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round11-plan.md`、`docs/decisions.md` D378–D383、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。主进程里不写插件名字。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round11-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round11-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
