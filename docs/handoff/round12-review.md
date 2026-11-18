# 第十二轮独立审查（只读的 Opus 子代理，2026-11-18；第三个协调会话整理并定了协议上的事）

范围：`134e66e` 里第十二轮的三个合并。每条修改都要补测试；处理结果写进各自 `round12-*-done.md` 的“审查后的修改”一节。分派由第四个协调会话做。

| # | 级别 | 问题 | 位置 | 处理人 | 处理 |
|---|---|---|---|---|---|
| 1 | 必须修 | 表格行内动作整条链路接不上：外壳给表格节点加了 `rowActions`、事件带 `context.row`，但协议的 `ViewNode::Table` 不认未知字段（插件一输出就 `pluginError`），`PageContext` 也没有 `row`；综合插件不输出行动作，等的是 `remove:<id>` 这种事件名。真内核下“移除、上移、下移”没有入口。 | `crates/protocol/src/lib.rs:546-551,681`；`view-page.tsx:281-283`；`types.ts:130`；`plugins/org.onedesk.composite/main.js:96-120` | 内核＋外壳＋插件 | D393（名字定死）：表格节点只增 `rowActions: [{ id, label, icon? }]`（最多 4 个）、`rowKeys?: string[]`（与 `rows` 等长，每行的标识）、`rowTargets?: (string\|null)[]`（与 `rows` 等长，点行打开的目标，按打开目标的现有规则校验）；`PageContext` 只增 `row?: string`（触发行动作那一行的 `rowKeys` 值；没有 `rowKeys` 时是行号的文字）。行动作触发页面事件，事件名就是动作的 `id`。内核加类型与校验（等长、上限、`rowTargets` 的权限同自供子节点的 `target`），外壳照此发，综合插件输出 `rowActions`（remove、up、down）并在 `onEvent` 里用 `ctx.row` |
| 2 | 必须修 | `drop` 处理函数“先写后出错”时写入留下来，违反 D390“失败什么都不动”：插件经 `ctx.host.resources.update` 的写入各自立即提交。测试里定义了 `writeThenThrow` 却没用到。 | `crates/kernel/src/reach.rs:204-208`；`crates/kernel/tests/round12.rs:49,449` | 内核 | D394：一次放置里插件的资源写入放在同一个事务里（或先缓存、成功后一起提交），处理函数出错、超时或返回不合法则全部不落库；补 `writeThenThrow` 的测试 |
| 3 | 必须修 | `search` 只排除了插件状态节点：没有树的资源（别的插件的私有资源）、环境树、配置树的节点都会被列出并参与全文匹配；自供子节点的 `target` 校验同样只排除插件状态，这些都能当作可打开的目标。 | `reach.rs:106`；`kind_children.rs:141`；`kernel.rs:673` | 内核 | D395：`search` 和“有 `resourcesAll` 时可指向的目标”只限用户在资源树里看得到的资源——所在的树是存储树（内核自带的资源树和插件提供的存储树），不含环境、配置、插件状态、没有树的资源；补边界测试 |
| 4 | 应修 | HTTP 插件删掉了 `OPTIONS`，旧数据里方法是 OPTIONS 的请求发送时报错，违反 D392。 | `plugins/org.onedesk.http/main.js:7,270` | 插件 | 方法枚举里保留 `OPTIONS` |
| 5 | 应修 | 外壳调 `tree.move` 不带语言，插件的 `ctx.locale` 为空，“已加入 N 项”总是英语。 | `src/workbench/protocol/real/real-client.ts:111` | 外壳（内核） | 移动方法的参数若没有 `locale` 字段，内核只增一个并交给 `drop` 的 `ctx.locale`；外壳带上当前语言 |
| 8 | 应修 | 集合的结果把自己滤掉了，但 `total` 还算着它：总数多 1，误显示“部分”提示。 | `plugins/org.onedesk.collection/main.js:72` | 插件 | 修 |
| 10 | 应修 | 行按钮列宽写死成 `40 * n` 像素。 | `src/workbench/parts/view-nodes.tsx:64` | 外壳 | 用 token / 基础组件 |
| 6 | 只记录 | 全文条件可当探测器：用很短的子串加 `total` 能逐步推出别的资源的正文和说明。密钥值不在索引里，已删除的不参与。这是 D389 接受的范围（安装时已明示“读取所有内容的名称、类型和位置”——但没有明示能探测正文）。 | `reach.rs:131-150` | 协调 | 记 `todo.md`；待定：`text` 只匹配名称和标签，或在权限说明里写明 |
| 7 | 只记录 | 放置期间插件能用它全部的宿主权限、写自己的任何资源，不止 `ctx.resource`。 | `sandbox.rs:563` | — | — |
| 9 | 只记录 | 权限原子从 `resources` 改名为 `resourcesAll`，以前声明过 `requires.resources` 的外部插件要重新确认。 | `manifest.rs:495` | — | — |

测试缺口：`e2e/round12.spec.ts`（第二阶段在写）；先写后出错（#2）；没有树的资源、环境与配置节点在 `search` 里的边界（#3）；升级时新增 `resourcesAll` 触发重新确认；行动作要有连真内核的用例（假 host 没发现 #1）。

没有问题的检查点：没声明权限调 `search` 一律被拒；`ResourceInfo` 没有正文、说明、摘要；`limit` 1–500；`ids` 能取到已删除的并标 `deleted`、不存在的不出现；`resourcesAll` 进确认与指纹；已删除的资源不能做目标；`accepts` 接受的直接移动；`handled: false` 后按普通规则校验；出错和超时报 `pluginError`；`ev.sources` 只有被拖的、只有基本信息；`ctx.resource` 去掉密钥；审计 `tree.drop`；停用时 `dropAny` 不出现；外壳只对“放到上面”放行、祖先环拦下、提示当纯文本；综合的引用是叶子、`items` 上限 1000 并去重；集合三项都空不查；HTTP 的 GET/HEAD 不带正文、`{{…}}` 交宿主代入；内核无插件名、协议只增、无新依赖与迁移、三份语言文件键一致。
