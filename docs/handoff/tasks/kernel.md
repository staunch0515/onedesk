# 任务：内核（分支 phase1/kernel）

**目标**：按 `src/kernel/contracts.ts` 实现完整的内核和两个平台适配，可被外壳直接使用，并有测试。

**允许修改**
- `src/kernel/**`（`contracts.ts` 除外，只读）
- `src/platform/**`（`contract.ts` 除外，只读）：`tauri.ts`（invoke Rust 命令 + @tauri-apps 插件实现 Platform）、`browser.ts`（浏览器预览：sql.js + localStorage 持久化（临时措施 T01）+ window.fetch + 内存 secrets + navigator.clipboard + window.open；`plugins.scan` 返回空；`files.*` 返回 not_implemented 错误或用浏览器下载实现导出）
- `docs/handoff/phase1-kernel.md`

**只读依赖**：`src/plugin-api/**`、`src/kernel/contracts.ts`、`src/platform/contract.ts`、`src-tauri/migrations/*.sql`

**要点**
- `createKernel(options): Promise<Kernel>` 从 `src/kernel/index.ts` 导出。内部拆模块：resources、search、collections、plugin-host（生命周期、清单校验、注册表、每个插件的 HostApi 与权限检查 D10/D13/D14/D60）、actions（runId、取消、输出校验 D56）、views（构建 ViewState、校验视图树 D64）、events、prefs、data（导出/导入 D57）。
- 浏览器适配与测试共用一个 TS 迁移执行器：用 `import.meta.glob("/src-tauri/migrations/*.sql", { query: "?raw", import: "default", eager: true })` 读同一批 SQL，在事务中执行，维护单行 `schema_version`。
- `src/kernel/testing/`：`createTestKernel()`（sql.js 内存库 + 模拟平台，可注入 fetch/clock），供插件和外壳的测试使用。拒绝打开非内存库（D26）。
- 搜索：`search_text` 由内核在写入时生成（JS toLowerCase）；多词 instr 交集；名称命中优先。
- 内核中不得出现任何具体插件名字或 kind（`pnpm lint` 检查）。测试用你自己在测试里定义的假插件（如 `org.test.sample`），不要依赖 `src/plugins`。

**完成标准**
- `pnpm typecheck`、`pnpm lint` 通过。
- `pnpm coverage` 通过（内核 ≥ 80%），测试覆盖：资源增删改查与乐观并发、body 校验、标签/分组/集合、搜索（名称、标签、正文、中文、多词）、清单校验（每种拒绝原因一个测试：格式错误、apiVersion 不兼容、id 重复、未声明的注册、扫描错误）、生命周期（安装→启用→激活→停用→卸载，停用后资源保留、动作视图消失，重新启用恢复）、动作执行（成功、插件抛错、输出类型不符、取消、插件停用）、视图渲染与校验、宿主 API 权限（读写范围、网络主机模式、密钥声明）、导出/导入（冲突覆盖/跳过）、迁移执行器（失败回滚）。
- 性能集成测试：插入 1 万条资源后搜索，记录耗时并断言 < 200ms（打印数值以便对比）。

**交付物**：分支 `phase1/kernel` 上的提交 + `docs/handoff/phase1-kernel.md`。
