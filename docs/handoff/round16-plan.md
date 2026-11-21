# 第十六轮：阶段 6 第二部分——历史、查询目录与表

依据 `round15-plan.md` 的 D412 分轮安排、`sqlpool-parity.md` A、E、G、H 组。D418 的修复已经在协调分支工作区：页面参数仅存在当前窗口，旧布局加载即清除并回写；本轮为它补回归测试。

## 本轮范围

1. **E 历史与保存结果（X7）**：运行树可分别浏览最近运行与已保留结果；已保留结果有可读名称，可打开并完整分页；支持取消保留和带确认删除。每资源最近 200 次的规则保持不变，保留结果不受上限影响。
2. **A 查询目录（X13）**：新增 `org.onedesk.catalog` 插件，从用户授权的目录索引查询文件；保留外部路径键，支持重新同步、删除文件后标为失效、检查解析问题、另存为 SQL；环境、映射、时间切片、查询历史按 parity 清单实现。
3. **H 表（X9）**：新增 `org.onedesk.table` 插件，使用查询目录中的映射定义表，提供表树、按列取数与 parity 清单中的五种版本查询；使用现有树工具栏机制。
4. **G 环境数据源**：核实环境参数的 `datasource` 引用可由 SQL 插件按“语句 → 环境 → 工作区默认”解析；补足缺失的字段、验证和交互。

## 依赖与顺序

- 先封闭 D418 并完成 E 组基础闭环。
- 查询目录依赖 `files` 授权、资源外部键/批量更新、SQL 插件导出动作和工作区打开激活；先核实这些能力，再只为真实缺口扩展协议。
- 表插件依赖查询目录映射和数据源导出动作。
- 不在本轮实现第 17、18 轮内容。MCP 仍遵循已批准的 AI 接口设计与独立验收。

## 完成标准

- 对照 `sqlpool-parity.md` A、E、G、H 各行逐项记录通过/不通过/按新需求修改及验证方式。
- 新增内核行为有 Rust 覆盖，插件有 Vitest，端到端流程有真实内核 E2E。
- `pnpm check` 通过；真实运行验收并更新 `round16-acceptance.md`。

## 当前进度（2026-11-20）

- D418：外壳在恢复标签页时清空旧参数并立即回写；后续布局保存只落盘空参数。新增回归测试覆盖旧值清理、内存保留和持久化过滤。
- E/X7：运行记录树已拆为“最近运行”和“已保留结果”；保留结果默认使用运行标题，可取消保留，或确认后永久删除并清理留存结果文件。Rust 回归测试覆盖分组、命名、路径、确认及删除。
- G：SQL 插件已有“语句指定 → 环境 datasource → 工作区 datasource.default”的解析链；仍需核验用户在环境页设置引用的完整流程。
- 尚未开发：A 查询目录插件、H 表插件及 X13 工作区打开激活机制；本轮整体尚未验收。
- 已运行：`cargo test -p onedesk-kernel`、`pnpm test`、`pnpm typecheck`、`pnpm lint`、`cargo clippy -p onedesk-kernel --all-targets -- -D warnings`。全量 E2E 和 `pnpm check` 尚未运行。

## 分工（第六个协调会话，2026-11-21）

协调分支：`claude/onedesk-coord-6`（从 main `ec053c9` 切出）。各会话从它切出自己的工作树；一个文件同一时间只有一个写入者；会话之间只通过 `docs/handoff/` 交流。范围外的问题写进各自的 `round16-<块>-done.md` 的“范围外”一节，由协调会话汇总进 `todo.md`（各会话不直接改 `todo.md`）。

| 会话 | 模型 | 做什么 | 允许修改 |
|---|---|---|---|
| `r16-kernel` | Opus | X13 清单 `activation` 声明“工作区打开后”；核实并补齐查询目录所需的宿主能力：`files` 读授权文件夹、按外部键批量写入/按字段提交、资源“失效”状态（运行记录保留）、插件自己目录的 `files.*`（todo）；E3 从运行记录打开时带当时参数（X8 初始状态）的内核部分；X9 树清单的工具栏命令核实；被调插件的错误文字（已抹密钥）带回调用方（todo）。**协议新增的确切名字第一次提交后立即写进 `docs/handoff/round16-protocol.md`** | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS |
| `r16-shell` | Sonnet | 运行记录树两组（最近运行/已保留结果）的界面、保留结果改名、取消保留、删除确认；E6 保存结果标签页（工具栏、数据源、SQL、分页行）；E3 点开回到查询并带上当时的值；X9 树工具栏按钮渲染；节点“失效/缺失”状态的显示；环境页的资源引用（datasource）字段选择（G3）；todo 里外壳小项：`new:` 运行的“实际 SQL”一直 Loading、“1 rows”单复数、`network.allow`/`ui.theme` 文字；新文字只加英语 | `crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`vite.config.ts`、`package.json` |
| `r16-plugins` | Opus | 新插件 `org.onedesk.catalog`（A1–A10：索引授权文件夹、YAML 头解析与跳过原因、外部键=路径、只改正文与说明、删除即失效、映射文件 `{{实体}}`/`{{实体.字段}}`、时间版本实体与“截至时间”、检查警告条、按 id 前两段分组、另存为保存的 SQL）与 `org.onedesk.table`（H1–H5：映射里的表和列按前缀分组、一层/两层工具栏切换、缺失标记、表页可勾选列取行、五种版本查询），各带 `locales/`（英、中、日）和假 host 的 vitest。映射文件格式与 sqlpool 一致，写进 `plugins/org.onedesk.catalog/README.md` | `plugins/org.onedesk.catalog/**`、`plugins/org.onedesk.table/**` |
| `r16-tests` | Sonnet | 第一阶段：G 组核实（SQL 插件“语句 → 环境 → 工作区默认”的解析在真内核上走通，缺的在 `org.onedesk.sql`/`org.onedesk.datasource` 补）；准备本机临时 PostgreSQL（本机现在没有 PostgreSQL：先查 Homebrew/Postgres.app 是否可用，装软件须请用户批准，不能装就写明并告诉协调会话）；`scripts/check-arch.mjs` 排除迁移文件名与 `rusqlite`/`SQLITE_*`（todo）。第二阶段（各块合并后由协调会话通知）：`e2e/round16.spec.ts` 按 A、E、G、H 各行；外壳新增键的中日译文 | `plugins/org.onedesk.sql/**`、`plugins/org.onedesk.datasource/**`、`plugins/org.onedesk.lang.*/**`、`plugins/_testing/**`、`e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`docs/screenshots/` |

之后由协调会话做：合并（核对每个分支只改了自己范围）→ 对齐 → 独立审查（只读 Opus 子代理，写 `round16-review.md`）→ 第二阶段 e2e → 亲自验收（devhost，`ONEDESK_SECRET_STORE=memory`，scratchpad 数据目录）→ 完整 `pnpm check` → `round16-acceptance.md` → 经用户同意合并 main。

注意：本机主检出在 `/Users/chloe/onedesk/repo`（旧交接里的 `/Users/zhongpingxue/...` 已不适用）；磁盘剩约 14G，各会话不要保留多份 `target/`，构建完成后不要复制产物。
