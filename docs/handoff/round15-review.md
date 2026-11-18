# 第十五轮独立审查（只读的 Opus 子代理，2026-11-19；第四个协调会话整理并分派）

范围：`git diff 67db30c HEAD`（插件第二阶段之前）。审查者只读代码。每条修改都要补测试；结果写进各自 `round15-*-done.md` 的“审查后的修改”。

| # | 级别 | 问题 | 位置 | 处理人 | 处理 |
|---|---|---|---|---|---|
| 1 | 必须修 | 只读可被 psql 元命令逃逸：`\gexec`、`\g` 换行 `COMMIT`、`\!`（本机任意命令、取出 PGPASSWORD）、`\o`、`\c` | `datasource/main.js:73-120,215-229` | 插件与测试 | D416 |
| 2 | 必须修 | 多语句检测与 PG 词法不一致（`E'\''`、标识符里的 `$`），能藏 `; COMMIT; DELETE` | `datasource/main.js:80-120` | 插件与测试 | D416 |
| 3 | 必须修 | 数据源清单没有 `exports.actions`，真内核下 SQL 运行整条走不通 | `datasource/manifest.json:23-27`；`sql/main.js:319` | 插件与测试 | 加上；e2e 连真内核覆盖 |
| 4 | 必须修 | SQL 调用没传 `{resource}`，带密码的数据源一定失败；`query` 不用 `ctx.resource` | `sql/main.js:319`；`datasource/main.js:382-390` | 插件与测试 | 先解析数据源 id（含环境、默认），以 `{resource:id}` 调用；`query` 用 `ctx.resource` |
| 5 | 应修 | psql 声明为随插件自带但包里没有；没用 `searchPaths`；`*` 只能整段，`postgresql@*` 写不出 | `datasource/manifest.json:17-20`；`manifest.rs valid_search_path` | 插件与测试；内核 | psql 改 system + `searchPaths`；内核允许一段里含一个 `*`（如 `postgresql@*`），仍只一段 |
| 6 | 应修 | `timeoutMs`/`maxRows` 没校验类型，直接拼进 SQL | `datasource/main.js:75,258-259` | 插件与测试 | 只接受正整数 |
| 7 | 应修 | 没走 X2，结果读进沙箱内存，截断后半截记录当一行、`total` 是假数 | `datasource/main.js:263-286` | 插件与测试 | 用 `transfer.capture` 到插件目录再交 `output.file` |
| 8 | 应修 | “实际发出的 SQL”按资源存，不按运行存；`new:` 页共用 | `sql/main.js:281-283,315-316` | 插件与测试 | 存进运行（输入快照或运行的输出页签） |
| 9 | 应修 | 参数必填与最大长度只写在提示里 | `sql/main.js:207-219` | 插件与测试 | 用 `required`/`maxLength` |
| 10 | 应修 | `CsvReader` 单字段/单记录无长度上限；开头 BOM 没去掉 | `datafile.rs:59-116,172-173` | 内核 | 单字段 1MB、单记录 4MB 上限，超出按截断处理；去 BOM |
| 11 | 应修 | 分页是平方级：`run.rows` 每次从头扫；外壳一口气把 `total` 行全拉进内存 | `runs.rs:641-670`；`result-area.tsx:24-50,298-320` | 内核＋外壳 | 内核记行偏移（每 1000 行一个）；外壳按可见区域按需读，复制超过 1 万行时提示用导出 |
| 12 | 应修 | `hand_over_file` 不查普通文件，`file:"tmp"`/`""` 会把整个目录搬走；没用上的交接文件不清理 | `calls.rs:133-151` | 内核 | 只接受普通文件；调用方运行结束时清理没用上的 |
| 13 | 只记录→本轮做 | 传输与 `output.file` 能写/删插件自己的 `bin/` | `carry.rs:222-246`；`runs.rs:476-506` | 内核 | 排除 `bin/` |
| 14 | 只记录→本轮做 | `actions.call` 不查被调动作的 `confirm`、`kinds`、被调方版本范围；等待时预算暂停 | `calls.rs:47-61,100-104` | 内核 | D417 |
| 15 | 只记录 | `searchPaths` 可指向人人可写的目录 | `process.rs:304-325` | — | 记 `todo.md` |
| 16 | 只记录→本轮做 | 只读事务防不住 `COPY … TO PROGRAM`、dblink；`sqlLiteral` 依赖 `standard_conforming_strings` | `datasource/main.js:75,218`；`sql/main.js:127-132` | 插件与测试 | D416 |
| 17 | 只记录→本轮做 | `notExported` 文字与参数名不对；`notOwnResource` 没文字 | `en-US.ts:684` | 外壳 | 修 |
| 18 | 只记录→本轮做 | 记住的导出目录被删后每次失败、无重选入口；同一秒两次导出撞名 | `transfer-dialogs.tsx:43-74` | 外壳 | 目录不存在时重新问；撞名加序号 |
| 19 | 只记录→本轮做 | `usePagedRows` 写在提前 return 之后 | `result-area.tsx:57-59` | 外壳 | 修 |
| 20 | 只记录→本轮做 | 禁用词检查漏 `postgresql`（protocol、worker、host）；`bodyOfSource` 接受任何 `:source` 结尾的类型；导入连接串时带密码的 URL 是否被持久化未核实 | `check-arch.mjs:47-86`；`datasource/main.js:291-294` | 插件与测试 | 修并核实 |

没有问题的检查点：D413 的依赖/导出/自身资源/嵌套/审计/超时；文件交接不覆盖、不越界；X2 截断、副本、`limit`、BOM 导出；X1 的路径规则；ssh 命令拼接只允许安全字符；密码只以 `{{secret:}}` 进环境变量、不进输入输出审计；`:name` 解析；外壳新字段只用基础组件；三语键齐全；内核无插件名。
