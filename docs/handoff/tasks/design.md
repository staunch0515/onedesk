# 任务：设计系统与基础组件（分支 phase1/design）

**目标**：建立 token 与全部基础组件，外观达到成熟专业软件水平（浅色/深色、两档密度），并提供一个组件展示页供检查与截图。

**允许修改**
- `src/design/**`
- `src/main.tsx`（本阶段临时用来渲染组件展示页；第二阶段由外壳接管）
- `docs/handoff/phase1-design.md`、`docs/screenshots/gallery-*.png`

**只读依赖**：`docs/requirements.md` B 节（界面要求，逐条满足）、`docs/decisions.md` D30–D34、`scripts/check-ui.mjs`（规则）

**要点**
- `src/design/tokens.css`：唯一定义数值的地方。颜色（中性色阶、一个品牌强调色、成功/警告/错误/信息，含 subtle 背景与文字色）、字号阶梯 12/13/14/16/20/24 与行高、字重、`font-variant-numeric: tabular-nums` 工具、4px 间距栅格、圆角、边框、阴影（克制）、动效时长 120/160/200ms 与缓动、z-index 层级、控件高度、侧栏宽度、焦点环。`[data-theme=light|dark]`、`[data-density=comfortable|compact]`；未设置时按 `prefers-color-scheme`。所有正文/次要文字与背景对比度 ≥ 4.5:1（写一个小测试或脚本计算并在交接文件列出数值）。
- 组件（每个一个 `.tsx` + `.css`，类名 `od-`，只引用 token）：Button（primary/secondary/ghost/danger，sm/md，loading，图标）、IconButton（必须有 aria-label + Tooltip）、Input、Textarea、Select（Radix）、Switch、Checkbox、FormField（label/描述/错误）、Table（表头、数字列右对齐、行悬停、选中、空态插槽）、Dialog、Drawer、Tabs、Badge、Banner（提示条：info/success/warning/danger）、Toast（Radix，含 provider 与 `useToast`）、DropdownMenu、Tooltip、Kbd、Spinner/Progress、States（`LoadingState`、`EmptyState`（一句话 + 可选动作，无插图）、`ErrorState`（原因 + 处理方式 + 重试））、布局原语（`AppShell` 侧栏+顶栏+内容、`Sidebar`/`NavGroup`（可折叠）/`NavItem`（选中、禁用灰色、警示图标、拖动手柄插槽）、`PageHeader`（标题区+操作区）、`PageBody`）、`CommandPalette`（cmdk，组、项、快捷键提示、空结果）、`Icon`（按 lucide 名字渲染，统一 1.75 线宽和尺寸 token）、`Markdown`（react-markdown + remark-gfm，排版用 token，不渲染原始 HTML）、`ThemeProvider`（theme: system/light/dark，density，写 `<html>` 属性；持久化由调用方传入回调，组件不碰 localStorage）。
- 组件内不得写死界面文案（中文）：文案全部由 props 传入（默认值只允许空或无文字）。
- 键盘：所有交互可键盘完成，焦点环清晰（`:focus-visible`）。动效只用 token，无弹跳。
- 展示页：`src/design/gallery/Gallery.tsx`，展示全部组件的各状态，顶部可切换主题和密度。`src/main.tsx` 临时渲染它。

**完成标准**
- `pnpm typecheck`、`pnpm lint`（含 check-ui）通过；组件测试（jsdom，`// @vitest-environment jsdom`）覆盖：Button 状态、Dialog 打开关闭与焦点、Tabs 键盘切换、Table 空态、ThemeProvider 属性写入、CommandPalette 过滤。
- 用 `pnpm preview:web` 或 `pnpm dev` 打开展示页，在浅色和深色下**亲眼检查**（用浏览器工具截图），保存 `docs/screenshots/gallery-light.png` 和 `gallery-dark.png`，并在交接文件写出你检查到并修正的问题。

**交付物**：分支 `phase1/design` 上的提交 + `docs/handoff/phase1-design.md`。
