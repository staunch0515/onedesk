# round2 / kernel（分支 `claude/week1-kernel-9a967c`）：内核基础补全

先合并了 `claude/week1-slice-3b4ae5`（85c8b64，无冲突）。`round2-plan.md` §3–§6 的内核部分全部做了，没有砍（启动快照、审计查看也做了）。`crates/protocol` 未改。

## 完成了什么

| 部分 | 文件 | 内容 |
|---|---|---|
| 迁移 0002 | `migrations/0002_search_restore.sql` | 搜索表 `search`（FTS5，`trigram`）；`revisions.restored_from` |
| 启动快照 | `workspace.rs::snapshot` | 打开工作区、迁移之前 `VACUUM INTO backups/<YYYY-MM-DD-HHMMSS>.db`（UTC）；同一天已有就不做；只留最新 7 份 |
| 启动命令 | `pipeline.rs::startup` | 写入线程开始服务前，以操作者 `core` 补根环境 `Default`、根配置节点 `Workspace`（D273）；`meta.search_built` 不在时全量重建搜索索引。读取要等它提交之后才放行 |
| 参数表 | `params.rs`、`pipeline.rs` | body `{ "params": { 名字: { type, value, based_on? } } }`；字段 `params.<名字>` 的设置、删除、确认、按快照写回；配置同名规则 |
| 新命令 | `pipeline.rs` | `Restore`、`Undelete`、`Purge`、`Meta`（收藏、最近使用）、`Startup` |
| 搜索文本 | `pipeline.rs::index` | 与数据同一事务：名称一列，说明、标签、body 里的字符串、参数名与值一列；已删除和隐藏树不进索引 |
| 协议方法 | `round2.rs` | §3 表里的全部 17 个方法 |
| 树、页面、命令 | `kernel.rs`、`pages.rs`、`commands.rs` | `env`、`config`（存储树）、`favorites`、`deleted`（内核给出的列表）；`resource:<环境>` → `page:"env"`；`resource:<配置>` → 内核生成的自动保存表单；`core:audit`、`core:deleted`；`env.newChild`、`config.newChild`、`node.favorite`/`unfavorite`、`deleted.restore`、`deleted.purge`（先 `confirm`）、`open.audit`、`open.deleted` |

## 测试与检查结果

```bash
cargo test -p onedesk-kernel -p onedesk-worker
#   共 69 个，全部通过（新增：tests/round2.rs 12 个；workspace 单元测试 3 个：stamp、快照、迁移 0002）
cargo clippy -p onedesk-kernel -p onedesk-worker --all-targets -- -D warnings   # 0 警告
sh scripts/gen-types.sh --check                                                 # 协议类型是最新的
cargo test --release -p onedesk-kernel --test round2 -- search_over --nocapture # 1 万条的耗时，见下
```

1 万条资源的搜索耗时（release）在 2–38 ms 之间，见本文末“搜索耗时”。测试里断言 release < 200 ms、debug < 2 s。

必须有的测试与位置（都在 `crates/kernel/tests/round2.rs`，另注明的除外）：

| 要求 | 测试 |
|---|---|
| 继承取值与来源层 | `params_inherit_along_the_parent_chain_with_source_layers` |
| 覆盖后父值变化标“已变化”、改父节点别的参数不误标、换父节点后重算；`acknowledge` | `override_is_marked_when_upstream_changes_and_acknowledge_clears_it` |
| 配置同名规则 | `config_names_repeat_only_along_one_ancestor_line` |
| `params` 同名并发冲突、不同名都生效 | `param_saves_conflict_only_on_the_same_name` |
| 历史按字段、新的在前；恢复产生新修订 | `history_is_by_field_newest_first_and_restore_is_a_new_revision`（含参数字段、移动的恢复） |
| 整批删除的恢复（父节点不在时放根下） | `undelete_restores_the_whole_batch_and_falls_back_to_the_root` |
| 永久删除后库里搜不到名称和内容 | `purge_leaves_no_name_or_content_anywhere_in_the_database`（逐表逐列按字节查） |
| 搜索：多词同时命中、两个字的中文词、已删除搜不到、隐藏树搜不到、排序三条规则 | `search_matches_all_words_short_words_and_ranks` |
| 搜索 1 万条的耗时 | `search_over_ten_thousand_resources_is_fast` |
| 审计过滤 | `audit_list_filters_and_facets` |
| 收藏不产生历史 | `favorites_list_and_leave_no_history` |
| 快照只留 7 份 | `workspace::tests::startup_snapshots_once_a_day_and_keeps_seven` |
| 迁移升级（含从 0001 升级后数据不丢） | `workspace::tests::migration_0002_upgrades_a_0001_database_without_losing_data` |
| 内核树、默认节点、页面 | `kernel_trees_and_default_nodes_exist` |

