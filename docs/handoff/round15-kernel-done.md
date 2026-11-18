# 第十五轮：内核会话交接（2026-11-19）

分支 `claude/r15-kernel-92148f`（从协调分支切出），不推送、不合并。

## 核对结果（X1、X2、X3、X4、X8）

| 项 | 核对前 | 本轮做的 |
|---|---|---|
| X1 外部程序三种来源 | 已有（D331）：系统自带（固定位置 `SYSTEM_DIRS`，不靠终端 PATH）、随包自带（清单 `path`）、插件自己放进 `plugin-data/<id>/bin/` 的；环境变量、工作目录、同插件程序互相可见（PATH 含自己的 bin）、`process.ready` | **补**（协调会话要求）：系统程序的 `searchPaths` |
| X2 输出为数据文件句柄、框架导出 CSV | 只有内联表格；`run.export`（带 BOM）只导出存下的行；`transfer` 的文件端只能在用户授权的文件夹里 | **补齐**，见下 |
| X3 表单密钥字段直写钥匙串、缓存密钥 | 已有（D306）：`FieldKind::Secret` 的值在 `page.save`（含 `new:` 首次保存）由框架写钥匙串，插件只看到“是否已保存”；`secret_value` 读过即缓存在内存 | 无改动。缓存的寿命是整个工作进程，比设计“一次运行内”更长（同样满足 F7） |
| X4 引用参数、日期时间枚举字段 | 已有：`ParamType::Ref`（环境、配置，显示名由内核给出）；`FieldKind` 的 date、datetime、enum、`options`、`presets` | **补**：`ViewField.required`、`maxLength`（C2）；`FieldKind` 的 `time`、`ref` 与 `ViewField.kinds`（D414）；`host.params.config(name)`（F5 默认数据源） |
| X8 `new:`、初始页面状态、先保存再运行 | 已有：`new:<kind>?parent=` 目标与首次保存创建；`CommandEffect::Open.params`；清单动作 `saveFirst` / `ActionRole::SaveRun` | 无改动 |

另：**D413 插件调用依赖导出的动作**（协调会话转来，本轮必须）——此前没有实现，本轮补齐，见下。

## 新增接口（确切名字）

**协议（只增）**：
- `ViewField.required?: boolean`：外壳显示必填标记，空着时不让运行/保存；内核不校验。
- `ViewField.maxLength?: number`：文本字段最多可输入的字符数。
- `FieldKind` 加 `time`（`HH:MM[:SS]`，UTC，沿用 `presets`）、`ref`（值为资源 id）；`ViewField.kinds?: string[]`（全名或本插件短名）。`ref` 字段有 `kinds` 而没 `options` 时，内核在 render 后按类型列出插件看得见的资源（自己的类型；别的类型需 `requires.resources` 或对方导出 read）作 `options`，按名字排序，最多 1000（D414）。
- `RunOutput` 表格加 `paged?: true`：仅数据文件来的表格；`run.get` 只带前 200 行（`PAGED_FIRST_ROWS`），`total`、`truncated` 照旧（D414）。
- 新方法 `run.rows`（`method15::RUN_ROWS`）：`RunRowsParams { id, offset, limit }` → `RunRowsResult { rows, total }`；`limit` 1–1000，否则 `invalidParams`；有留存的整份文件时从文件读（能读到全部 `total` 行），否则从运行存下的行读。

**清单**：
- `exports.actions: ["<动作id>"]`（D413）：字符串数组，须是自己 `contributes.actions` 里的，不重复；否则 `badExports`。
- `requires.programs[].searchPaths`（X1）：仅 `source: "system"`；绝对路径、不含 `.`/`..`、至多一段**整段**的 `*`、最多 8 个，否则 `badPrograms`。固定位置找不到时按顺序再找；`*` 处按名字自然序从高到低（`16` 先于 `9`）；第一个存在的文件决定结果（不可执行 → `notExecutable`）。只按程序名、跟随符号链接到普通文件（与固定位置的规则相同）。

