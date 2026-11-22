# 第十八轮 r18-kernel 完成报告

分支 `claude/r18-kernel-674264`。协议细节见 `round18-protocol.md` §9（名字全部沿用；§9 开头列出三处落在已有类型里的写法）。

## 做了什么

| 项 | 内容 | 主要代码 |
|---|---|---|
| X5 结果区动作 | 清单 `contributes.resultActions`；请求 `result.actions`；`run.start` 新增 `resultRun`；宿主 `runs.read` | `round18.rs`、`runs.rs`、`manifest.rs`、`protocol` |
| X6 搜索 | `search.query` 加 `mode/rank/kinds`；宿主 `resources.search` 加 `mode/rank`，新写法 `query` 返回 `[{id,kind,name,snippet,score}]` | `round18.rs`（`search_candidates`、`rank`）、`round2.rs`、`reach.rs` |
| X15 插件接口 | 顶层 `implements`/`uses`；宿主 `interfaces.call/list`；`ViewField.kinds` 里 `@implements:<接口>` | `round18.rs`、`calls.rs`（`invoke_callee` 抽出共用）、`manifest.rs`、`pages.rs` |
| X16 长请求与流式 | 运行中 `timeoutMs` ≤ 10 分钟（别处仍 60 秒）；`stream`/`onChunk`/`idleTimeoutMs`/`maxBytes`；取消立即断开 | `network.rs`、`sandbox.rs`（`runNetwork` 泵）、`host.rs` |

协议（只增）：`ResultActionsParams`、`ResultAction`、`SearchMode`、`SearchRank`、`SearchQueryParams.{mode,rank,kinds}`、`RunStartParams.resultRun`、`method18::RESULT_ACTIONS`。TS 已生成（`pnpm gen:types`，`--check` 通过）。**没有新依赖。**

## 怎么验证（`crates/kernel/tests/round18.rs`，19 个；`network.rs`/`round18.rs` 单元测试）

| 要求 | 测试 |
|---|---|
| 取消立即断开 | `cancelling_the_run_drops_the_connection_at_once`（服务器看到连接关闭，<1 秒，运行 `cancelled`） |
| 两块之间超时 | `silence_between_two_blocks_times_out`（`idleTimeoutMs` 300；另测总时限） |
| 10 分钟上限只在运行中 | 单元 `the_ten_minute_limit_is_for_actions_only`；`streaming_is_for_actions…`（运行外 `stream` → `denied/notInRun`，运行外 `timeoutMs` 900000 仍按 60 秒；动作预算 1 秒时 2.5 秒的长请求不被打断） |
| 块不切字符、顺序、部分输出 | `a_streamed_answer_comes_block_by_block…`、`partial_output_shows_while_it_streams`、单元 `text_is_never_cut_inside_a_character` |
| 错误状态正文 | `an_error_status_keeps_its_first_8k…` |
| 抹除密钥（含被切在两块之间） | `a_secret_cut_between_two_blocks_is_still_scrubbed` |
| 回调抛错、`maxBytes`、`onChunk` 需 `stream` | `a_callback_that_throws…`、`max_bytes_stops_a_stream`、`on_chunk_needs_a_stream` |
| 审计不记正文、有 `stream` | 首个测试里查 `audit` |
| `runs.read` 权限 | `runs_read_works_only_for_the_clicked_action_and_the_clicked_run`（别的运行、非点击的同一动作、手填 runId、运行外、被调用的插件经 `actions.call` / `interfaces.call` 都 `denied/notInResultAction`；审计有成功行和拒绝行，不含内容） |
| 点击检查 | `only_a_declared_action_on_a_finished_run_of_its_type_can_be_clicked`（`notResultAction`、`badResultRun`、`notFound`，没产生运行） |
| `result.actions` | `result_actions_follow_the_output_type_the_language_and_the_policies`（类型过滤、语言、失败运行为空、`noExport`/`readonly` 灰掉、点击被拒） |
| 清单检查 | `manifests_with_bad_result_actions_or_interfaces_are_rejected`（`badResultActions`、`badImplements`） |
| 未声明 `uses` 被拒、无实现、错接口 | `every_refusal_of_an_interface_call`（`notUsed` 含 `list`、`notInRun`、`wrongInterface`、`noImplementation`×2、资源缺失、审计） |
| 接口调用成功 | `an_interface_call_runs_the_implementers_action_in_the_same_run`（同一次运行、资源交给被调用方、被调用方的 `runs.partial` 即运行部分输出、审计、不新开运行）；`cancelling_reaches_a_running_interface_call` |
| `@implements:` | `a_ref_field_can_ask_for_every_implementer_of_an_interface`（没声明 `uses` 的页面得到空） |
| 搜索 | `ranked_search_any_word_relevance_and_kinds`（`any`/`relevance`/`kinds`、`kind`+`kinds`、空 `kinds`、旧写法不变、`query`+`text` 冲突、短 `kinds` 解析为自己的、词数上限）；单元 `name_hits_and_frequency_rank_first` |

`cargo test --workspace`、`cargo clippy --workspace --all-targets -D warnings`、`pnpm typecheck`、`pnpm lint`、`gen-types --check` 都通过。内核新增代码里没有 `ai`/`anthropic`/`ollama`/`claude`/`sse`/`ndjson` 作为单词（接口名只当字符串）。

## 新增名字与错误码

- 请求 `result.actions`；`run.start.resultRun`；`search.query.{mode,rank,kinds}`。
- 清单：`contributes.resultActions`、顶层 `implements`、`uses`。宿主：`runs.read`、`interfaces.call`、`interfaces.list`、`network.request` 的 `stream/onChunk/idleTimeoutMs/maxBytes`、`resources.search` 的 `query/mode/rank`。
- 错误码：`denied/notInResultAction`、`denied/notUsed`、`invalid/noImplementation`、`invalid/wrongInterface`、`invalid/notResultAction`、`invalid/badResultRun`、`notFound/run`（`result.actions`）；安装拒绝 `badImplements`、`badResultActions`。
- 内部：`network.output`/`network.stop`（`onChunk` 的泵，沿用 `process.output` 的流机制；插件不直接用）。

## 与任务书/上文的差别（已在 §9 写明并通知协调会话）

- 点击用 `run.start` + `resultRun`（没有 `action.call`）；`result.actions` 多返回 `action`（完整名）。
- 选择器 `kinds` 写字符串 `"@implements:接口"`。
- `resources.search`：旧写法不变，新写法 `query`；`stream` 默认 `timeoutMs` 600000。
- 额外的保护：`protection.no_export` 的环境里结果区动作灰掉（结果交给插件等同导出），`readonly` 同样灰掉；点击时再检查。

## 范围外

- 外壳（`r18-shell`）要照 §9.1 调 `result.actions`/`run.start.resultRun`；mock 客户端也要补。
- 内核禁用词并入 `scripts/check-arch.mjs` 由 `r18-tests` 做；注意 `sse` 要按单词边界匹配（`assert`、`processed` 等含有这三个字母）。
- `onChunk` 的块是一批一批地交给回调、回调按序 `await`；若插件回调很慢而服务器很快，块在内存队列里排着（上限 `maxBytes`，最大 64MB）。没有做背压（暂停读取）。
- `runs.read` 返回的 `paged` 表只有头 200 行（运行记录里只存这些）；AI 工作台只用前 20 行，够用。
