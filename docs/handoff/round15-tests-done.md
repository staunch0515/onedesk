# 第十五轮插件与测试：完成记录

分支 `claude/r15-tests-6af415`（已合并协调分支，含内核 D413/D414/X1/X2 与外壳；未推送）。

## 做了什么

- `plugins/org.onedesk.datasource`：类型 `source`（直连：主机、端口、库、用户、密码[密钥字段]；经 ssh：ssh 主机、容器、用户必填）；动作 `test`（测试连接，`SELECT version()`，`saveFirst`，页面有“保存并测试”）、`query`（`exports.actions`，在调用方给的 `{resource}` 上只读执行，psql 输出经 `transfer.capture` 写到 `tmp/q-*.csv`，作为 `output.file` 交给内核）；页面事件 `import`；设置 `statementTimeoutMs`（30000）。`psql`、`ssh` 都是系统自带，`psql` 带 `searchPaths`（`/Library/PostgreSQL/*/bin` 等）。
- `plugins/org.onedesk.sql`：类型 `query`（`sql`、`source`）；`:name` 参数识别；`-- @param 名 type=text|number|date|datetime|time|enum required max=N values=a|b -- 说明` 声明；表单字段用 `required`、`maxLength`、`datetime`/`time` 预设、`enum` 选项、`ref` 的数据源（`kinds` + 带空选项的 `options`）；数据源取用顺序：语句自己的 → 环境参数 `datasource` → 工作区配置 `datasource.default`（`host.params.config`）；动作 `run`、`newHere`；结果页签“结果 / 实际发出的 SQL（按运行存）/ 历史”；复制 SQL。
- 两个插件的中日英文字；外壳新键 `result.elapsed`、`field.timePlaceholder`、`kernel.error.reason.ownPrograms`、`wrongKind` 的中日译文（其余外壳写的 5 条译文复核过，保留）。
- `scripts/check-arch.mjs`：内核 `.rs` 里禁止 `"sql"` 字符串、postgres、pg_dump、statement_timeout、READ ONLY 事务语句；全部侧的禁用词加了 `postgresql`。（内核的迁移文件名 `*.sql`、rusqlite 不受影响。）
- `e2e/pg-fixture.ts`（`initdb` 到临时目录、随机端口、scram 密码、两个库）和 `e2e/round15.spec.ts`（20 个用例，没有 `test.fixme`）。

## 审查修改（`round15-review.md`）

| # | 做法 | 验证 |
|---|---|---|
| 1 反斜杠/psql 元命令 | 字符串、引号名、注释外出现反斜杠一律拒绝；只允许 SELECT/WITH/VALUES/TABLE/EXPLAIN/SHOW 开头；脚本多一行 `SET LOCAL standard_conforming_strings = on`；`psql -X`；`PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=…'`（ssh 经 `docker exec -e`） | vitest；e2e `D1: nothing outside…`（`\!`、`\gexec`、`\g`、`COPY … TO PROGRAM`、`DELETE` 都被拒，标记文件没出现，行数不变；直连会话只读时写入失败） |
| 2 PG 词法 | 自己的词法：`E'…'` 反斜杠转义、`$` 只在不是名字一部分时算美元引号、块注释可嵌套；多语句拒绝（SQL 插件的 `:name` 识别用同一套规则） | vitest（`E'\''; COMMIT; …`、`a$b$` 等）；e2e 同上 |
| 3 `exports.actions` | 数据源清单 `"exports": {"actions": ["query"]}`（初稿就有，审查看的是旧版） | e2e 整条链路连真内核 |
| 4 SQL 先选数据源再 `{resource}` 调用 | 是；`query` 用 `ctx.resource` | e2e F5 |
| 5 psql system + searchPaths | 是 | e2e 在本机 `/Library/PostgreSQL/15/bin` 找到 psql |
| 6 正整数 | `timeoutMs`、`maxRows` 只收正整数 | vitest |
| 7 X2 | `transfer.capture` + `output.file` | e2e 2.5 万行 |
| 8 实际发出的 SQL 按运行存 | `storage` 键 `lastSent:<runId>` | vitest；e2e D4（保存后运行） |
| 9 required/maxLength | 用了字段属性 | e2e C（“Fill in: since”）、vitest |
| 16 COPY TO PROGRAM | 页面上写明（`note.readonly`），并因首词白名单直接拒绝 | e2e |
| 20 | `postgresql` 进禁用词；`bodyOfSource` 已删（选数据源改用 `resources.list` 的类型）；**核实结果：带密码的连接串会被存进 `ui_state`（页面参数）**，见下“发现” | e2e `F6` 里的 `tablesWith` |

## 测试结果（本会话实际运行）

- `pnpm exec vitest run plugins`：21 个文件 378 个全过；`pnpm typecheck`、`pnpm lint` 通过。
- `pnpm exec playwright test e2e/round15.spec.ts`（`E2E_PORT=1459`，连真内核 + 本机 PostgreSQL 15.1）：20 个全过，约 1.4 分钟。
- 全部 e2e：见本文末尾“全部 e2e”一节。
- 没跑：`pnpm test:rust`、`pnpm clippy`（我没改 Rust）。

## B、C、D、F 各行（我这边验证的）

