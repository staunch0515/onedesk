# 第十轮 内核 交接（分支 `claude/r10-kernel-865af1`）

按 `round10-kernel.md` 的先后做完了三项：§4 保存时按字段合并、§5 类型自供子节点、§7 1 万个包时第一个应答。只改了 `crates/kernel/**`、`crates/protocol/**`（只增）和生成的 TS；没加依赖，没有新迁移（数据库结构没变）。

## 1. 未保存内容的合并（§4，D374）

- `page.save` 带的 `basis` 落后于当前修改序号时：取历史里 `rev = basis` 那一版的快照，与当前行逐项比较 `name`、`description`、`tags`、`body.*`（顶层键，含新增和删除的键），得到“别处改过的字段”；`params.*` 仍按 `basis` 之后修订记录里的 `fields` 列判断（参数表的写法不变）。
- 这次 `changes` 的字段与之**没有交集** → 照常保存，只写 `changes` 里的字段，别处的修改保留。
- **有交集** → 拒绝，什么都不写（`description` 这类不冲突的字段也不写）：
  `conflict`，`params.reason = "stale"`，`params.fields` = 冲突字段路径（逗号分隔，按 `changes` 的顺序：name、description、tags、body.*、params.*），`params.rev` = 当前修改序号；另保留旧的 `params.field`（第一个冲突字段）以兼容前几轮的外壳和测试。拒绝照旧记审计 `resource.update` / `failed:conflict`。
- `PageSaveParams.overwrite?: string[]`：用户选了“保留我的”的字段路径，不算冲突，直接覆盖。只列了一部分冲突字段时，其余的仍被拒（`fields` 只列剩下的）。
- 历史里已没有 `basis` 那一版 → 所有字段都算改过（有 `overwrite` 的字段照样能写）。
- 比较是按值的：别处把一个字段改了又改回原值，不算冲突。
- `basis` 不落后、或不带 `basis`：行为不变。插件经 `ctx.host.resources.update` 的写入不受影响（它们不带 `basis`；带了的话规则同上）。

## 2. 类型自供子节点（§5，D375）

### 清单（只增）
类型声明加 `"children": true`（布尔，缺省 `false`；不是布尔 → 清单被拒）。`children: true` 而没有 `tree` → 拒绝，原因码 **`childrenWithoutTree`**。

### 宿主接口
```js
host.kinds.handle("<kind>", {
  children(ctx, node, offset) { return { nodes: [...], next?: number }; },
  migrate(body, fromVersion, ctx) { ... },   // 照旧，参数顺序不变
});
```
- `ctx`：`tree`（所在的树 id）、`locale`（界面语言，可能为 `null`）、`resource`（这条资源，与 `resource.get` 同形，去掉了密钥字段；**深度冻结**，改它在严格模式下抛错，也不会写回）、以及照旧的 `host`、`t`、`progress`、`cancelled`。`ctx.host.resources.get(<这条资源>)` 照常可用。
- `node`：展开资源本身时为 `null`；展开插件自己给的可展开节点时是那个节点的键（插件的原始键，不带内核前缀）。
- `offset`：插件自己的位置（从 0 起），与存储的子节点无关。
- 返回：`{ nodes, next? }`，节点字段与提供树的 `children` 相同：`key`、`label`、`icon`，可选 `expandable`、`target`、`badge`；多余字段 → 该批作“加载失败”。一批超过 200 个时内核截成 200 个，`next` = 插件 offset + 200（即按“位置”续取，与提供树的约定一致；夹具每批 500 个可以照用）。
- 清单没声明 `children` 的类型注册了带 `children` 的处理对象 → 激活失败（`denied`，消息 `undeclared children of kind: <kind>`；对外表现为该插件的调用得到 `pluginError`）。只注册 `migrate` 不受影响。声明了却没注册 → 没有插件节点（空）。

