# 第十五轮插件与测试：完成记录（第一阶段）

分支 `claude/r15-tests-6af415`。第二阶段（`e2e/round15.spec.ts`、中日译文核对、B/C/D/F 逐行验收）**尚未做**，等协调会话通知。

## 第一阶段做了什么

- `plugins/org.onedesk.datasource`：类型 `source`（直连：主机、端口、库、用户、密码[密钥字段]；经 ssh：ssh 主机、容器）；动作 `test`（测试连接，`SELECT version()`）、`query`（只读执行，给别的插件调用）、`list`（数据源列表）；页面事件 `import`（从 `postgres://` / `ssh://HOST/CONTAINER?user=&db=` 导入，密码不导入，提示用户填）；设置 `statementTimeoutMs`（30000）、`maxRows`（1000）；默认数据源取自参数 `datasource`（环境）→ `datasource.default`（工作区配置）。
- `plugins/org.onedesk.sql`：类型 `query`（`sql`、`source`）；`:name` 参数识别（跳过字符串、带引号的名字、`$$` 引用、注释、`::`）；`-- @param 名 type=text|number|date|datetime|enum required max=N values=a|b -- 说明` 声明；按类型生成输入框（日期时间带 5 个常用时间预设，UTC）；参数先取环境值；空值为 NULL；值渲染成单引号字面量；动作 `run`（⌘Enter、保存并运行）、`newHere`（在数据源上新建 SQL，依赖方动作，同时让 SQL 插件有权读数据源列表）；结果页签“结果 / 实际发出的 SQL / 历史”；复制 SQL。
- `scripts/check-arch.mjs`：内核 `.rs` 里禁止 `"sql"` 字符串、postgres、pg_dump、statement_timeout、READ ONLY 事务语句（内核自己用 SQLite，不能禁 `sql` 这个词）。
- 测试：`plugins/org.onedesk.datasource/main.test.ts`（25 个）、`plugins/org.onedesk.sql/main.test.ts`（26 个），假 host。`pnpm exec vitest run plugins`：21 个文件 372 个测试全过；`pnpm typecheck`、`pnpm lint` 通过。两份清单用一个临时 Rust 测试（已删）交给真内核的 `manifest::load_package_opts` 加载，通过。

## 我做的决定

1. **执行只读、单条**：和 sqlpool 一样包在 `BEGIN READ ONLY; SET LOCAL statement_timeout; … ROLLBACK`，另外**多拒一种**：文本里（跳过字符串/注释后）有第二条语句直接拒绝，否则 `…; COMMIT; DROP …` 能跳出只读事务。与 sqlpool 的差别（更严）。
2. 连接程序：`psql` 声明为 `source: "plugin"`、`path: "bin/psql"`（随插件包；本轮包里**没有**真的 psql 二进制，测试时链到 `plugin-data/<id>/bin/psql`）；`ssh` 为系统自带。`system` 的 psql 在固定目录里找不到本机的 `/Library/PostgreSQL/15/bin`。
3. 密码：`PGPASSWORD={{secret:名}}` 放进程序环境；`-w` 不提示输入。ssh 不传密码。
4. 主机、容器、库、用户只接受 `[A-Za-z0-9._@:-]`、不以 `-` 开头（同 sqlpool）。
5. 表格结果里 NULL 是 `null`，其余是字符串（CSV 无类型）；`total` 比 `rows` 多 1 表示被截断。
6. 数据源选择：语句自己的 `source`（资源 id）→ 环境参数 `datasource` → 工作区参数 `datasource.default`；值可以是 id 或名字。SQL 页的下拉用 `host.resources.list({kind:"org.onedesk.datasource:source"})`，所以数据源导出 `kinds: source {actions, read}`，SQL 有一个 `newHere` 动作写了该类型全名。
7. 必填、最大长度没有表单字段属性（`ViewField` 没有），放进字段的 `hint`；运行时再校验。

## 需要内核/协调会话的缺口（已发协调会话）

- **跨插件调用动作**：SQL 插件调 `ctx.host.actions.call("org.onedesk.datasource:query", {source, sql})`，现在内核没有 `host.actions`，也没有 `exports.actions`。数据源清单里还**没有**写 `exports.actions`（现内核会拒绝未知的导出项）；内核定了名字后补。
- 大结果经数据文件句柄（X2）：现在 `query` 把行放在内存里返回（上限 `maxRows`，默认 1000）。
- `ref` 类型的参数/表单字段（X4）：`datasource`、`datasource.default` 现在按“值 = 资源 id 或名字”的字符串读；SQL 的 `source` 是普通文本字段（下拉绑定），没有引用跟踪。
- 默认数据源在界面上怎么设置（工作区配置里一个参数）由外壳/内核决定；插件只读。

## 没做 / 没验证

- 没有对真的 PostgreSQL 跑过（第二阶段）；假 host 测试不证明 psql 参数在真程序上可用。
- 没有 `todo.md` 追加；没有中日译文的人工核对（只做了键一致检查，已通过）。
