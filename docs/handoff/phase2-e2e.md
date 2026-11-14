# phase2/e2e：界面测试、截图与性能

分支：`worktree-agent-a65038e41a6315af2`（已合并外壳分支 `worktree-agent-a16d78ede4ece62d7` 的评审修复提交 a7f5d9d）。
worktree：`/Users/zhongpingxue/onedesk/repo/.claude/worktrees/agent-a65038e41a6315af2`

## 完成了什么

- `playwright.config.ts`：chromium、视口 1440×900、`webServer` 为 `pnpm exec vite --port $E2E_PORT --strictPort`（默认 1421，被占用时 `E2E_PORT=1431 pnpm e2e`）；单 worker；每个测试一个全新浏览器上下文，所以 localStorage（预览库）总是空的，外壳会写入 4 个示例资源 + 1 个集合。`reuseExistingServer: false`。
- `e2e/fixtures/`：`http-server.ts`（本地 node http，随机端口，开放 CORS；`/teapot` 返回 418，其余 200 JSON）、`app.ts`（`t()` 取 i18n 文案、`app` fixture 记录 `window.open` 调用以验证“网址打开”、授予剪贴板权限）、`helpers.ts`（新建资源、菜单跳转、命令面板）。选择器全部用角色/文案，文案来自 `src/shell/i18n/zh-CN.ts`，不依赖 CSS 类。
- 36 个用例，覆盖的流程：
  - 资源（`resources.spec.ts`）：网址新建并“打开”（平台 openExternal 被调用，参数正确）；笔记 markdown 阅读态（标题、列表、加粗）；提示词加两个参数（一个有默认值）→ 复制 → 参数对话框预填默认值 → 读剪贴板内容正确；HTTP 发送到本地服务 → 结果面板 + 响应视图显示 200 OK 与正文；非 2xx（418）如实显示；网络失败显示红色原因和处理方式；网址格式错误时字段下红字且焦点到该字段。
  - 导航（`navigation.spec.ts`）：启动菜单分组与底部四项；搜索按名称/标签/正文/无结果；⌘K 开关、按名称跳转、按正文、按标签、执行当前资源动作、从面板新建、前往页面；主题与密度切换并在刷新后保持（命令面板和设置页两种入口）；停用 HTTP 插件 → 菜单项消失、插件页“保留了 1 个资源”、全部资源中灰色 + “HTTP 请求（已停用）”、打开后有“插件已停用”提示、启用后恢复；停用 → 资源页启用 → 之后导航无误报“未保存”对话框；集合按类型创建；删除资源要确认；编辑未保存离开要确认；Tab 键序列每一步焦点环可见（≥ 12 步）、Enter 激活菜单项；⌘N。
  - 截图（`screenshots.spec.ts`）：浅/深各 4 张，见下。
  - 性能（`perf.spec.ts`）：5 次冷启动读 `[onedesk] menu-ready`。
- `docs/screenshots/{light,dark}-{menu-form,table,empty,error}.png`（整窗 1440×900）；没有动 gallery-*.png。
- `docs/perf.md`。

## 检查结果（合并外壳评审修复之后）

| 命令 | 结果 |
|---|---|
| `E2E_PORT=1431 pnpm exec playwright test`，连续两次 | 36 passed / 36 passed（各约 8 分钟，机器负载 400–900） |
| `pnpm coverage` | 35 文件、430 测试全过；语句 98.19%、分支 92.63%（阈值 80/70），无需补测试 |
| `pnpm typecheck` / `pnpm lint` | 通过 |
| Rust 测试、clippy | 未运行（未改 Rust） |

说明：合并前（外壳未修复时）“⌘K 按正文/标签搜索”“停用后在资源页启用再导航”两个用例是红的，我曾临时用 `test.fail()` 标注，合并修复后已全部去掉并通过，现在没有任何 `test.fail`/`skip`。机器负载极高时，第一次运行曾有 1 次截图用例因 10 秒默认超时失败，已把 expect 超时调到 15 秒；之后连续两次全绿。

## 截图观察（逐张用 Read 看过，均为合并修复后重新生成的版本）

