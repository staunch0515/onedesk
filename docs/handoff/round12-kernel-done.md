# 第十二轮：内核交接（分支 `claude/r12-kernel-9bd8fa`）

范围：`round12-plan.md` §3（读全部资源的基本信息）、§4（插件决定的放置）。内核里没有任何具体插件的名字或逻辑：它只回答查询、把放置交给声明了 `drop` 的类型。

## 完成了什么

- 清单 `requires.resources: true`（字段原本就有、原本就是布尔；以前进权限时的原子是 `resources`，与“读依赖导出的类型”`resources:<kind>` 同一个 id。现在改为单独的权限 **`resourcesAll`**，没有明细，进安装确认与指纹）。非布尔 → `schema`。
- `ctx.host.resources.search(opts)`（新模块 `crates/kernel/src/reach.rs`）。
- 声明了 `requires.resources` 的插件，其自供子节点的 `target` 可以指向任何**未删除**的资源（插件状态树里的除外）；没声明的照旧。
- 类型声明 `drop`、`kinds.handle(kind, { drop })`、树节点 `dropAny`、`tree.move` 里的分流、审计 `tree.drop`。

## 清单新增部分

- 类型声明只增 `"drop": true|false`（默认 false）。`drop: true` 而没有 `tree` → 拒绝加载，原因码 **`dropWithoutTree`**；非布尔 → `schema`。
- `requires.resources` 不变（布尔），权限 id 改为 `resourcesAll`（见上）。

## 宿主接口的确切签名

```
ctx.host.resources.search({ kinds?: string[], tags?: string[], text?: string, ids?: string[],
                            limit?: number, offset?: number })
  → { items: ResourceInfo[], total: number, next?: number }
ResourceInfo = { id, name, kind, kindLabel?: Label, icon, tree, parent?: string, tags: string[], deleted: boolean }
```
- 没声明 `requires.resources` → `denied`，`params.reason = "notRequested"`（照例记一条拒绝审计，操作 `resources.search`）。
- 多余的选项、类型不对 → `invalidParams`。`kinds` 超过 200 个、`tags` 超过 50 个、`ids` 超过 1000 个、`text` 超过 500 字 → `invalidParams`。
- `kinds`：类型全名，任一；`tags`：都含有（精确比较）；`text`：内核已有全文搜索的同一套规则（≥3 字走索引，短词按子串；名称、说明、标签、正文都参与），结果里只给基本信息；空列表、空文字等于没有这个条件。
- `ids`：按给的顺序；在已删除里的给出并标 `deleted: true`；彻底清除的、从未存在的不出现。其他条件同时生效。不给 `ids` 时只含未删除的。
- `limit` 默认 200，夹到 1..500；`offset` 默认 0。`total` 是不分页的总数；`next` = 下一页的 offset，没有更多时不给。无 `ids` 时的顺序：树、名称（不分大小写）、id。
- 插件状态树的行永远不出现；组（`core:group`）是资源，会出现。
- 可在渲染、页面事件、运行、`children`、`drop`、事件处理里调用；`migrate`（纯计算）里照旧被拒（`pureCall`）。

```
host.kinds.handle("<kind>", { drop(ctx, ev) { … } })
  ctx = { tree, locale, resource, host, t, … }   // resource：目标资源（本插件的类型），未冻结；写它照常走 ctx.host.resources.update
  ev  = { sources: ResourceInfo[] }             // 不要求 requires.resources
  → { handled: true, message?: Label } | { handled: false } | undefined（= 未处理）
```
- 给没声明 `drop` 的类型注册 `drop` → 激活失败（`denied`，“undeclared drop of kind: …”，与第十轮 `children` 同样处理）。
- 参数顺序：`drop` 与 `children` 一样 ctx 在前。

## `tree.move` 的分流（内核里）

只在 `position: "inside"` 且有 `target` 时：
1. 目标与被拖的同树、不是自身；目标类型声明了 `drop`，其绑定版本的插件启用、依赖满足、已确认、借用的树/页面可用（即节点 `dropAny` 为真的同一条件）——否则按普通移动。
2. 先问普通规则：目标类型的 `accepts` 含 `*` 或被拖资源的类型 → 直接普通移动，不问插件。
3. 调插件 `drop`（超时同普通调用 `call_timeout`）。抛错、超时、返回值形状不对 → 整个操作失败，**错误码统一 `pluginError`**（`params.reason` 保留：`threw`、`timeout`、`badDropAnswer`…；超时也映射成 `pluginError`，按计划原文），内核什么都不动。
4. `handled: true` → 审计 `tree.drop`（操作者插件 `plugin:<id>@<version>`，对象 = 目标资源 id，摘要 `{"sources": N}`），返回 `{ handled: true, message? }`；`handled: false` 或返回空 → 普通移动（普通规则不接受时照旧 `invalid/notAccepted`）。

