# 范围外待办（第一个里程碑结束时汇总，主会话）

- 插件隔离：插件与宿主同进程，可绕过宿主 API（D58）。下一阶段：Worker/独立进程 + Rust 侧权限检查。
- 浏览器预览模式的 localStorage 持久化（T01）：第二个里程碑结束前评估是否保留预览模式。
- 多语言：内核、插件、平台、Rust 的中文信息抽取到资源文件（D134）。
- lucide 全量图标约 1.2 MB，改为按需加载（D121）。
- 附件：导出中的 `attachments/` 目前为空（D57）。
- 导入时校验标签中的 `"`、`\`（D113）。
- 跨分组拖动排序（D126）。
- 视觉回归：截图像素比对（D137）。
- 界面测试只覆盖 Chromium 预览；导入导出、钥匙串、卸载/重新安装没有 e2e（原生对话框与钥匙串在预览中不可用）。
- “动作执行中界面不冻结”没有自动化测试（动作是异步的，手动验证过）。
- 桌面应用内冷启动的自动计时；空闲机器上重测 docs/perf.md。
- 外部插件只能手写 `OneDeskError`（name/code 约定），可提供一个可复制的小运行时。

## 外壳会话（week1/shell）追加

- 发布构建：`pnpm build` / `tauri build` 还没验证。入口是 `workbench.html`，Tauri 的 `frontendDist` 默认找 `index.html`；需要把 `vite.config.ts` 的 `build.rollupOptions.input` 指向 `workbench.html` 并让打包后的首页叫 `index.html`（或加一个重定向页），内置插件目录要放进应用包的 `Resources/plugins`（主进程已按这个位置找）。
- 工作进程可执行文件的打包：发布构建里 `onedesk-worker` 要作为同目录的附带可执行文件（Tauri `externalBin` 或自定义打包步骤）。
- `playwright.config.ts` 的 `webServer.url` 是 `http://localhost:<port>`，而界面入口是 `/workbench.html`，Vite 对根路径返回 404，Playwright 会等到超时。插件与测试会话的分支已把它改成 `/workbench.html`；合并时保留那处改动。
- 大树分页：外壳现在一次把一层所有批次读完（上限 5000 个节点，`protocol/children.ts`）。文件树里有几万项时需要真正的虚拟滚动 + 按需分批。
- 混合客户端判断资源归谁用“先问内核、再回退演示”并缓存；演示数据与真数据的 id 万一相同会判错（真 id 是随机的，本周不会发生）。
- `page.event`（SQL 格式化等）仍由演示实现；内核没有对应方法。