**宿主接口**（不在协议里）：
- `ctx.host.actions.call("<插件id>:<动作id>", input, { resource? })`（D413）：
  - 只在运行里；调用方须 `depends` 被调方、被调方 `exports.actions` 列出该动作，否则 `denied/notExported`（调自己、插件不存在也是这个；`params.action` 为所调动作）；不在运行里 `denied/notInRun`。
  - 以被调方身份执行：它的沙箱、程序、密钥、网络授权；策略按调用方标签页的环境；属于同一次运行（进度、取消、它启动的程序）。被调方的 `ctx` 有 `caller`（调用方 id）、`resource`、`envId`、`runId`，`target` 为 `core:none`。
  - `resource`：须是被调方自己类型的资源（否则 `denied/notOwnResource`），按它绑定的版本执行（§7.6），被调方可用它引用的密钥（D318）。
  - 嵌套最多 4 层；第 5 层或回到链上已有的插件 → `denied/callDepth`。
  - 调用方的动作时限在等待时暂停（D355）；被调方有自己的动作时限（超时 `invalid/timeout`）；运行被取消时被调方一并取消（各用各的取消令牌，因为一次调用结束会关掉它的令牌）。
  - 返回值是被调方 handler 的原样返回；其中 `output.file` 若指数据文件，内核把文件移到调用方目录 `tmp/call-<id>.<扩展名>` 并改写 `file`，调用方可直接作为自己的输出返回。被调方抛错 → `pluginError/calleeFailed`（`detail` 为错误首行）。
  - 审计：每次调用一条 `actions.call`，操作者为被调方，对象为动作全名，摘要 `{ caller, ms, ok }`；拒绝按宿主调用的通用规则记在调用方名下。
- `host.params.config(name)` → `{ found, value, sourceName }`：工作区配置里按名字取值（最深的定义处生效，§6.2）；密钥类型只给名字。`migrate` 里也可用（纯读）。
- 动作输出的**文件形式**（X2）：
  - `{ output: { type: "table", file, header?, columns? } }`、`{ output: { type: "text", file } }`。
  - `file`：相对路径 = 插件自己的目录 `plugin-data/<id>/`（不需要 `files` 授权，`..` 出不去）；绝对路径 = 插件自己的目录里，或按 `files` 的授权规则。
  - CSV：RFC 4180、UTF-8、逗号、双引号、LF 或 CRLF。**未加引号的空字段 = null，`""` = 空串**（psql `--csv` 的 NULL 与空串因此分得开）。`header` 默认 true；`columns` 给了就替换列名，个数须与字段数相同。每行字段数不同、未知键、别的输出类型 → `badOutput`。
  - 没给 `columns` 时列 key 为 `c0`、`c1`…；一列里存下的非空值全能读成有限数字时 `numeric: true`。值一律是字符串（不转数字，避免精度损失）。
  - 内核读完整个文件：全部记录计入 `total`；运行里最多存 `MAX_ROWS`（10,000）行、约 6 MB 单元格，多出的标 `truncated`。
  - 插件自己目录里的文件视为“交给内核”，读完即删；授权文件夹里的不删。
  - 被截断的表格，内核把文件留一份在 `<工作区>/run-files/<运行id>[.h].csv`；`run.export` 有这份时导出**全部行**（带 BOM、CRLF）；运行被删（每资源 200 条之外、删资源）后在下一次运行结束时清掉。
  - 文字：最多 6 MB，按字符边界截断。
- `transfer.capture` / `download` / `upload` 的文件端同样接受插件自己目录里的相对路径（例：`capture({ program: "psql", args: [...], to: "tmp/r.csv" })`，再返回 `file: "tmp/r.csv"`）。

## 内核禁用词

内核源码里作为标识符的 `sql`（`fn sql`、`from_sql`、局部变量）已改名为 `db_err`、`from_row`、`stmt_text`。剩下无法改的：迁移文件名 `migrations/*.sql`（`include_str!` 行，按规则 6 不改已发布迁移）、`rusqlite`、`SQLITE_*`。`scripts/check-arch.mjs`（测试会话）需排除 `include_str!` 行，按词边界匹配。

## B、C、D、F 中归内核的行