### `tree.children` 的形状
- 父节点是这种类型的资源（且其绑定版本正常、插件启用）时：先给存储的子节点，再给插件的节点。`offset` 是两段合起来的位置：`[0, 存储子节点数)` 是存储的，之后是插件的（插件收到的 `offset` = 总位置 − 存储子节点数）。存储的最后一批的 `next` 指向插件那段的开头，所以至少多一次往返。
- 插件节点的键：**`@<资源 id>/<插件的键>`**；资源 id 是 32 位十六进制，不会冲突。`parentKey` 是资源 id（第一层）或上一层插件节点的键。`kind` 是父资源的类型。
- 插件节点：`draggable: false`、`accepts: []`、菜单只有 `node.open`（有 `target` 时）或空。改名、移动、删除对这些键一律 `notFound`（它们不是资源）。
- 展开插件节点（`parent = "@<rid>/<key>"`）→ 再调 `children(ctx, key, offset)`。
- `tree.path` 对插件节点：资源的路径 + 该节点本身（`[…祖先, rid, "@rid/key"]`）；更深的插件节点的中间层内核不知道，不在路径里。
- 资源节点的 `expandable`：类型自供子节点（且插件启用）时恒为 `true`。
- **`target` 的校验**（不合格的丢掉，节点仍在、只是不可打开）：`resource:<这条资源>`；`resource:<id>` 且插件自己能读（自己的类型，或依赖导出可读）；`run:<id>` 且是本插件的运行；`node:<本插件的树>/…`；`plugin:<本插件>`。其他（`core:`、`new:`、别的插件的东西、不是目标格式的字符串）都丢掉。
- **加载失败**：处理函数抛错、超时（沙箱的调用时限）、返回形状不对 → 插件那段只给一个节点：键 `!<资源 id>/<node 或空>`，`state: "load-failed"`（`NodeState` 新增），`stateReason` = 错误码文字（如 `pluginError`），`label` 为空（外壳配字），不可展开、不可打开、没有 `next`。存储的子节点照常在它前面；别的节点不受影响。展开 `!…` 键得到空。
- 插件停用：资源下只给存储的子节点；`@…` 键下给空。展开会照常惰性激活插件。

### 外壳要注意
- 打开插件节点请带 `context.target`（`node.open` 只给 `nodeKey` 时内核按资源找，`@…` 键会 `notFound`）。

## 3. 1 万个包时第一个应答（§7）

找到的两处（`sample` 取样 + 计时）：
1. **`tree.children`（树 `plugins`）每次给全部 1 万个插件建节点**，每个节点查五六次插件状态（启用、开关、依赖、切换失败、版本确认）。改为只给请求的那一批建节点（`plugins_tree_page`）。
2. **启动后后台的“自动切到更新版本”逐个查 1 万个插件的状态**（`pinned`、确认集合），占着唯一的读连接，正好和第一批请求抢。改为先在内存里筛出“有比活动版本更新的版本”的插件，只对它们做。

实测（debug 构建，`node e2e/fixtures/make-many-plugins.mjs <目录> 10000`，`.index` 按计划格式事先写好，直接启动 `target/debug/onedesk-worker`；从 socket 出现（开始监听）计时；第二次及以后的启动）：

| | 机器负载 | `hello` 答复 | `tree.children`（`plugins`）答复 |
|---|---|---|---|
| 改之前 | ~150 | +5.1 / 7.9 / 13.2 s | +16.5 / 27.2 / 34.9 s |
| 只改了 1 | ~130–240 | +5.4 / 6.6 / 7.1 s | +5.9 / 7.4 / 7.6 s |
| 1 和 2 都改 | ~20 | +1.9 / 2.0 / 2.4 s | **+2.0 / 2.2 / 2.6 s** |

机器同时有别的会话在编译，负载变化很大，“改之前”与“改之后”不是同一负载下测的；负载 ~20 时达到了“3 秒内”的目标。`hello` 剩下的约 2 s 是内核打开（读 `.index` 里 1 万个清单并校验、读 1 万个语言文件、选活动版本），本轮没再动：要更快得缓存校验结果或惰性读语言文件，会改变“语言文件坏了 → 整个包被拒”的现有规则，留给以后（已记入 `todo.md`）。首次启动（首次登记 1 万行插件状态）本轮没有重新测。

测试：`round10.rs` 的 `with_thousands_of_packages_the_first_answers_do_not_look_at_every_plugin`：3000 个包（有 `.index`），第二次打开后 `hello` + 第一批 `plugins`，再等后台自动切换跑完，逐个查插件状态的次数 < 1600（改之前约 3000×6）；最后一批的键与 `next` 正确；时间只设 60 s 的宽松上限。

## 4. 协议只增

- `PageSaveParams.overwrite?: string[]`
- `NodeState` 加 `"load-failed"`（Rust `NodeState::LoadFailed`）
- （`TreeNode.target` 原来就有，没变。）

`pnpm gen:types` 已重新生成并提交（`PageSaveParams.ts`、`NodeState.ts`）。

## 5. 新增的原因码 / 审计操作名

- 错误：`conflict` + `reason: "stale"`，`params.fields`、`params.rev`（另有兼容的 `params.field`）。
- 清单拒绝原因：`childrenWithoutTree`。
- 节点状态：`load-failed`，`stateReason` 为错误码。
- 审计操作名：**没有新增**（冲突照旧记 `resource.update` / `failed:conflict`；读插件节点不记审计）。

## 6. 我做的决定（设计没写到的）

