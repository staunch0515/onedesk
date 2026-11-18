# 第十五轮：阶段 6 第一部分——数据源与保存的 SQL（协调会话定，2026-11-19）

依据：`dev-plan.md` 阶段 6；验收条件 `docs/redesign/sqlpool-parity.md`（以它为准，`docs/design/sql-plugin.md` 只作参考）；内核要补的 X1–X13 已在 `kernel-design.md`（D238–D246）。被替代的旧程序在 `/Users/zhongpingxue/quizbuks/sqlpool`（只读参考：连接方式、查询与结果的行为、字段）。决定从 D412 起编号。

## 阶段 6 分轮（D412）

| 轮 | 内容（`sqlpool-parity.md` 第 3 节的组） |
|---|---|
| 15 | F 数据源、B 保存的 SQL、C 参数与表单、D 运行与结果；需要的内核补点（X1、X2、X3、X4、X8，及缺的部分） |
| 16 | E 历史与保存的结果（X7）、A 查询目录（X13）、H 表（X9）、G 环境里的数据源 |
| 17 | I 服务器命令与本机脚本（X10）、J 备份、L 界面剩余项；硬盘文件、API 连接 |
| 18 | K AI 插件（X5、X6）与 AI 接口（MCP，X11）——AI 接口的设计先由协调会话写出、**用户确认后**才开发 |

阶段 6 结束时按 `sqlpool-parity.md` §5 逐行验收（同一份查询在 sqlpool 和 OneDesk 结果相同）。

## 1. 做完是什么样（本轮）

- 新建“数据源”（PostgreSQL）：直连（主机、端口、库、用户、密码）和经 ssh（`ssh 主机 docker exec 容器 psql`，CSV 取回）两种；密码只进钥匙串（表单的密钥字段由框架写，资源里只有名字）；“测试连接”；默认数据源；从旧连接串导入。
- 新建“SQL”：未保存的新标签页（`new:`），第一次保存才成为资源；编辑器里写 SQL，`:name` 参数被认出（跳过字符串、注释、`::`），按类型生成输入框（文本、数字、日期、时间带常用时间、枚举、必填）；参数先取环境值；⌘Enter 运行；“保存并运行”。
- 运行：只读执行（`BEGIN READ ONLY … ROLLBACK`、语句超时、行数上限）；结果表格显示行数、耗时、是否截断；能看到实际发出的 SQL；出错留在结果区、失败也进历史；大结果经数据文件句柄交给外壳（不经插件内存）；导出 CSV（带 BOM，首次问目录并记住）由框架统一提供。
- 内核源码里不出现 `sql`、`postgres`、`ssh`、`docker`、`psql`（注释与本文件名除外），并入 `pnpm lint`。

## 2. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | 先核对 X1、X2、X3、X4、X8 在代码里做到哪了（`kernel-design.md` 对应节），缺的按设计补齐（协议只增）；数据源与 SQL 插件提出的内核缺口经协调会话转来再补；名字以 `kernel-design.md` 为准，设计没写到的自行定并写进交接文件，**协议新增字段在第一次提交后立即把确切名字发给协调会话** | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS |
| 外壳（Sonnet） | 表单字段：日期、时间（含预设值）、枚举、密钥字段（直接写钥匙串）；SQL 编辑器（语法着色若已有就复用）；结果表格读数据文件句柄、导出 CSV、复制；运行时的忙碌与计时；`new:` 标签页与“保存并运行”的外壳部分；新增文字（英语） | 同前几轮 |
| 插件与测试（Sonnet） | 第一阶段：`org.onedesk.datasource`（类型、连接、测试连接、只读执行导出给别的插件、默认数据源、导入连接串；连接程序按 X1 的“系统自带”或“随插件自带”取 `psql`）与 `org.onedesk.sql`（类型、`:name` 解析、参数表单、运行、结果）；假 host 的 vitest；`scripts/check-arch.mjs` 加内核禁用词。第二阶段：`e2e/round15.spec.ts` 连真内核和**本机临时 PostgreSQL**（`initdb` 到临时目录、随机端口；机器上没有 PostgreSQL 就写明并告诉协调会话），按 B、C、D、F 各行做一遍；中日译文 | `plugins/**`、`e2e/**`、`scripts/check-*.mjs`、`docs/screenshots/` |

## 3. 完成标准

- 完整 `pnpm check` 通过；`round15.spec.ts` 没有 `test.fixme`；B、C、D、F 每一行在交接文件里写明“通过/不通过/按新需求改了”和怎么验证的。
- 新依赖按规则 9 先写进交接文件（用途、替代、许可证），由协调会话记入 decisions。
- 测试绝不连真实数据库或服务器，只用临时 PostgreSQL、本机 ssh 替身（若做经 ssh 的测试，用一个假的 `ssh` 可执行文件在临时目录里模拟）。
