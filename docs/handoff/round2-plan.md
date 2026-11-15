# 第二轮：内核基础补全，原型的框架部分接上真数据（协调会话定）

依据：`docs/redesign/dev-plan.md` 阶段 1、2 的剩余部分；`docs/redesign/kernel-design.md` §3.4、§4.2–4.3、§5、§6、§10、§11。沿用 `docs/handoff/week1-protocol.md` 的全部约定（仓库结构、写入者、线格式、协议变更的规矩、共同规则）。决定 D273–D280 见 `docs/decisions.md`。
类型以 `crates/protocol/src/lib.rs` 末尾“round 1”一段为准（已生成 TS）。

## 1. 做完是什么样

打开应用：环境树、工作区配置树、收藏、已删除是真的；环境页（参数、来源层、继承图标、覆盖、改用继承值、“已变化”）、历史与恢复、审计页、顶部搜索是真的；语言、主题、密度存进内核，重启后还在。界面上“演示数据”只剩插件树与插件页、数据源、运行记录与结果区、任务面板、命令面板、SQL 等演示页面。

## 2. 范围

**做**：参数节点与环境（§6.1–6.2）；工作区配置；历史查看与按字段恢复（§4.2）；删除的恢复与永久删除（§3.4）；收藏（`resource_meta`）；搜索（§10 的搜索部分）；审计查看（§4.3）；启动快照（`backups/`，保留 7 份）；界面对应部分接真协议。

**不做（留到下一轮，原型里继续是演示）**：策略合并与保护参数（§6.3，等运行一起做）；引用 `refs`；参数声明 `param_decls`；密钥；导出导入；第一版旧库升级；插件安装、插件页、运行、命令面板；未保存时被别处修改的合并提示。

## 3. 方法（新增，全部要实现）

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `workspace.getConfig` | `ConfigGetParams` → `string \| null` | 在配置树里按名字取值（§6.2：子节点覆盖父节点） |
| `workspace.setConfig` | `ConfigSetParams` → `null` | 已有这个名字的节点就改那里；没有就写进根配置节点。发 `config` |
| `params.env` | `EnvIdParams` → `EnvView \| null` | 环境页的全部内容 |
| `params.envOptions` | — → `EnvOption[]` | 环境树按深度展开的列表（标签页的环境选择用） |
| `params.resolve` | `ParamsResolveParams` → `ResolvedParam` | 沿父链取值；没有环境或找不到：`found:false` |
| `params.set` / `params.unset` | `ParamSetParams` / `ParamNameParams` → `null` | 写入管线的字段级命令，字段是 `params.<名字>`；同名字段并发才冲突 |
| `params.acknowledge` | `ParamNameParams` → `null` | 把当前继承值记为这次覆盖的依据（清掉“已变化”） |
| `resource.history` | `ResourceIdParams` → `HistoryEntry[]` | 新的在前；相邻快照按字段比较得出 |
| `resource.restore` | `ResourceRestoreParams` → `null` | 取该条历史之前的快照里这个字段的值，作为一条新命令写回（op `restore`） |
| `resource.listDeleted` | — → `Resource[]` | 每批删除只列批的顶层节点 |
| `resource.undelete` | `ResourceIdParams` → `null` | 整批恢复；原父节点不在则放到树的根下 |
| `resource.purge` | `ResourceIdParams` → `null` | 只对已删除的资源；清除记录和全部历史快照，审计留一行不含内容的“已永久删除” |
| `resource.setFavorite` | `SetFavoriteParams` → `null` | 写 `resource_meta`（本机数据，不进历史）；发 `tree:favorites`、`resource:<id>` |
| `search.query` | `SearchQueryParams` → `SearchHit[]` | 见 §5 |
| `audit.list` / `audit.facets` | `AuditFilter` → `AuditRow[]` / — → `AuditFacets` | |

`tree.list` 增加内核自带的树：`env`（存储树，只放 `core:env`，可嵌套）、`config`（存储树，只放 `core:config`）、`favorites`（内核给出的列表）、`deleted`（内核给出的列表）。`page.resolve`：`resource:<环境id>` → `page: "env"`；`resource:<配置节点id>` → `page: "view"`，内核按参数表生成一个 `stack` 表单（字段 `bind: "params.<名字>"`，类型由参数类型决定，`autosave: true`）；`core:audit` → `page: "audit"`；`core:deleted` → `page: "deleted"`。`page.save` 对参数节点接受 `params.<名字>` 这种绑定路径。

内核命令新增：`env.newChild`（在 `context.nodeKey` 下或根下建环境，效果 `reveal` + `rename`）、`node.favorite` / `node.unfavorite`、`deleted.restore`、`deleted.purge`（先返回 `confirm` 效果，带 `args.confirmed` 才执行）、`open.audit`、`open.deleted`。各树节点的右键项相应给出。

## 4. 参数与环境（D273–D276）

