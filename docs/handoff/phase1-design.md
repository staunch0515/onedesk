# phase1/design：设计 token 与全部基础组件 + 组件展示页

> 实际分支名是 `worktree-agent-a6343da8d67135415`（会话按要求不切换分支），合并时按 `phase1/design` 处理。

## 完成了什么

- `src/design/tokens.css`：唯一定义数值的文件。中性色、品牌色 `--accent`、成功/警告/危险/信息（实色、`-subtle` 背景、`-text` 文字、`-border`）；字号 12/13/14/16/20/24 与行高；字重；4px 间距栅格；圆角；边框；阴影（xs/sm/md/lg）；动效 120/160/200ms 与缓动；z-index 层级；控件高度、侧栏宽度、最小宽度 1280；焦点环。`[data-theme=light|dark]`，未设置时跟随 `prefers-color-scheme`；`[data-density=comfortable|compact]`。所有 `font-family` 赋值也在这里（check-ui 只允许这里写）。
- `src/design/base.css`：重置、正文、滚动条、`.od-tabular`（表格数字）、`.od-visually-hidden`、共享关键帧、`prefers-reduced-motion`。
- 组件（`src/design/components/*.tsx` + 同名 `.css`，类名 `od-`，只用 token；`src/design/index.ts` 统一导出）：
  Button（primary/secondary/ghost/danger，sm/md，loading，前后图标）、IconButton（必填 label → aria-label + Tooltip，可带快捷键）、Tooltip、Kbd、Spinner/Progress、FormField（label/说明/错误，自动给控件接 id、aria-describedby、aria-invalid、required）、Input、Textarea、Select（Radix，支持分组）、Switch（Radix）、Checkbox（原生 input，含半选）、Table（表头、数字列右对齐 + 表格数字、行悬停、选中、灰色行、空态插槽、可键盘激活行）、Dialog / DialogClose、Drawer、Tabs、Badge、Banner、ToastProvider + useToast、DropdownMenu（项、复选项、分隔、标签、危险项、快捷键）、LoadingState / EmptyState / ErrorState、AppShell / TopBar / SearchTrigger、Sidebar / NavGroup（可折叠）/ NavItem（选中、灰色、警示图标、拖动手柄插槽、悬停操作）/ DragHandle、Page / PageHeader / PageBody、CommandPalette（cmdk：组、项、快捷键提示、空结果、加载中、可交给调用方过滤）、Icon、Markdown、ThemeProvider / useTheme。
  额外加了 `Stack`、`Text`、`Section`：让页面不用写一次性 CSS 就能排版（间距、字号/语气色、带标题的卡片）。
- 组件内没有中文界面文案：所有文字（含 aria-label、关闭按钮、空态文字）都由 props 传入。仅有的中文是开发者错误（`useToast/useTheme 必须在 Provider 内使用`）。
- 展示页 `src/design/gallery/Gallery.tsx`（+ `gallery.css`），`src/main.tsx` 临时渲染它；顶栏可切换主题/密度，也支持 `?theme=light|dark&density=compact`（截图用）；⌘K 打开命令面板。
- 截图：`docs/screenshots/gallery-light.png`、`gallery-dark.png`（1440 宽，2x，整页）。

## 改了哪些文件

- 新增：`src/design/tokens.css`、`base.css`、`index.ts`、`tokens.test.ts`、`testing/jsdom-setup.ts`、`components/*`（29 个组件 tsx + cx.ts + 28 个 css + 7 个测试）、`gallery/Gallery.tsx`、`gallery/gallery.css`
- 修改：`src/main.tsx`（临时渲染展示页）
- 新增：`docs/screenshots/gallery-light.png`、`gallery-dark.png`、本文件

## 测试与检查结果