- **light-menu-form**：左侧菜单分组标题（个人/工作）与条目对齐，当前项高亮；顶栏“新建”主按钮对比度好；字段卡片和“通用信息”卡片间距一致；必填星号为红色；保存/还原按钮禁用态为灰色，仍可读。侧栏标题行右侧有“+”按钮（修复后新增）。页面底部被截断是整窗高度 900 所致（页面可滚动），不是问题。
- **dark-menu-form**：输入框边框和卡片边界清晰；类型徽标（蓝）、分组/标签徽标对比度够；无发白或漏色的区域。
- **light-table / dark-table**：列头与内容左对齐，更新时间右对齐且等宽数字，行高一致；标签是小徽标。筛选的两个下拉较矮，和标题之间间距略紧但不重叠。表格下方大片空白是预期（只有 4 行）。
- **light-empty / dark-empty**：空集合显示表头 + 一句话提示；提示文字在 380px 宽的单元格内换行，最后一行只剩一个字“源。”（孤字），建议放宽提示宽度或缩短文案（见界面问题 1）。右下角吐司堆叠“已创建集合/已删除”，是操作后的瞬时状态，不影响。红色“删除集合”按钮在页头与“返回集合列表”并排，视觉很重，空集合时偏抢眼（建议次要样式，设计会话定夺）。
- **light-error / dark-error**：红色错误块含“发送失败 / 请求失败：网络请求失败：Failed to fetch / 处理方式：…”，浅色下红字在粉底上对比度足够，深色下红字在暗红底上可读；图标与标题对齐。下面“运行‘发送’查看响应”灰字提示在失败后仍显示，略显多余但不矛盾。原因文案里“请求失败：网络请求失败：”重复（见界面问题 2）。

## 性能数据

详见 `docs/perf.md`。冷启动到菜单（浏览器预览，vite 开发模式）：负载低时 1.5–1.8 秒（< 2 秒），负载 400–900 时 3–7 秒；未测打包产物和桌面应用。1 万条搜索：每个查询最快一次最慢 91 ms（< 200ms），高负载下单次最慢 325 ms。

## 发现的界面问题（未修，只记录）

1. 空集合提示换行留孤字：`src/shell/pages/collections-page.tsx` 的集合内资源表空状态（文案 `collections.itemsEmpty`，`src/shell/i18n/zh-CN.ts`）。复现：删除全部笔记 → 集合 → 新建“按类型：笔记” → 打开集合，提示第二行只剩“源。”。
2. 错误文案重复前缀：HTTP 请求连不上时显示“请求失败：网络请求失败：Failed to fetch”。前一个来自插件 `src/plugins/http-request/index.ts`（`请求失败：${reason}`），后一个来自平台 `src/platform/http.ts`。复现：新建 HTTP 请求，网址 `http://127.0.0.1:1/x`，发送。另外原因里是浏览器英文原文 “Failed to fetch”。
3. 一个页面两个 h1：笔记阅读视图里 markdown 的 `# 标题` 渲染成 `<h1>`，与页面标题 h1 并存（读书笔记示例即复现）。建议 markdown 标题整体降一级。e2e 用 `.first()` 绕过。
4. 插件页底部“加载失败”表和设置页“插件加载错误”重复同一张表（同一个 aria-label “加载失败”）；无错误时占一块空间。
5. Radix Select 控制台警告：“Select is changing from uncontrolled to controlled”，出现在新建集合对话框选择“规则”后（`src/shell/pages/collections-page.tsx` 的值选择器初始 value 为 undefined 后变为字符串）。无功能影响。
6. 命令面板 `Suggestions` 的 listbox 无中文名称（`aria-label` 是 cmdk 默认的英文 “Suggestions”）。读屏会读英文。

## 决定

- 命令面板、搜索页的断言按可见文案，不依赖列表顺序；资源标题断言用 `.first()`（见问题 3）。
- 性能测试不断言 2 秒（负载相关），只防卡死（< 30 秒）；2 秒需求按 `docs/perf.md` 记录人工判断，后续建议在空闲机器 + 打包产物上重测。
- 为了得到“空集合”截图，用例先删除示例笔记再建“按类型：笔记”的集合，没有改源码或种子数据。
- HTTP 目标服务开放 CORS（预览模式下页面直接用浏览器 fetch，受同源策略限制，桌面应用无此限制）。
- 键盘导航只验证“Tab 顺序上每个元素焦点环可见”和 Enter 激活，不验证拖动排序。

## 还缺什么

- 打包产物（`pnpm build`）与桌面应用的冷启动数据；空闲机器上的搜索数据。
- 拖动排序、导入导出、密钥增删改、插件设置抽屉、卸载/重新安装没有 e2e 用例（导入导出依赖原生文件夹选择，预览模式不可用）。
- Safari/WebKit 未测（只有 chromium）。

## 需要谁确认

- 主会话：`pnpm check` 里 `pnpm e2e` 目前约 8 分钟（机器高负载时），平时应明显更短；如需缩短可把截图用例拆成单独的 `pnpm e2e:shots`（需改 package.json，不在本任务范围）。
- 主会话：上面“发现的界面问题”转给外壳/设计会话；修复后截图需重新生成（`pnpm e2e` 即会覆盖）。