| 行 | 结论 | 怎么验证 |
|---|---|---|
| B1 新建/编辑/保存 | 通过 | e2e B1 |
| B2 分组 | 本轮没测（内核行，没有新代码） | — |
| B3 `new:` 未保存标签、首次保存才创建 | 通过 | e2e B1（点 Save & run 前资源数不变） |
| B4 保存并运行 | 通过 | e2e B1、D4 |
| B5 语句自己的数据源 | 通过 | e2e B1、F5 |
| B6 复制 SQL | 通过（吐司；剪贴板内容未读） | e2e B6、vitest |
| B7 ⌘Enter | 通过 | e2e B1 |
| C1 `:name` 识别（跳过字符串、注释、`::`） | 通过 | vitest、e2e C |
| C2 类型/必填/最大长度/枚举 | 通过（日期、时间、数字、枚举、必填；输入框不让输入不合法的值，运行时再校验一次） | e2e C、C2 |
| C3 时间选择与常用时间 | 通过（`datetime` 预设 5 个；`time` 字段 + 2 个预设）；预设按钮本身没点（只看到按钮） | e2e C、vitest |
| C4 空值 = NULL，字面量转义 | 通过 | e2e C、vitest（`'x''y'`、不能逃出字面量） |
| C5 参数先取环境值 | 通过 | e2e C5 |
| C6 说明悬停 | 部分：字段 `hint` 有，界面有 ⓘ 图标；悬停文字没读 | e2e 截图 |
| D1 只读、超时、行数上限 | 通过（超时：改设置 700 ms 后 `pg_sleep(5)` 被取消）。**按新需求改了**：只允许单条读语句；**行数上限**改为内核的 10,000 行（`total` 计全部），不再有插件自己的 1000 行 | e2e D1 ×3 |
| D2 行数、耗时、截断 | 通过 | e2e B1/D5/D8 |
| D3 排序（三态） | 通过 | e2e D3 |
| D4 实际发出的 SQL | 通过（保存后的语句）。未保存标签页直接运行时该页签一直“Loading…”（发现 3） | e2e D4（rpc 与界面） |
| D5 运行忙碌与计时 | 通过（进度消息显示；结束后耗时显示） | e2e D5 |
| D6 出错留在结果区、失败进历史 | 通过（需要把数据库的错误文字作为数据从数据源返回，见发现 2） | e2e D6、F1 |
| D7 导出 CSV 带 BOM | 通过（`run.export`，2.5 万行，前三字节 EF BB BF，每行都在）；界面“Export CSV”按钮没点（浏览器里是路径对话框） | e2e D8/D7 |
| D8 大结果不经插件内存 | 通过：2.5 万行，运行里存 1 万、`run.rows` 分页、界面滚到底能看到第 25000 行 | e2e D8 ×2 |
| F1 直连 | 通过 | e2e F1、F1 错密码 |
| F2 密码进钥匙串 | 通过：资源里只有 `{secret}`，数据目录所有文件、`secrets.list` 里都没有密码明文 | e2e F1/F2 |
| F3 经 ssh | 部分：用系统 `ssh`，参数正确（vitest），失败原因显示；**成功路径没有 e2e**（见发现 5） | vitest、e2e F3 |
| F4 测试连接 | 通过 | e2e F1 |
| F5 默认数据源与取用顺序 | 通过（语句 → 环境 → 工作区默认，没有则报错） | e2e F5 |
| F6 导入连接串 | 通过（密码不导入，提示）；发现 1 | e2e F6 |
| F7 钥匙串只读一次 | 没测（内核行） | — |

## 我做的决定

1. 只读执行比 sqlpool 更严：单条语句、首词白名单、反斜杠拒绝（D416 之外加了首词白名单，因为只读事务防不住 `COPY … TO PROGRAM`、`CALL`、`DO`）。
2. 数据源的 `query` 不抛错而返回 `{ error: "文字" }`，SQL 的 `run` 收到后抛出。原因：被调插件出错时调用方只得到没有文字的 `pluginError`。
3. 带宿主错误码（`invalid`、`notFound`）的插件错误，界面只显示码、不显示文字，所以插件的用户可见错误一律不带码。
4. 数据源页的 `test` 动作有 `saveFirst`，页面上另有“保存并测试”（`save-run` 角色）：测试连接用的是钥匙串里的密码，没保存就没有。
5. 表格结果里 NULL 与空串不分（psql `--csv` 的限制），都显示 NULL。
6. 新依赖：无。

## 发现（已记 `todo.md`）

1. 带密码的连接串粘进“连接串”框，明文进了 `ui_state`（页面参数落盘）。违反规则 7，需内核/外壳决定。
2. 被调插件出错时调用方拿不到错误文字。
3. 未保存的新 SQL 直接运行后，“实际发出的 SQL”页签永远在加载。
4. 外壳 “1 rows”。
5. 真 ssh 成功路径无法在 e2e 里做（OpenSSH 读 passwd 家目录，内核给外部程序的环境固定）。
6. psql 不区分 NULL 与空串。

## 没做 / 没验证

- B2（分组）、F7（钥匙串只读一次）：内核行，本轮没有改动，没有新测试。
- 界面“Export CSV”按钮、预设按钮、悬停说明没点；剪贴板内容没读。
- 真 ssh 成功路径；真 Docker 容器里的 psql。
- 暗色/截图：没有新增基准截图（`docs/screenshots` 已还原）。
- `pnpm check` 全套没有整体跑（单项见上）。

## 全部 e2e

`ONEDESK_E2E_REQUIRE_DEVHOST=1 E2E_PORT=1459 pnpm exec playwright test`（提交 a5d7d7b 的代码；先 `cargo build -p onedesk-worker -p onedesk-host`）：**259 通过，1 跳过（不是本轮的用例），0 失败**，17.6 分钟。基准截图已还原（本轮没有新增截图）。