前后位置（before/after）永远走普通规则。插件自己的 `resources.move`（宿主接口）不分流。

## 协议只增的类型与字段

- `TreeNode.dropAny?: boolean`（只在为真时出现）。
- `TreeMoveParams.locale?: string`（交给 `drop` 的 `ctx.locale`）。
- 新类型 `TreeMoveResult { handled?: boolean, message?: Label }`；`tree.move` 的返回值由 `null` 改为它（普通移动 `{}`）。
- 新类型 `ResourceInfo`、`ResourceSearchResult { items, total, next? }`。
- `PluginPermission.id` 的说明加了 `resourcesAll`。
- 已 `pnpm gen:types`，生成的 TS 已提交。

## 新增错误原因码与审计操作名（全部）

- 清单拒绝：`dropWithoutTree`。
- 宿主调用：`denied/notRequested`（`resources.search`）。
- `tree.move`：`pluginError` + `reason=badDropAnswer`（返回值不是 `{handled, message?}`）；其余 reason 沿用沙箱的（`threw`、`timeout`、`outOfMemory`、`pluginDisabled`…）。
- 审计操作：`tree.drop`。

## 测试结果（实际跑过）

- `cargo test -p onedesk-kernel --test round12`：15 个全过（见下方完整命令的结果）。
- 清单单元测试 `manifest::tests::round12_requires_resources_and_drop`。
- 覆盖计划 §7：清单校验（`requires.resources` 类型、`drop` 需要树和布尔）、`resourcesAll` 进确认列表与指纹；`search` 的每个条件与组合、分页与 `total`/`next`、结果没有 `body` 和说明、未声明被拒（含拒绝审计）、`ids` 顺序与已删除标记、不存在的不出现、`limit` 上限 500；有权限的自供子节点 `target` 指向任意资源、没有的不行、已删除的不行；`drop`：未声明注册被拒、`dropAny` 只在 drop 类型节点上、放上去调插件且资源不动（位置、审计、无 `resource.move`）、`ctx.locale`、`ev.sources` 只有基本信息、`handled:false`/返回空走普通移动、`accepts` 接受的不问插件（插件设成会抛错也照常移动）、抛错/超时/坏返回值什么都不动、插件停用时按普通规则、无 `requires.resources` 的插件的 drop 也能用。
- 全量结果见下一节（由命令输出填写）。

- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过，没有失败（内核单元测试 143 个，各轮集成测试文件全过，其中 round12 15 个）。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：通过，无警告。
- `sh scripts/gen-types.sh --check`：“协议类型是最新的”。
- `pnpm lint`：架构检查与界面规范检查通过（内核侧没有插件名）。

## 我做的决定

1. 权限原子从 `resources` 改成 `resourcesAll`（计划定死的 id）。以前没有任何插件声明它（仓库里查过），所以没有已确认指纹受影响。
2. `tree.move` 返回值改成对象（普通移动 `{}`），而不是只在处理时返回对象——类型固定，外壳好写。
3. 超时也映射为 `pluginError`（计划原文“出错或超时 → pluginError”），`reason` 里仍能区分。
4. `drop` 返回 `undefined`/`null` 视为未处理；声明了 `drop` 但代码没注册处理函数的也一样。
5. 分流只在用户入口 `tree.move`，不在插件的 `resources.move` 里（插件只能移动自己的资源，不需要别的插件决定）。
6. 处理函数在抛错前已经通过宿主写入的内容不回滚（宿主写入各自走写入管线、各自提交）；“什么都不动”指内核不移动被拖资源、不记 `tree.drop`。
7. `search` 不含插件状态树；组会出现（让插件自己按 `kinds` 过滤）。`kindLabel` 总是给（多语言 `Label`）。
8. 自供子节点的 `target` 放宽只到“未删除、不在插件状态树”的资源；已删除的仍丢掉 `target`（外壳显示为不可打开）。

## 没做 / 没验证的

- 没有跑 `pnpm e2e`、`pnpm test`（外壳）和整套 `pnpm check`：范围外，且外壳在另一个会话里改。
- 外壳对 `tree.move` 返回值从 `null` 变成对象是否有依赖 `null` 的地方，我没查外壳代码（只读不改也没看）；请外壳会话核对。
- 一次 `tree.move` 只拖一个资源，所以 `ev.sources` 总是一个；多选拖放不在本轮。