- `pnpm typecheck` → 通过
- `pnpm lint` → 架构检查通过；界面规范检查通过
- `pnpm test` → 9 个文件 45 个测试全部通过（设计系统 8 个文件 39 个）
  - `tokens.test.ts`：深色两份定义一致、浅/深 token 集合一致、对比度
  - `button.test.tsx`：变体/尺寸类、点击、禁用、loading（aria-busy、spinner、阻止点击、标签保留）
  - `dialog.test.tsx`：触发器打开、名称与描述、焦点进入对话框且不落在关闭按钮、Esc 关闭并把焦点还给触发器、DialogClose 与关闭图标、不可关闭模式；Drawer 打开
  - `tabs.test.tsx`：方向键切换并激活、跳过禁用、循环、End
  - `table.test.tsx`：空态跨全部列、数字列右对齐 + tabular、选中/灰色行、点击/Enter/空格激活
  - `theme-provider.test.tsx`：写 `<html>` 属性、system 时移除 data-theme、回调、受控模式、不碰 localStorage
  - `command-palette.test.tsx`：按名称和关键词过滤、不会按内部 id 匹配、空结果文字、Enter 执行并关闭、`filter=false`
  - `icon.test.tsx`：kebab/Pascal/别名解析、未知名字回退
- 对比度（`OD_CONTRAST_REPORT=1 pnpm exec vitest run src/design/tokens.test.ts --silent=false` 打印全表）。文字要求 ≥ 4.5，焦点环 ≥ 3。各类最低值：

  | 组合 | 浅色 | 深色 |
  |---|---|---|
  | 正文 fg-default / 各背景（最低 bg-active） | 13.51 | 11.07 |
  | 次要 fg-muted / 各背景（最低 bg-active） | 5.31 | 5.73 |
  | 辅助/占位 fg-subtle（最低 bg-hover） | 4.61 | 5.34 |
  | 灰色资源 fg-inactive（最低 bg-hover） | 4.61 | 5.02 |
  | 选中 fg-selected / bg-selected | 6.71 | 8.19 |
  | 强调文字 accent-text（最低 accent-subtle） | 6.31 | 6.90 |
  | 白字 / accent、accent-hover、accent-active | 6.06 / 7.33 / 9.30 | 5.39 / 4.87 / 6.55 |
  | 白字 / danger、success | 5.27、5.42 | 5.27、5.42 |
  | 成功/警告/危险/信息文字 / 各自 subtle | 5.97 / 6.28 / 5.80 / 6.24 | 8.70 / 8.72 / 7.65 / 8.27 |
  | 工具提示 fg-inverse / bg-inverse | 14.59 | 14.41 |
  | 焦点环（最低 bg-selected） | 4.02 | 5.30 |

- 截图：Playwright 临时脚本（未提交）启动 `vite --port 1437`（1420/1430 被占用），浅/深色整页截图，另截了对话框、抽屉、菜单、吐司、工具提示、命令面板（有结果/空结果）、下拉、键盘焦点、紧凑密度做检查；浏览器控制台无错误或警告。结束后已停止 dev 服务器。

### 截图中发现并修正的问题

1. 许多图标显示成虚线圆（回退图标）：lucide 1.x 把 `trash-2`、`triangle-alert`、`circle-alert` 改了名，`icons` 表里只有新名字。`Icon` 现在也查 lucide 的别名导出，旧清单里的名字照样能用（有测试）。
2. 打开对话框后焦点落在右上角关闭按钮上，它的工具提示立刻弹出，而且第一次按 Esc 只关掉了工具提示。关闭按钮改到 DOM 最后并绝对定位，初始焦点落在内容/底部按钮上（删除确认时是“取消”）。同样改了抽屉。
3. 关闭按钮与标题第一行不居中：按标题行高重新计算了位置。
4. 页面头部的 Tabs 只用来切换时，空面板留下 16px 空白：空面板不再显示。
5. 快捷键里的 ⌘ 比字母小很多（SF Mono 的字形问题）：Kbd 改用界面字体。
6. Switch 的圆钮在深色下用 `--bg-surface` 太暗：新增 `--bg-knob`。
7. 灰色行/灰色菜单项原来用 `--fg-disabled`（对比度约 2.3）：新增 `--fg-inactive`（≥ 4.6），只有不可交互的控件才用 `--fg-disabled`。
8. 复选框的勾在 14px 下 1.75 线宽太细：新增 `--icon-stroke-mark: 2.5`，只用于勾。
9. 分组标题的折叠箭头放在左边时，标题文字和下面的菜单项图标对不齐：箭头移到右侧（展开时悬停才显示），标题与图标左对齐，同时给拖动手柄留出位置。
10. 展示页字号说明写错（“24 / 20”）：已改。

