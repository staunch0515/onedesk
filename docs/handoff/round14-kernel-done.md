# 第十四轮：内核会话交接（2026-11-18）

分支 `claude/r14-kernel-67c207`（从 `7a78371` 切出）。没有新依赖，协议没有改动（错误 `params` 里多一个键不算协议改动），没有新迁移，生成的 TS 不变。

## 做了什么

| # | 条目 | 改动 | 测试（`crates/kernel/tests/round14.rs`） |
|---|---|---|---|
| 1 | 第十三轮审查 #10：改名后 `workspace.info` 到重启前是旧名 | `Workspace::current_name()` 每次重读 `workspace.json`（主进程改名就是改写这个文件）；读不到或名字为空时用打开时的名字。`workspace.info`、`hello`、导出清单里的工作区名都用它 | `workspace_info_follows_a_rename_of_workspace_json` |
| 2 | 第十三轮审查 #9：只改过设置、没建过资源的旧工作区会被 `init-settings.json` 覆盖 | “新工作区”的判断加一条：没有内核以外的审计行（改设置会留审计，见 K2）。文件照旧用后即删 | `init_settings_leave_a_workspace_with_only_changed_settings_alone` |
| 3 | 第八轮验收：拒绝里的 `layer` 是节点 id，外壳说不出是哪一层 | 网络和外部程序的拒绝早已带 `layerName`；本轮补上禁止策略（`readonly`、`noExport`）的 `denied`：多带 `layerName`（该配置/环境节点的名字） | `a_readonly_refusal_names_the_layer` |
| 4 | 第二轮审查 #14：库里成环数据让遍历死循环 | `store::descendants`、永久删除的后代遍历加“已访问”集合。`params.envOptions` 从根往下走，成环的节点没有根、走不到，不需要（审查 #9 后去掉） | `a_parent_cycle_in_the_database_does_not_hang_the_walks` |

四条测试都先在没改的代码上跑过：前三条失败，第四条卡住不结束（遍历在阻塞线程里，`tokio::time::timeout` 打断不了它，所以没修时表现为挂住而不是失败）；改后全过。

外壳给 `layerName` 配字是外壳的事（`denied/readonly` 现在与 `blockedByPolicy` 一样带 `layer` + `layerName`）。

## todo.md 内核条目的处理

“已修（之前）”= 之前几轮已做、todo 没划掉，我按代码核对过。

| 条目 | 结论 | 理由 / 出处 |
|---|---|---|
| 成环数据死循环（第二轮 #14，两处重复记） | 本轮修了 | 上表 #4 |
| 宿主写调用交给写线程后遇取消：写入落库、插件收到被拒（第三轮 #10，两处重复记） | 以后 | 只在运行被取消时出现；写入照常审计、界面能看到，运行本身显示“已取消”。要改得在写线程里查令牌或返回“已提交”，改动跨沙箱与管线，不值得在收尾轮冒险 |
| 停用插件与激活之间的窄竞态（第三轮 #12） | 以后 | 多出来的运行环境只占内存，之后的调用仍被 `plugin_enabled` 拒绝；日常无感 |
| 插件树节点名称不随界面语言（第三轮验收） | 已修（之前） | 第十轮起类型自供子节点的 `ctx.locale` 带界面语言，插件按它给名称；切换语言后重取树由外壳负责 |
| 自动切换版本失败没有提示（第四轮验收） | 以后 | 需要新的节点状态或事件字段（协议增项）和外壳配字；内置插件没有会失败的迁移，日常不出现 |
| 手动启用旧版本的“已固定”规则（第四轮验收） | 以后 | 是规则问题，需协调会话定；只有装了多版本的人会碰到 |
| 导入/安装指纹 FNV-1a → SHA-256（第五轮审查） | 以后 | 需新依赖 `sha2`，本轮规定不加依赖 |
| 动作 60 秒总时长截断 `process.run` 的 600 秒（第六轮） | 以后 | 需协调会话定规则；内置插件没有超过 60 秒的外部程序 |
| `ctx.host` 存起来跨上下文使用（第六轮审查、第九轮 D366/D370） | 以后 | D366 已按调用授权；剩下的共享 promise 口子要引擎支持异步上下文 |
| `RunError` 加 `params`（第六轮外壳） | 已修（之前） | D360，`RunError.params` |
| `checkRemove` 只问当前工作区（第七轮审查） | 以后 | 要打开别的工作区的库，跨工作进程；移除插件是少见操作，且别的工作区里那条资源会显示为停用而不是丢数据 |
| `plugin.undoUpgrade` 不查依赖方（第七轮） | 以后 | 待定规则，少见操作 |
| 页面事件带标签页参数（第七轮验收 V3） | 以后 | 接口变更，需协调会话定；本轮协议只增且无外壳请求 |
| 导入不检查借用未导出的类型（第八轮 D356） | 以后 | 导入后显示为停用，不丢数据；要新的跳过原因码，需协调会话定 |
| `transfer` 写进文件的内容不抹除密钥值（第八轮） | 以后 | 文件是用户自己指定要保存的输出；抹除会改坏下载正文，需另定规则 |
| 被取消的 `transfer` 不写审计；超时记成 `cancelled`（第八轮、第九轮审查） | 已修（之前） | 第九轮：取消记 `cancelled`、超时记 `timeout`（`carry.rs`） |
| 网络失败 `detail` 含完整 URL（第八轮审查 #7） | 已修（之前） | D368，只留主机（`network.rs`） |
| `blockedByPolicy` 的 `layer` 是 id | 本轮补完 | 网络、程序之前已带 `layerName`；本轮补禁止策略（上表 #3） |
| `outsideGrant` 不带路径（第八轮验收） | 已修（之前） | D368，`util.rs` 带 `path` |
| `round4.rs` 大正文测试在高负载下超时（第九轮） | 以后 | 只在 load 200+ 出现，单独跑稳定；改测试参数会削弱它测的东西 |
| 1 万个包时 `hello` 慢（第九、十轮） | 以后 | 需缓存校验结果或改“语言文件坏了整包被拒”的规则；日常不会有 1 万个包 |
| `tree.path` 多层插件节点、插件节点变化事件（第十轮） | 以后 | 需协议增项；内置插件的自供树只有一层 |
| `overwrite` 不绑修改序号；自供子节点两批之间数目变化会错位（第十轮审查） | 以后 | 窄竞态，需协议增项 |
| 树一层的总数（第十轮验收） | 以后 | 外壳本轮没提；需要时 `tree.children` 只增一个 `total` |
| `resources.search` 全文可当探测器（第十二轮审查） | 以后 | 需定规则（只搜名称标签，或在权限说明写明），属权限设计，不是收尾 |
| 放置期间插件能用全部宿主权限（第十二轮审查） | 以后 | 同上，权限设计 |
| 批量 `tree.move`（第十一/十二轮） | 以后 | 协议增项，外壳本轮没提 |
| 运行输出 `label` 改 `Label`、表格列图标（第十一/十二轮） | 以后 | 协议变更，待定 |
| 第十三轮审查 #9 | 本轮修了 | 上表 #2 |
| 第十三轮审查 #10 | 本轮修了 | 上表 #1 |
| 第十三轮 #5：复制出的同 id 工作区由内核赋新 id | 以后 | 要主进程告诉工作进程“换 id”（新的启动参数或文件约定），跨主进程与内核；手动复制工作区文件夹是少见操作，主进程已标为待定、不会同时打开两个同 id 的 |
| 审计“合并计数”（week1） | 已修（之前） | 迁移 `0011_audit_counts_last` |
| 根 `Cargo.toml` 未用的 workspace 依赖警告；`check-arch.mjs` 规则 | 不在本会话范围 | 根 `Cargo.toml`、`scripts/` 不在允许修改里 |

