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

## 来自 week1-kernel（2026-11-15）

- 根 `Cargo.toml` 的 `[workspace.dependencies]` 里 `futures-util`、`libc`、`onedesk-host`、`tokio-tungstenite` 未被任何包用到时，每次 cargo 都打 4 条 “unused workspace dependency” 警告（外壳分支用上之后自然消失；否则删掉）。
- 架构检查（`scripts/check-arch.mjs`）给 Rust 内核加规则时：`files`（宿主能力名、清单 `requires.files`）、`text`（视图节点和字段类型）是协议里的机制名，不是插件名；应检查的是内置插件 id（`org.onedesk.*`）和它们的类型名。
- 审计的“合并计数”（kernel-design §4.3）未做：`audit` 禁止 UPDATE，需要另设计存法并加迁移。