- 参数节点的 body：`{ description, params: { 名字: { type, value, based_on? } } }`（§6.1）。`value` 一律存成文字；`list` 用换行分隔。
- 新工作区自带：环境树里一个根环境 `Default`；配置树里一个根配置节点 `Workspace`（D273）。已有的工作区在打开时补上（用一条迁移或启动时的内核命令，操作者 `core`）。
- 环境的父子就是树的父子；`core:env` 只能放在 `env` 树里，只能以 `core:env` 为父。移动环境 = 换父链。
- “已变化”（§4.2）：覆盖一个继承来的参数时，在 `based_on` 里记下当时继承到的值和它来自的节点；`params.env` 按当前父链重算继承值，与记下的不同就给出 `changedUpstream`。`params.acknowledge` 更新 `based_on`。
- `params.unset`：只删本节点自己的值。删掉后没有任何层定义它，这个参数就从环境页消失。
- 配置树：同名参数只允许出现在互为祖先的节点里；否则 `params.set` 返回 `invalid`（`reason: "duplicateName"`）（§6.2）。
- 语言、主题、密度是配置参数 `ui.language`、`ui.theme`、`ui.density`（D192），由外壳读写，内核不解释它们。
- 删除环境：按普通资源删除（连同子环境一批）。标签页选的环境被删后的处理是外壳的事：提示重新选择。

## 5. 搜索（D277）

- 写入管线在同一事务里维护每条资源的搜索文本（名称、说明、标签、body 里的字符串值）。新增迁移建全文索引表（FTS5，`trigram` 分词）；已删除的资源不在索引里。
- 查询：按空白分词，多个词必须同时命中；三个字符及以上的词走全文索引，更短的词用子串匹配（对中文有效）。
- 排序：名称命中优先 → 收藏优先 → 最近使用优先（`resource_meta` 的最近使用时间；`page.resolve` 一个资源算一次使用）。
- 不搜隐藏树（`core:plugin-state`）。本轮只搜资源；命令和插件清单的搜索留到下一轮。
- 性能测试：1 万条资源，查询 < 200 ms（release 构建下量，写进测试或交接文件）。

## 6. 历史、删除、审计、快照（D278–D280）

- `resource.history` 的字段路径：`name`、`description`、`tags`、`body.<键>`、`params.<名字>`、`parent`、`pos`、`deleted`。值转成文字（对象用紧凑 JSON）。`pos` 的变化不单独列出，除非那次修改只动了 `pos`。
- 按字段恢复（D278）：界面给的是历史条目；内核取该修订之前的快照里这个字段的值写回，记为一条 `restore` 修订，`restoredFrom` 指向被恢复的条目。
- 永久删除（§3.4）：一个事务里删掉该资源（及其批内后代）的 `resources`、`revisions`、`resource_meta`、搜索文本；审计一行，只有类型和 id，没有名称和内容。
- 审计查看：`audit` 表的行直接给出；`source` 是操作者类型；`target` 给名称（资源已不在则给 id）。审计的合并计数仍然不做。
- 启动快照（D280）：工作进程打开工作区、迁移之前，把 `workspace.db` 用 SQLite 的在线备份复制到 `backups/<时间>.db`，只保留最近 7 份；同一天内已有快照就不再做。
- 每个迁移都有升级测试（规则 6），包括“从 0001 的库升级后数据不丢”。

## 7. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3–§6 的内核部分 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改） |
| 外壳（Sonnet） | 混合客户端里把 §3 的方法改走内核；假实现里对应的树和页面去掉（环境、配置、收藏、已删除、审计、搜索）；环境页、配置页、已删除页、审计页、信息面板的历史、顶部搜索接生成的类型；语言、主题、密度经 `workspace.getConfig/setConfig` 存进内核；内核新增的命令、树、错误原因的文字；标签页选的环境被删后的提示 | 同本周任务书（`crates/host/**`、`src-tauri/**`、`src/workbench/**`、`src/design/**` 等） |
| 插件与测试（Sonnet） | 合并之后才开始：`e2e/round2.spec.ts` 连真内核检查 §1 的每一项并截图；架构检查的规则随新代码调整 | 同本周任务书 |

内核和外壳并行。外壳拿不到真内核时，按协议类型和本文件写，用假的内核客户端测；合并后由协调会话用真内核验收。界面外观不得走样：纯假数据模式（`e2e/workbench.spec.ts`）必须继续全过——所以假实现本身要保留完整，只是“有真内核时”这些方法不再走它。

## 8. 完成标准

- 内核：`cargo test -p onedesk-kernel -p onedesk-worker`、clippy、`pnpm check:types` 通过。必须有的测试：继承取值与来源层；覆盖后父值变化标“已变化”、改了父节点的别的参数不误标、换父节点后重算；`acknowledge`；配置同名规则；`params.set` 同名并发冲突、不同名都生效；历史按字段给出且新的在前；恢复产生新修订；整批删除的恢复（父节点不在时放根下）；永久删除后库里搜不到名称和内容；搜索（多词同时命中、两个字的中文词、已删除的搜不到、隐藏树搜不到、排序三条规则、1 万条的耗时）；审计过滤；收藏不产生历史；快照只留 7 份；迁移升级。
- 外壳：`cargo test -p onedesk-host`、clippy、`pnpm typecheck`、`pnpm lint`、`pnpm test`、纯假数据的 `e2e/workbench.spec.ts` 通过。
- 交接文件：`docs/handoff/round2-kernel-done.md`、`round2-shell-done.md`、`round2-tests-done.md`（格式同本周）。