## 第十四轮审查的修改（协调分支 `round14-review.md`）

- #3：`workspace.json` 只按安全方式读（`workspace::read_info`，`Workspace::open` 和 `current_name()` 共用）：`O_NOFOLLOW | O_NONBLOCK` 打开（不跟随符号链接、FIFO 不挂住），在打开的文件上查是普通文件且 ≤ 64 KiB，再限量读；名字按字符截到 100。读不了时 `open` 用文件夹名、`current_name` 用打开时的名字；`open` 之后照旧写回一个正常的 `workspace.json`（顶掉符号链接）。测试 `workspace::tests::workspace_json_is_read_only_as_a_small_regular_file`（符号链接到 `/dev/zero`、FIFO、超大文件、150 字名字、带符号链接打开工作区）。
- #9：防环测试改为断言结果：删除后两行都删了且同一批，永久删除后两行都没了、审计 `count` = 2；`envOptions` 里无用的防环去掉（理由见上表 #4）。

## 我做的决定

- K1：工作区名以 `workspace.json` 为准、每次读（文件很小；只在 `hello`、`workspace.info`、导出时读）。不加“改名”协议方法：主进程已经改写这个文件，内核跟着读就够了，不需要主进程与工作进程之间多一条消息。
- K2：“新工作区”= 没有用户建的资源 **且** 没有内核以外（`actor <> 'core'`）的审计行。内核的启动命令（建默认节点）在新库里就会写 `core` 的审计行，所以不能要求审计表为空（第一次这样写时第十三轮的测试挂了，已改）；用户改设置、插件写入都是非 `core` 的行。
- K3：所有带 `layer` 的拒绝都同时带 `layerName`；名字取那一层节点当前的名字，节点读不到时为空串。
- K4：`workspace.json` 读不了（符号链接、非普通文件、超过 64 KiB、坏 JSON、名字为空）一律当作“没有”，不报错；名字超过 100 字符截断而不是拒绝，与主进程的上限一致。

## 外壳的内核配合

到交回时没有收到外壳经协调会话转来的请求。之后来的照消息处理。

## 没做 / 没验证

- 没跑 e2e 和完整 `pnpm check`（只改了内核，跑了内核、工作进程、协议的 Rust 测试和 clippy，见下）。
- 主进程改名后外壳是否重取 `workspace.info`（外壳的事），没验证。

## 检查（都在本工作树里跑过，`ONEDESK_SECRET_STORE=memory`，只用临时目录）

- `cargo test --no-fail-fast -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全过（内核单元 55、各轮集成测试 round2–round14、协议 154、工作进程 5）。
- `cargo test -p onedesk-host`：全过（34 + 46）。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：无警告。
- `pnpm lint`（架构 + 界面规范）：通过。
- 审查修改之后（机器 load ~150）又跑了一遍 kernel/worker/protocol/host：25 组全过，唯一例外 `round6.rs` 的 `review4_queues_are_bounded_and_failures_merge`，单独重跑 5 次失败 3 次。失败时删除事件总数仍是 1100（如 `deleted 1100, dropped 0`、`deleted 1036, dropped 64`），即高负载下插件消费够快、队列没溢出到“丢 ≥1 且送达 ≤1001”这一断言要的程度——是测试对时序的假设，与本轮改动无关（防环集合只跳过重复出现的 id，无环时从不触发；第一次全量跑时它是过的）。没改这条测试（不在本轮范围），建议记 todo：把队列上限或事件数做成让溢出必然发生。
- 没跑：完整 `pnpm check`、`pnpm exec playwright test`（本轮只改内核，界面无改动；合并后由协调会话跑完整检查）。