## 我做的决定

1. **参数节点的说明**：用资源自己的 `description` 字段，body 里只放 `params`（计划里 body 的 `description` 不另存一份）。
2. **`based_on` 的记法**：`{ value, source }`，`source` 是继承值来自的节点 id。第一次覆盖一个继承来的参数时记下；之后再改这个覆盖值**不更新** `based_on`，只有 `params.acknowledge` 更新（否则改一下自己的值就会悄悄消掉“已变化”）。`changedUpstream` 只比较值（来源节点换了但值相同不算变化）；继承值消失时 `now` 为空串。
3. **`EnvParam.layers`**：只列祖先（从根到父），不含本节点；`effective` 标在继承值来自的那一层。只有祖先定义了这个参数时才给出。
4. **新增内核命令 `config.newChild`**：计划只有 `env.newChild`，但配置树要能建子节点才谈得上“同名只能在互为祖先的节点里”。行为与 `env.newChild` 相同（效果 `reveal` + `rename`），默认名 `New configuration`；环境的默认名 `New environment`（与 `New group` 同样是 id 式的默认值，重名时加序号）。
5. **配置的取值**：`workspace.getConfig` 取定义了该名字的最深的配置节点；`setConfig` 写到那个节点，没有就写进第一个根配置节点。任何 `core:config` 的修改都发 `config` 事件。
6. **`env`、`config` 树不允许分组**（`tree.createGroup` → `invalid`，`reason = "noGroups"`）；`core:env` 只接受 `core:env` 作子节点，`core:config` 同理；移到别的树是 `invalid`。
7. **历史条目**：id 是 `<rev>:<字段>`（修订序号在一条资源内唯一）。字段集合：`name`、`description`、`tags`、`body.<键>`、`params.<名字>`（值为参数的 `value`）、`parent`（父节点 id）、`pos`、`deleted`（`"true"` 或空）。创建那条修订给出所有非空字段（`before` 为空）。`pos` 只在一次修订只动了它时列出。
8. **按字段恢复**：`name`/`description`/`tags`/`body.*`/`params.*`/`parent` 可恢复；`parent` 的恢复是一次移动，记为 op `restore`。`deleted`、`pos` 返回 `invalid`（`reason = "notRestorable"`）。恢复成与现在相同的值不记。条目不存在 → `notFound`。
9. **整批恢复**：给批里任何一行都恢复整批；批的顶层节点原父节点不在（或也被删了）就放到所在树的根下，并排到末尾；每行一条 op `undelete` 的修订，审计一行。
10. **永久删除**：给的那一行和它下面已删除的后代一起清除（`resources`、`revisions`、`resource_meta`、搜索文本），之后对搜索表做一次 `optimize`，审计一行 `{kind, count}`。**审计里从此不记名称**：`resource.create` 的摘要以前带 `name`，现在只有 `kind`（第一轮建的库里已有的审计行仍带名称，审计表不可改，无法补救）。
11. **搜索**：三个字符以上的词走 FTS `MATCH`（每个词作为短语，`AND` 连接），更短的词在名称和文本上做不分大小写的子串匹配；多个词必须同时命中。排序：全部词都出现在名称里的优先 → 收藏 → 最近使用（`page.resolve` 一个资源记一次，写 `resource_meta`，不进历史和审计）→ 名称。`subtitle` 是祖先名称用 ` / ` 连起来（不含自己）。分组也会被搜到（目标 `resource:<分组id>`，打开是只有信息面板的页面）。
12. **审计查看**：`source` 取操作者文字里 `:` 之前的部分；`target` 是对象 id 对应的资源名（资源已删除仍能查到名字，被永久删除则给 id）；`result`：`ok` → `ok`，`failed:denied` → `denied`，其余失败 → `error`；`text` 在操作、对象、摘要、操作者里做子串匹配；`detail` 是摘要 JSON 原文。
13. **事件**：删除、恢复、永久删除都发 `tree:deleted` 和 `tree:favorites`；收藏发 `tree:favorites`、`resource:<id>`；每条写了审计的命令发 `audit`。
14. **列表树**（`favorites`、`deleted`）：`TreeInfo.source` 用 `provided`（协议里只有两种来源），`groups:false`，节点不可拖动、不可展开；收藏节点右键 `node.open`、`node.unfavorite`；已删除节点没有打开目标，右键 `deleted.restore`、`deleted.purge`（危险项）；`deleted` 树工具栏是 `open.deleted`。存储树节点的右键多了 `node.favorite` / `node.unfavorite`，环境节点多 `env.newChild`，配置节点多 `config.newChild`。
15. **`core:audit` / `core:deleted` 页面**：`title` 是目标本身（外壳按 id 配文字），`page` 为 `audit` / `deleted`，没有视图；内容由外壳用 `audit.list` / `resource.listDeleted` 自己画。
16. **环境页**：`page:"env"`、`usesEnv:true`、`hasInfo:true`、没有视图和 `values`；内容由外壳用 `params.env` 取。
17. **快照的时间**用 UTC 日期判断“同一天”；文件名能按字典序排序，保留规则按文件名。

