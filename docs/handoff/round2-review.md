# 第二轮合并前审查（独立审查，只看代码与设计）

审查对象：`git diff 85c8b64 fed56a6`。行号以该提交为准。

| # | 级别 | 位置 | 问题 | 处理 |
|---|---|---|---|---|
| 1 | 必须修 | `crates/kernel/src/round2.rs:73`、`pipeline.rs:768` | `params.set` 接受 `type: secret`，值明文进 body、历史快照、搜索文本、表单（违反规则 7） | 内核：本轮拒绝 `secret`（`invalid`，`reason: secretUnsupported`）；加测试 |
| 2 | 必须修 | `pipeline.rs:627,819,776,76` | 配置同名规则只在新增参数时检查；移动、恢复删除、历史恢复、用 `body.params` 整表覆盖都能绕过 | 内核：参数节点拒绝 `body.params` 这种绑定路径；移动、恢复删除、历史恢复对 `core:config` 逐个参数名做同名检查；各加测试 |
| 3 | 应该修 | `round2.rs:124` | `params.set` 没有并发检查 | 协议已加 `basis`（`ParamSetParams`、`ParamNameParams`，D281）。内核：带 `basis` 时同名参数在那之后被改过则 `conflict`；外壳：传 `EnvView.rev` |
| 4 | 应该修 | `pipeline.rs:868` | 永久删除父节点时会连带清掉“另一批”已删除的后代 | 内核：只处理同一批（`delete_batch`）；加测试 |
| 5 | 应该修 | `pipeline.rs:623,311` | 审计行里留下参数名（字段路径、失败审计的错误参数），永久删除后仍在 | 内核：审计摘要里参数字段只记个数，不记名字；失败审计不带用户内容 |
| 6 | 应该修 | `src/workbench/protocol/mixed-client.ts:56` | 内核出错或返回空时把资源永久缓存为“演示”，之后的写操作发给假实现并静默成功 | 外壳：只缓存内核明确给出的结果；出错不缓存；内核说没有再问假实现且不缓存否定结果 |
| 7 | 应该修 | `pipeline.rs:474`、`migrations/0002_search_restore.sql:6` | 搜索表按未索引的 `id` 删除，每次写入全表扫描 | 内核：新增迁移 0003，搜索表的 rowid 对应 `resources.rowid`，按 rowid 维护（不改 0002）；带升级测试 |
| 8 | 应该修 | `round2.rs:250` | 配置根可以删光，之后 `setConfig` 失败且被界面吞掉 | 内核：`setConfig` 找不到配置根时自动补建；外壳：`setConfig` 失败要提示 |
| 9 | 应该修 | `workspace.rs:96` | 启动快照失败会挡住打开工作区 | 内核：失败只写 stderr，不中断 |
| 10 | 顺手 | `workspace.rs:186` | 快照保留把 `backups/` 里所有 `.db` 一起算，可能误删用户放的文件 | 内核：只处理符合时间戳文件名的 |
| 11 | 顺手 | `round2.rs:490` | 审计文本过滤的 LIKE 没转义 | 内核 |
| 12 | 顺手 | `commands.rs:20-21` | 内核里有英文默认名 “New environment” 等 | 外壳：`env.newChild`、`config.newChild`、`node.newGroup` 都在 `args.name` 里传当前语言的默认名；内核的默认名只作兜底 |
| 13 | 顺手 | 审计 | 参数操作在审计里记成 `resource.update`，外壳给 `params.set` 配的文字用不上 | 内核：参数命令的审计操作名用 `params.set`/`params.unset`/`params.acknowledge` |
| 14 | 以后 | `env_options`、`descendants`、purge | 库里若有成环数据会死循环（接口造不出环） | 记 todo |
| 15 | 以后 | 快照 | 当天已有快照时，迁移前不再拍一份 | 内核顺手：有待执行的迁移时总是拍一份；来不及记 todo |

已核对未发现问题：内核与主进程没有插件 id 或特判；界面没有绕过 token；插件经 `host.resources` 碰不到 `core:*`、进不了 env/config 树；新写入都走写入管线、审计与数据同事务；永久删除只对已删除的资源且清掉四处数据；搜索不含隐藏树和已删除、输入有转义、SQL 全部参数化；恢复的条目校验；环境成环被拦；只新增迁移；快照在迁移之前且路径限制在 `backups/`；语言主题密度没有启动竞态。