## 决定（请主会话汇总到 decisions.md）

- **主题 system**：`ThemeProvider` 在 system 时移除 `data-theme`，由 CSS `prefers-color-scheme` 处理，不需要 JS 监听也不会闪；`useTheme().resolvedTheme` 给需要知道实际主题的地方用。持久化只通过 `onThemeChange` / `onDensityChange` 回调（外壳存 app_settings）。
- **深色调色板写两遍**（`[data-theme=dark]` 和 `@media … :root:not([data-theme])`），因为 `light-dark()` 在 macOS 11/12 的 WebKit 不可用；有测试保证两份一致。
- **停用/失效的资源**：`NavItem disabled` 和 `Table isRowMuted` 用 `--fg-inactive`（仍满足 4.5:1），并且**仍可聚焦、可点击**，由调用方显示“插件已停用”之类的原因（配合 D15）。`aria-disabled` 只是标记，不阻止点击。
- **Tooltip** 每个自带 Radix Provider，不需要应用级包裹；代价是不同工具提示之间没有“跳过延迟”。延迟 400ms 写在 JS 里（Radix 要数字），与 `--duration-tooltip-delay` 保持一致。
- **Checkbox** 用原生 `<input type=checkbox>`（依赖表里没有 Radix Checkbox，不新增依赖）。
- **Progress** 用原生 `<progress>`，因为不允许内联 style 设置宽度。
- **Icon** 通过 `lucide-react` 的全部导出按名字查找（包括别名），整个图标集会打进包里（本地桌面应用可以接受）；未知名字显示 `circle-dashed`，不会报错。
- **CommandPalette** 只按标签、描述、keywords 匹配，不按内部 `group:id` 值匹配；需要内核搜索时传 `filter={false}` 和受控的 `search`。
- **Dialog**：`dismissible={false}` 时点遮罩和按 Esc 都不会关闭（保存过程中用）。
- 额外组件 `Stack`、`Text`、`Section`：外壳页面排版用，避免出现一次性 CSS。

## 还缺什么

- 没有为 Select、Switch、Checkbox、DropdownMenu、Toast、Sidebar 写组件测试（任务要求的 6 项都已覆盖）；这些只在截图里手动点过。
- 只在 Playwright 的 Chromium 里看过，没有在 Tauri（WKWebView）里实际运行。`:has()`（NavItem 菜单打开时保持显示操作按钮）在 macOS 11/12 不生效，会降级成只在悬停时显示。
- Sidebar 不含 dnd-kit 接线：NavItem 把 `style`/`ref`/`data-*` 传给 `<li>`，DragHandle 接收 `listeners/attributes`，由外壳接入（D31 允许拖动用的 transform 内联样式，外壳那一行需要写 `// od-allow-inline-style: …`）。
- 输入框边框（`--border-strong`）与背景对比约 1.6:1，没达到 WCAG 1.4.11 的 3:1 非文字要求（任务只要求文字 ≥ 4.5）。如果要做到，需要把边框调深，界面会显得更重。

## 需要谁确认 / 问题

- 主会话：上面“决定”一节写进 decisions.md。
- 主会话/外壳：第二阶段由外壳接管 `src/main.tsx`；展示页可以保留在 `src/design/gallery/` 用于以后截图，或者删掉。
- 主会话：`docs/screenshots/` 下的 gallery 截图是组件展示页，不是验收要求的应用截图（菜单、表单、表格、空状态、错误状态），后者要等外壳完成后由 e2e 生成。
