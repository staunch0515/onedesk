# 第十九轮验收（2026-11-22，第七个协调会话）

范围：`ai-interface.md`（D415）——MCP：`onedesk-mcp` 命令行程序、内核操作者 `ai` 与通用工具（search/describe/run/get_run）、插件 `aiTools`、`mcp.policy`、审计、外壳（对 AI 可见开关、AI 设置页、审计过滤、Claude Desktop 配置）、SQL/查询目录/表插件的 AI 声明；决定 D447–D451。集成分支 `claude/onedesk-r19`，验收时 `df34fcf`。

## 结论：通过（带两条已知限制，见下）

| 检查 | 结果 |
|---|---|
| `pnpm lint`（含收紧后的 `ai` 例外）、typecheck | 通过 |
| vitest | 1146/1146 |
| `cargo test --workspace`、clippy | 732 通过 / 0 失败；无警告 |
| `pnpm e2e`（真内核 + PostgreSQL + 真 `onedesk-mcp`） | 395 通过、3 跳过、1 失败（`round14` 的 D5 光照截图用例 120 秒超时，单独重跑 10/10 通过）、4 条串行用例随之未运行（同一文件） |
| `round19.spec.ts` + `round19-sql.spec.ts` | 45 条通过，连续 3 次稳定，含限流并发 |

偶发：这一轮的几次完整 e2e 各有一条不同的用例偶发失败（`round12` http、`week1` files dark、`round14` D5 截图、`round19` 外壳开关——最后一条是用例竞态，已修），每条单独重跑都通过；完整套件在高负载下偏脆，已记入 `todo.md`。

## 协调会话亲自验收（真内核，应用没开的无界面路径，真 PostgreSQL；没调任何外部 AI 服务）

| 项 | 结果 |
|---|---|
| 总开关默认关 | 任何调用返回 `denied/aiOff` |
| 打开后工具列表 | `search`、`describe`、`run`、`get_run`、`list_tables`；自由查询工具关着时不出现 |
| 未标“对 AI 可见”的资源 | `search` 搜不到；`describe`、`run` 都 `notFound` |
| 带参数运行保存的查询 | `n=10`、`max_rows=3` → 3 行、`truncated`、提示被工作区限制截断 |
| 参数传注入式坏值 | `invalidParams`，未执行 |
| 审计 | 每次调用一条，操作者 `ai:<客户端名>`，只含工具名/对象/结果；SQL 内容未进审计 |
| 发现并修复 | 结果 `columns` 给的是键 `c0`/`c1` 而非列名 → 改为列名（`3e5333b`）并补测试 |

## 审查与修正

`round19-review.md`：必须修 4 条（AI 运行里插件宿主调用不受限、限流只在内存、审计无上限、禁用词例外不够窄），建议修约 10 条，全部处理并有测试。之后验收与 e2e 又发现：D450 误拒进程输出的 `transfer.capture`（D451）、限流并发 TOCTOU、`lint` 抓到的 SQL 里裸词 `ai`、缺 `aiRun` 外壳文字、结果列名。

## 没验证的

- **应用开着时的真套接字路径**（`mcp.sock`）：devhost 不带它；只有 Rust 真内核测试覆盖，没在打包的 `.app` 里手动验。
- **带密码的数据源经 MCP**：无界面进程看不到 devhost 的内存钥匙串，没动你的真钥匙串；e2e 用免密码角色。
- **Claude Desktop 本身**：没有用它连过，只用本仓库的假 MCP 客户端和 `--print-config` 输出。
- **自由查询 `run_sql` 打开后的成功路径**：只验证了关着不出现，以及 e2e 里的词法拒绝；黑名单挡不住未列入的函数，根本边界是只读事务 + 只读数据库角色。
- 桌面窗口画面、打包 `.app`。

## 已接受的限制

- 无界面进程每个 `onedesk-mcp` 进程一个随机客户端名后缀，`get_run` 只能读自己的运行；限流按全工作区所有 AI 客户端合计（D451）。
- `notifications/cancelled` 未做（可选）。
- 未知工具的拒绝因按秒合并没写审计行，不占限流额度。
- “含下级”开关在 e2e 里点不到（窗口里分组节点无页签），由 vitest 和内核用例覆盖。
