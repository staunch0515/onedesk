# 第十六轮独立审查（2026-11-21）

只读 Opus 子代理，范围 `git diff ec053c9..ab5b1bc`，不看 `*-done.md`。协调会话复核了 #1、#3。每条修完都要补测试。

| # | 级别 | 问题 | 位置 | 处理人 |
|---|---|---|---|---|
| 1 | 必须修 | table 在树/页面/命令里调 `actions.call`，内核只允许在运行里（`denied/notInRun`），表树与表页打不开；假 host 允许随时调用所以测试没发现。按 D421 改 | `plugins/org.onedesk.table/main.js:246-299,365-392`；`crates/kernel/src/calls.rs:44` | 插件 |
| 2 | 必须修 | 每次运行写 `lastSent:<runId>` / `sent:<runId>` 存储键从不清理；约 1000 次后 `tooManyKeys`，所有运行失败（写在执行前）；大 SQL 超 256KB 报 `tooLarge`。改为轮换或放进运行输出 | catalog `main.js:1034`；table `main.js:443` | 插件 |
| 3 | 必须修 | `upsertByKey` 不在 `granted_before` 的 `ids` 里，经它新建/更新/恢复带 `grants` 字段的资源不记 `network.grant`（D307、第 10 轮 #10） | `crates/kernel/src/kernel.rs:391-404` | 内核 |
| 4 | 建议修 | 被调方错误只抹 `detail`，插件填的 `params` 原样回传调用方，可带出密钥值 | `crates/kernel/src/calls.rs:133-142` | 内核 |
| 5 | 建议修 | 同步报告 `storage.set` 可超 256KB，发生在 upsert 之后，命令显示失败且跳过清单丢失 | catalog `main.js:756` | 插件 |
| 6 | 建议修 | 遍历不按真实路径去重（`loop -> .` 递归占满 `MAX_FILES`），截断不报，后面的真实文件被误标失效。截断时不得标失效并在报告里写明 | catalog `main.js:651-664,744` | 插件 |
| 7 | 建议修 | 目录树隐藏失效条目；按 D422 改为显示并标失效 | catalog `main.js:610` | 插件 |
| 8 | 低 | 恢复已删除条目时按头部 title 改名，覆盖用户改过的名字（A3） | catalog `main.js:740-743` | 插件 |
| 9 | 低 | `E:param` 渲染成 `E'…'`，`sqlLiteral` 只加倍单引号，`\'` 能结束字面量（只读未被绕过）。E 字面量里也转义反斜杠 | catalog `main.js:378,409-414,458`；sql 插件同写法 | 插件（catalog）、测试会话（sql） |
| 10 | 低 | “缺失”判断转小写，查询保留大小写加引号，`Orders` 显示存在但查询失败 | table `main.js:38-43,158-162` | 插件 |
| 11 | 低 | 表快照可超 256KB 单值上限 | table `main.js:297` | 插件 |
| 12 | 低 | 外壳写死插件参数名 `useState("datasource")`；默认留空或取自 `params.known` | `src/workbench/pages/add-param-dialog.tsx` | 外壳 |
| 13 | 低 | 外壳新增 24 键缺中日译文 | `plugins/org.onedesk.lang.*` | 测试会话（已分派） |
| 14 | 低 | `plugins/README.md:5-7` 关于被调方错误文字的说明已过时 | `plugins/README.md` | 测试会话 |
| 15 | 低 | `plugin_resource` 每行单独查 `external_key`，catalog 每次展开全量 `resources.list`：5000 条时每次约 5000 次查询 | `crates/kernel/src/host.rs:347-355` | 内核（批量取） |
| 16 | 待确认 | 自有目录 `bin/` 判断依赖 `canonicalize` 修正大小写，`BIN/x` 无测试 | `host.rs:444`、`carry.rs` | 内核（补测试） |
| 17 | 低 | 相对路径现在指向插件自有目录；catalog 的 `mappingFile` 填相对路径会悄悄读自有目录。catalog 拒绝非绝对路径设置 | catalog 设置检查 | 插件 |
| 18 | 测试缺口 | catalog/table 无真内核测试；`upsertByKey`+`grants` 审计；自有目录的符号链接/`..`/大小写；`workspace.opened` 未确认版本、`network.request` 被拒、60 秒时限、不自触发；被调方 `params` 带密钥；同步的符号链接循环、>5000 文件、报告超限 | — | 内核（内核部分）、测试会话（e2e） |

核对后没有问题的：自有目录 `..` 出不去、指向别的插件目录被拒；`upsertByKey` 只能写自己的类型、整批一个事务；`workspace.opened` 只发给已启用且版本已确认的插件；内核与主进程没有插件专有词；失效从搜索消失、运行记录与标签收藏保留；200 次修剪不删保留结果，删除保留结果清文件；外壳新 CSS 只用 token、文字都走 `t()`。
