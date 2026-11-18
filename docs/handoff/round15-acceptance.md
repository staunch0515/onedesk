# 第十五轮验收记录（第五个协调会话，2026-11-19）

范围：阶段 6 第一部分——数据源与保存的 SQL（`round15-plan.md`，D412–D418）。审查 `round15-review.md`（20 条）。三个会话：内核 `r15-kernel`（2302776）、外壳 `r15-shell`（36baaec）、插件与测试 `r15-tests`（fc2ef30），都已合并到协调分支。

## 亲自验收

devhost（`ONEDESK_SECRET_STORE=memory`，数据目录在会话 scratchpad）＋临时 PostgreSQL 15.1（`initdb` 到 scratchpad，127.0.0.1:55491，表 `t` 2.5 万行）＋内置浏览器打开 `workbench.html?kernel=…&lang=zh-CN`，在界面上操作。截图 `docs/screenshots/round15-accept/`。

| 项 | 结果 | 怎么验证的 |
|---|---|---|
| F 新建数据源、密码、测试连接 | 通过 | 填主机/端口/库/用户/密码，“保存并测试”→“已连接。PostgreSQL 15.1 …”；密码框之后显示“已保存——输入新值可替换” |
| B 新建 SQL（`new:`）、保存并运行 | 通过 | 新建 SQL 标签显示“未保存”，选数据源、写 SQL，“保存并运行”后成为资源并运行 |
| C `:name` 参数 | 通过 | `… id >= :min_id AND name <> ':skip' -- :also_skip` 只认出 `min_id`；填 20、⌘Enter 运行 |
| D 运行与结果、实际发出的 SQL | 通过 | 24,981 行（正确），表格滚动按需每次取约 1000 行，滚到底最后一行 #24981 = id 25000；“实际发出的 SQL”页签为 `id >= '20'`，字符串与注释里的 `:skip` 原样 |
| D 只读与逃逸 | 通过 | `\gexec`（反斜杠拒绝）、`SELECT 1; COMMIT; DELETE…`、`E'\''` 藏分号（“一次只能一条”）、`DELETE FROM t`（只允许查询类）都被插件拒绝；`WITH x AS (DELETE …) SELECT` 被只读事务拒绝；之后 `count(*)` 仍为 25000；`$x$ ; $x$` 正常返回 |
| D 导出 CSV | 没亲手点 | e2e D8/D7 用 `run.export` 导出 2.5 万行并断言 BOM；界面上的“导出 CSV”按钮测试会话也没点 |

## 检查结果

- 测试会话：`round15.spec.ts` 20 个用例连真内核＋临时 PostgreSQL 全过、无 `test.fixme`；全部 e2e 259 通过、1 跳过、0 失败；插件 vitest 378 通过；lang-check 通过。
- 完整 `pnpm check`（`E2E_PORT=1434`）：见文末。

## 没做到 / 没验证

- 真 ssh 成功路径、真 Docker 容器里的 psql（只测了失败原因显示）；B2 分组、F7；界面“导出 CSV”按钮、预设按钮、悬停说明。
- 已知问题（D418）：页面参数存进 `ui_state`，粘贴带密码的连接串时密码明文进本机库——第十六轮先修。
- 其他发现已记 `todo.md`：被调方错误文字丢失（插件改为数据返回绕过；界面上错误为“pluginError — 插件运行时出错”＋英文详情）、未保存 SQL 的“实际发出的 SQL”页签一直 Loading、“1 rows”单复数、psql 不分 NULL 与空串。
- 一直没能验证的：桌面窗口里的画面、打包出的 `.app`、真钥匙串、https。

## 新增的决定

D412–D418。

### 完整检查

`E2E_PORT=1434 pnpm check`（协调分支 adea09f）：第一遍在 typecheck 失败（`round15.spec.ts` 7 处类型错误，测试会话修于 d8ed5ba）；第二遍类型、架构、界面规范、单元测试 666、Rust 测试、clippy 全过，界面检查 257 通过、1 跳过、1 失败——`round13.spec.ts` “workspace menu … deletes” 在全量负载下等删除超时；单独跑整个 `round13.spec.ts` 连续两次 12/12 通过；随后整套界面检查重跑一遍（`ONEDESK_E2E_REQUIRE_DEVHOST=1 E2E_PORT=1434 pnpm e2e`）259 通过、1 跳过、0 失败。判为负载下的偶发，记 `todo.md`。