| 行 | 结论 | 怎么验证 |
|---|---|---|
| B3 新建先开未保存标签页 | 通过（已有） | 既有 `new:` 测试（pages.rs、round 测试） |
| B4 保存并运行 | 通过（已有，`saveFirst`/`save-run`） | 既有测试 |
| C2 必填、最大长度、各类型输入框 | 按新需求改了：协议加 `required`、`maxLength`；显示归外壳 | 协议序列化测试、生成的 TS |
| C3 时间字段带常用时间 | 通过（已有 `datetime` + `presets`） | 既有 |
| D7 导出 CSV 带 BOM、框架统一 | 按新需求改了：截断的表格导出全部行 | `round15.rs::a_long_result_is_cut_in_the_run_and_exported_whole` |
| D8 大结果不经插件内存 | 按新需求改了：文件形式的输出 | `round15.rs` 四条用例、`datafile.rs` 单元测试 |
| F1/F3 运行系统或自带的连接程序 | 通过（已有 X1） | 既有 round6/round8 测试 |
| F2 密码进钥匙串 | 通过（已有 D306） | 既有测试 |
| F5 默认数据源 | 按新需求改了：`host.params.config` | `round15.rs::a_plugin_reads_a_workspace_configuration_value` |
| D8 分页读取（D414） | 按新需求改了：`paged` + `run.rows` | `round15.rs` 两条用例（10,005 行与 3 行） |
| C3 time 字段、B5/F5 ref 字段（D414） | 按新需求改了 | `round15.rs::small_paged_tables_read_from_the_run_and_ref_fields_list_their_kinds` |
| F1/F3 用数据源的密码运行连接程序（D413） | 按新需求改了：`actions.call` | `round15_calls.rs` 三条用例（成功、数据文件移交、每种拒绝与 4 层深度） |
| F1/F3 找不在固定位置的程序（X1） | 按新需求改了：`searchPaths` | `process.rs::search_tests`、`manifest.rs` 校验用例（只用临时目录） |
| F7 一次运行只读一次钥匙串 | 通过（已有缓存，寿命为工作进程） | 既有测试 |

## 我做的决定（请协调会话编号记入 decisions）

1. 数据文件输出不改协议：存下来仍是 `RunOutput::Table`，外壳照旧画；“句柄”只在插件 → 内核这一段。理由：外壳不必新增读取通道，10,000 行以内与原来相同。若以后要在界面里翻看超过 10,000 行，再加 `run.rows`（分页读 `run-files`）。
2. 插件自己的目录成为 `transfer` 文件端和输出文件的一种范围，不需要 `files` 能力（设计 §7.5 的“三种范围”之一，此前未实现）。`files.*` 宿主接口本身仍未开放这个范围。
3. CSV 空字段：未加引号 = null，`""` = 空串。
4. 插件目录里的输出文件读后删除；授权文件夹里的不动。
5. 被调用的动作看不到调用方的页面参数（`ctx.params` 为空）；需要的值由调用方放进 `input`。
6. `ctx.host.actions.call` 不给调用方 `notExported` 以外的信息去探测别的插件有哪些动作（插件不存在与未导出同一个原因）。
7. `ref` 字段的自动选项只列插件本来就能读基本信息的资源，看不到的类型静默跳过。
8. 内核留存的完整结果文件不做密钥抹除（存下的行仍抹除）。只有声明了“需要密钥明文”的插件才可能把明文写进去，见 §13 的已知风险。

## 测试

测试只用临时目录与内存密钥库（`ONEDESK_SECRET_STORE=memory`），只运行系统的 `sh`、`seq`、`cat` 等，未碰钥匙串和 `~/Library/Application Support/onedesk*`。

- `cargo test --no-fail-fast -p onedesk-kernel -p onedesk-worker -p onedesk-protocol -p onedesk-host`：**569 通过，0 失败**（最后一次，含新的 `round15.rs` 5 条、`round15_calls.rs` 3 条、`datafile`/`process`/`manifest` 单元测试）。
- `pnpm clippy`：通过（修了两处本轮新代码的提示后）。
- `pnpm typecheck`：通过（gen:types 之后，含外壳已合并的 D414 代码）。
- **没跑**：`src-tauri` 那个 crate 的测试（磁盘满，见下）；`pnpm lint`、`pnpm test`（vitest）、e2e、完整 `pnpm check`。
- 中途一次全工作区测试里 `plugins.rs` 18 条和 `round9` 一条失败：原因是**磁盘只剩几百 MB**（`No space left on device`），建临时目录失败；单独重跑全部通过。本机磁盘 932G 已用满，各工作树的 `target/` 合计约 70G（week1-slice 12G、onedesk-coord-4 9.1G、r8-shell 8.2G 等）；我只删了自己工作树的 `target/debug/incremental`。请协调会话决定清理哪些旧工作树的 `target/`。

## 没做 / 没验证

- 没跑 e2e（本轮内核改动不涉及界面；Playwright 归测试会话）。
- `files.*` 宿主接口没有开放插件自己的目录。
- `run.rows` 分页读取超过 10,000 行：没做。