1. 字段比较用快照按值比较，而不是只看修订记录的 `fields` 列：这样“改了又改回”不算冲突，与计划“用历史里的版本比较”一致；`params.*` 不在快照的顶层字段里，沿用 `fields` 列。
2. 冲突时整次保存都不写（包括不冲突的字段），让外壳拿到全部冲突字段一次处理完，避免半写。
3. 保留旧的 `params.field`，只增不改。
4. 插件节点的 `target` 不合格时丢掉 `target` 而不是让整批失败。
5. 插件一批超过 200 个时截断并按位置续取，而不是像提供树那样当错误（任务书的夹具每批 500 个）。
6. “加载失败”节点的 `stateReason` 放错误码，外壳按 `state` 配字。
7. `ctx.resource` 去掉密钥字段（与依赖插件读别人资源的规则一致），并深度冻结。
8. `children` 的参数顺序是 `(ctx, node, offset)`（与计划一致）；`migrate` 仍是 `(body, fromVersion, ctx)`。

## 7. 测试结果

`crates/kernel/tests/round10.rs`（15 个）：§4 七个（无交集照常保存且别处修改保留、有交集被拒列出字段与序号、`name`/`tags`/`body.*`（含新增、删除的键）各一例、`overwrite`、历史被清理、`basis` 不落后与不带 `basis`、插件写入）；§5 七个（清单 `children` 校验、未声明注册被拒、存储在前插件在后与分批与键不冲突与不可改名移动、`target` 校验、出错与超时的加载失败、停用时不显示、`ctx.resource` 只读与 `locale`）；§7 一个。

完成标准里的检查见本文件末尾“检查结果”。

## 8. 没做 / 没验证

- 没有连真外壳或 e2e 跑过（`e2e/round10.spec.ts` 是测试会话合并后的事）；夹具 `com.example.nested` 没拿来跑（不在本分支）。
- release 构建没测速；首次启动（首次登记）没重新测。
- `node.open` 只给 `nodeKey`（不给 `target`）时插件节点打不开（见 §2 “外壳要注意”）。
- `tree.path` 对多层插件节点不给中间层。
- 插件节点的变化没有专门的事件：插件给的内容变了，外壳需要重新展开（或等资源本身的变化通知）。

## 检查结果（2026-11-17，本分支最后一个提交上实际跑过）

- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过（kernel 单元 135、集成各文件全过，`round10.rs` 15 个，worker 5 个），0 失败。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：通过（第一次跑有两处 `too_many_arguments`，按代码里已有的做法加了 `#[allow]` 后重跑通过；之后只改了属性，测试没有再整体重跑）。
- `sh scripts/gen-types.sh --check`：协议类型是最新的。
- `pnpm lint`：架构检查、界面规范检查通过。
- 没跑：`pnpm check` 的其余部分（`typecheck`、前端 `test`、`e2e`）——不在内核会话的范围里。

## 审查后的修改（`round10-review.md` #3、#4、#11）

先合并了协调分支 `claude/onedesk-coord-3-f0c048`。三条都在一个共用的函数里（`kind_children.rs` 的 `parse_batch`），类型自供子节点和已有的提供树 `children` 都经过它：

- **#3**：插件返回的 `next` 不大于本批的 `offset`，或这一批（去重后）为空却带 `next` → 当作到头（不发 `next`）。类型自供子节点按插件自己的 offset 比较，再加上存储子节点数发出去。
- **#4**：一批里重复的键只留第一个；键等于父节点键的节点去掉。限制：内核只知道直接的父节点，更上层的祖先（提供树的、或多层插件节点的）不查——要查得每批都调插件的 `path`；外壳那边按审查意见加已访问集合兜底。
- **#11**：标签按字符截到 200 个；一批超过 1000 个节点在解析节点之前就当作出错（提供树：`pluginError`，详情 “more than 1000 nodes in one batch”；类型自供子节点：显示“加载失败”节点）。提供树原有的“一批超过 200 个 → 出错”保留；类型自供子节点 201–1000 个照旧截成 200 个续取。

测试（`round10.rs` 新增 3 个，两种树各覆盖）：`a_next_that_does_not_advance_ends_the_listing`、`repeated_keys_and_a_key_equal_to_its_parent_are_dropped`、`labels_are_cut_and_oversized_batches_fail`。

检查（合并后、本次提交的代码上实际跑过）：
- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过（`round10.rs` 18 个）。注意：机器负载 400–460 时 `round6.rs` 的 `review4_queues_are_bounded_and_failures_merge` 连续失败两次（事件队列没被塞满：`dropped: 0`——它依赖处理函数比事件来得慢，属计时敏感）；负载 ~340 时整套重跑（`--no-fail-fast`）全部通过。本次修改不涉及事件队列，合并进来的协调分支也没改 `crates/`。
- clippy（`-D warnings`）、`sh scripts/gen-types.sh --check`（协议没有改动）、`pnpm lint`：通过。