## 新依赖

没有新增（FTS5 和 `VACUUM INTO` 都在已有的 rusqlite `bundled` 的 SQLite 3.54 里）。

## 协议变更

没有。外壳需要知道的新 id（都按 D262 原样显示 id，由外壳配文字）：命令 `env.newChild`、`config.newChild`、`node.favorite`、`node.unfavorite`、`deleted.restore`、`deleted.purge`、`open.audit`、`open.deleted`；树 `env`、`config`、`favorites`、`deleted`；类型 `core:env`、`core:config`；确认文字键 `deleted.purge.confirm`；错误原因 `noGroups`、`notParamNode`、`duplicateName`（带 `params.name`）、`notDeleted`、`notRestorable`、`nothingBefore`。

## 还缺什么 / 没验证的

- 计划“不做”的部分都没做（策略、引用、参数声明、密钥等）；`EnvParam.restricted` 不产生，`declaredBy` 恒为空，`description` 恒为空。
- `ref` 类型的 `display` 已实现（取被引用资源的当前名字），没有专门测试。
- 搜索的排序没有用 FTS 的相关度，只按上面三条规则；1 万条以上（例如 10 万）没测。
- 启动快照没有在“上次快照之后数据库被大量写入”的大库上量过耗时（`VACUUM INTO` 是全库复制）。
- 审计的合并计数仍然不做（同上一轮）。
- 第一轮建的库：审计里 `resource.create` 的摘要带名称，永久删除后这些旧行里仍有名称。

## 搜索耗时

`cargo test --release -p onedesk-kernel --test round2 -- search_over --nocapture`，1 万条资源（Intel i7-1068NG7 笔记本，机器上同时有别的编译）：

| 查询 | 命中 | 耗时 |
|---|---|---|
| `number 4242`（两个长词） | 1 | 1.9 ms |
| `lorem ipsum`（每条都命中，取前 20） | 20 | 38 ms |
| `报表`（两个字，子串扫描） | 20 | 23 ms |
| `Item 99`（长词 + 短词） | 20 | 19 ms |

都在 200 ms 目标之内。命中很多时耗时主要花在排序（要先找出全部命中再排序取前 20）。
