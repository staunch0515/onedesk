# 任务：界面测试、截图与性能数据（分支 phase2/e2e）

**目标**：用 Playwright 驱动浏览器预览模式，覆盖主要流程并生成验收截图；补齐覆盖率缺口。

**允许修改**
- `e2e/**`、`playwright.config.ts`、`docs/screenshots/**`、`docs/handoff/phase2-e2e.md`
- 只为补覆盖率可新增 `src/**/**.test.ts(x)` 测试文件（不改源码）

**只读依赖**：全部源码、`docs/requirements.md`（G.5、G.6、D 节）

**要点**
- `playwright.config.ts`：`webServer` 运行 `pnpm preview:web`（端口 1421），chromium，视口 1440×900，每个测试前清空 localStorage（全新预览库）。
- HTTP 请求测试：在 `e2e/fixtures/` 起一个本地 node http 服务（随机端口）作为请求目标，不访问外网。
- 测试流程：新建四种资源并各自打开、使用（网址 open 被调用、笔记 markdown 显示、提示词填参数复制（读预览平台的剪贴板记录或 navigator.clipboard 权限）、HTTP 发送并在 response 视图看到状态码）；动作失败显示红色原因；搜索按名称/标签/正文；⌘K 命令面板搜索并跳转、执行动作；切换主题与密度；停用 HTTP 请求插件后菜单项消失、全部资源中灰色可见，重新启用恢复；页面键盘导航（Tab 焦点可见）。
- 截图（浅色、深色各一张，整窗）：菜单 + 资源表单（编辑视图）、表格（全部资源）、空状态（空集合）、错误状态（动作失败）→ `docs/screenshots/{light,dark}-{menu-form,table,empty,error}.png`。截图后用 Read 查看并在交接文件写观察结果。
- 性能：读取控制台 `[onedesk] menu-ready <ms>` 记录冷启动到菜单的时间（浏览器预览模式），写入 `docs/perf.md`（日期、机器、数值）。内核的 1 万条搜索数据也汇总进去。

**完成标准**：`pnpm e2e` 全部通过且稳定（连续跑两次）；`pnpm coverage` 通过；截图齐全并已查看。

**交付物**：分支上的提交 + `docs/handoff/phase2-e2e.md`。
