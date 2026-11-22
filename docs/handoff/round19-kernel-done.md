# 第十九轮 内核会话完成报告（r19-kernel）

协议与名字：`round19-protocol.md`（以它为准；§9 是实现备注）。

## 做了什么

- **操作者 `ai`**：`Actor::Ai { client }`（文字 `ai:<客户端>`）。线上由 `Request.actor` 盖章，或 `onedesk-worker --ai-client <名>` 整进程固定；对 `ai` **只放行** `hello`、`workspace.info`、`mcp.status`、`mcp.tools`、`mcp.call`，其余一律 `denied/aiNotAllowed` 并记审计 `mcp.refused`。管线再拦一道：`Actor::Ai` 的任何写命令 `denied/aiReadOnly`（唯一例外是内核替它写审计行）。
- **可见性**：迁移 `0014`（已有行全置 0，触发器让新行置 0）；`resource.setAiVisible`（含分组“含下级”）；`Resource.aiVisible`；AI 搜不到、读不到（一律 `notFound`，不泄露存在）。
- **工具**（都经 `mcp.call`）：`search`（只搜可见的，按相关度）、`describe`（只列清单声明 `ai.readOnly` 的动作及参数，静态或 `ai.describe` 动态；不返回资源正文）、`run`（环境固定为 `mcp.env`，`input` 恒空，AI 只能传声明过的参数）、`get_run`（只读自己起的运行，分页）、插件 `aiTools`（名字 `<id 非字母数字换_>__<name>`，JSON Schema 子集校验通过才交给插件，`ctx.ai` 可见）。
- **策略** `mcp.enabled / rate_per_minute / max_rows / allow_free_query / env`（工作区配置参数，已进 `params.known`）；`no_export` 与 `readonly` 对 AI 照样生效。
- **截断**：行数 ≤ `mcp.max_rows`、单元格 2000 字符、文字 65536 字符、整体 1 MiB；`truncated`、`total`/`totalChars` 如实给。
- **审计**：每次 `mcp.call`（含被拒、被限流）一条：工具名、参数摘要（字符串 80 字符、数组只记长度、含 password/secret/token/key/authorization 的键一律 `***`、深度 ≤ 2、≤ 1 KiB）、行数、耗时、成败、runId、资源。`AuditFilter.source`（`ai`）供审计页过滤。
- **清单**：`contributes.actions[].ai`、`contributes.aiTools`，写错安装拒绝 `badAiAction` / `badAiTools`。
- **无界面**：`crates/worker` 本来就是独立进程、不依赖窗口；新增 `--ai-client`，有真进程测试。
- 为让编译通过，`crates/host/src/lib.rs` 的 `Request { … }` 加了 `actor: None`（一行）。

## 怎么验证

- `cargo test --workspace` 全绿；新增 `crates/kernel/tests/round19.rs`（28 个）、`crates/worker/tests/worker.rs` 里 1 个真进程测试、`mcp.rs` 内 4 个单元测试、迁移 0014 升级测试。覆盖：每条拒绝（白名单外方法逐个、管线层逐个命令、`aiOnly`、信封非法、`notAiAction`、自由查询关着时 `notFound/tool`、`noExport`、`readonly`、`aiEnvMissing`、`needAction`、`badArguments`）、限流（含各客户端独立、夹取范围）、行/格/文字截断与分页、`ai_visible=0` 搜不到/描述不到/运行不了、密钥值（插件取过的密钥）不在结果、审计、运行记录、数据库任何表里。清单拒绝 20 余种写法。
- `cargo clippy --workspace --all-targets -- -D warnings` 干净；`pnpm typecheck` 通过；`pnpm gen:types` 已重新生成并提交。
- **`pnpm lint` 目前不过**：`scripts/check-arch.mjs` 的禁用词 `ai` 拦内核里的操作者 `ai`（42 处，全是 D448 要求的概念）。该脚本只许 tests 会话改，已报协调会话，建议从 `BANNED_WORDS` 去掉 `ai`（插件 id 那条检查仍查 `org.onedesk.ai`）。`check-ui` 通过。
- `pnpm test`（vitest）有 2 个 shell 文字检查失败，**属于 r19-shell**：`src/workbench/i18n` 需要给新审计操作 `resource.aiVisible`、`mcp.call`、`mcp.refused` 配文字，以及新错误原因 `aiOff`、`aiRateLimit`、`aiNotAllowed`、`aiReadOnly`、`aiOnly`、`notAiAction`、`aiFreeQuery`、`needAction`、`badArguments`、`aiEnvMissing`、`readonly`/`noExport`（已有）。

## 范围外 / 留给别人

- `onedesk-mcp` 程序、主进程转发时给 `actor` 盖章（连哪个套接字就固定盖哪个章，不信窗口自己写）、`.app` 打包：`r19-mcp`。
- 外壳：信息面板开关、AI 设置页（读写 `mcp.*` 配置参数）、审计页按 `source: "ai"` 过滤、i18n 文字（见上）、mock 里 `aiVisible`（TS 里是可选）：`r19-shell`。
- 插件：`ai` 声明、`aiTools`（`ai.describe` 动作返回 `data: { params, description? }`）、`locales` 里 `contributes.locales` 要声明：`r19-plugins`。
- 自由查询的 SQL 词法检查、只读事务、超时由表插件自己做（内核只管 `mcp.allow_free_query` 开关与 `freeQuery` 工具的可见性）。
- `status: running`（超过 `mcp_wait` 默认 30 秒才返回）路径只有代码，没有慢动作的自动测试（沙箱里没有计时器，留给 tests 会话用假慢服务验证）。

## D450 审查后的修改（第二次提交）

1. **AI 运行里宿主调用受限**：`CallInfo.ai`（经 `actions.call`/`interfaces.call` 传递），白名单见 protocol §10；测试 `inside_an_ais_run_…`：同一动作用户运行时写资源成功，AI 运行里 create/update/openExternal/notify/secret/POST 全部 `aiRun`，`resources.list/get` 只见可见的。
2. **限流以审计表为准**：`the_limit_holds_after_the_process_is_gone_and_comes_back`（重开内核后仍受限）、`calls_that_run_at_once_…`（并发 8 个只过 3 个）。
3. **审计截断与合并**：字段 80 字符；同类拒绝每秒最多 1 行并带 `suppressed`。
4. `search` 不返回 snippet；`run` 参数按声明/describe 答复校验（含 required 在没给 params 时也查）；describe 答复清理截断；`get_run` 再查可见性；等运行结束用事件。
- 注意：AI 运行里 `secrets.get` 现在一律拒绝（`aiRun`），所以第一轮“插件取过的密钥被抹除”的测试改成：AI 拒绝 + 用户运行仍抹除。
- 范围外：`describe` 的动态参数调用仍受 10 秒上限；`network` 只 GET 的检查在方法名层面（插件用别的头触发写的不管，它是 GET）。
