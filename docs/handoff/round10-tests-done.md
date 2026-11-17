# 第十轮 插件与测试 第一阶段——交付

## 做了什么
1. 新夹具 `e2e/fixtures/plugins/com.example.nested/0.1.0/`（清单、`main.js`、英/中语言文件）：
   - 类型 `shelf`，清单 `"children": true`，`defaults {count: 0, text: ""}`；页面 `editor` 一个表单，字段绑定 `body.count`、`body.text`，`save` 动作。
   - `kinds.handle("shelf", { children(ctx, node, offset) })`：数量取 `ctx.resource.body.count`；每批 500 个，`next` 是下一批的起点（字符串，如 `"500"`），整除时最后一批不带 `next`；节点键 `item-<n>`，标签 `Item 00001`…（中文 `条目 00001`）；仅第一个节点带 `target: "resource:<资源 id>"`；`count` 为 -1 时抛错；非数字按 0。
   - 动作 `touch`（运行）：`ctx.host.resources.update(ctx.resource.id, {"body.text": "changed by the plugin"})`（中文界面为“由插件改的”）。
2. 示例插件 `plugins/org.onedesk.sample/`：新增动作 `big`（标签“Big table (10000 rows)”），无参数，产出 1 万行 × 5 列（id、customer、amount、status、date），固定可复现，忽略 `rowLimit`；清单里 `actions` 和 `editor` 页面（role `run`，按钮在“解释”后面）都已加。现有 `run` 动作做不到（最多约 500 行、4 列），所以新加。触发：打开示例查询页，点“Big table”按钮。
3. 测试：`plugins/_testing/round10-fixtures.test.ts`（nested 夹具，假 host）；`main.test.ts` 更新了注册列表并加了 `big` 的用例。

## 测试结果（实际跑过）
- `pnpm test`：43 个文件、364 个用例全过。`pnpm lint`（架构 + 界面规范）通过。`pnpm typecheck` 通过。
- 所有 JSON 已用 `python3 -m json.tool` 校验。

## 我做的假设（合并后对着真内核核对）
- `children` 的 `offset` 是上一批返回的 `next` 原样回传（第一批为空/undefined）；`node` 参数我没用。
- `ctx.resource` 在 `children` 和动作里形如 `{id, body: {count, text}}`（与 note-tools 夹具读 `res.body.text` 一致）。
- 节点键是 `item-<n>`，内核加前缀；`next` 用字符串。
- `touch` 动作用 `ctx.resource.id`；写自己类型的资源需内核允许（note-tools 写别的插件的类型被拒，这里是自己的）。
- （已对真内核核对，见第二阶段）清单 `children` 字段在 `kinds[]` 里，与计划书一致；当前内核可能尚不认识该字段，装这个夹具会在内核合并前失败或被忽略。
- 用 `count` 在 `defaults` 里写数字，页面表单的 `number` 字段写回的类型（数字还是字符串）未验证；`countOf` 对两者都能处理。

## 没验证的
- 没有在真内核、真外壳里跑过；`e2e/round10.spec.ts` 属第二阶段，未写。
- 在 `pnpm test` 满载并行时 20000 节点的用例曾超过默认 5 秒，已把该用例超时放宽到 30 秒；未跑 `pnpm e2e`、Rust 测试。


---

# 第二阶段：`e2e/round10.spec.ts`（连真内核）

分支 `claude/r10-tests-7cffc0`，已合并协调分支 `e30b9d9`。devhost 用 `ONEDESK_SECRET_STORE=memory` + 临时数据目录（`kernel-host.ts`），`E2E_PORT=1435`。**注意**：跑之前要 `cargo build --workspace`（devhost 会拉起 `onedesk-worker`，只编 `-p onedesk-host` 不会更新 worker，我一开始就栽在这里：旧 worker 不认 `children`）。

## 结果（实际跑过）
16 个用例：**14 过、2 跳过（`test.fixme`）、0 败**，整套一次跑完（约 3.4 分钟，机器负载 300 左右）。

覆盖：大树（协议 100 批共 20000 个、键唯一、第一个可打开其余无 target、不可拖动；界面展开后 DOM 行 < 200、滚到底看到 `Item 20000`、第一个节点能打开）、切语言后节点名变、`count=-1` 协议给一个 `load-failed` 节点、停用插件后无插件节点；大表格（DOM 行 < 200、滚到底、点列头排序后第一行变）；合并协议层（不同字段两边都在、同字段 `conflict/stale` 含 `fields`/`rev`、`overwrite` 成功）；合并界面（改名无提示条且都保存、同字段出提示条、“保留我的”“采用新的”、nested 的 `touch` 出提示条）；通知（铃铛未读数、面板、清空）；插件页标题随语言、没有 `files` 的插件无“Granted folders”、有 `files` 的有。

## 发现的缺陷（没改别人的文件）
1. **外壳不认内核的 `load-failed`**（`test.fixme`）：内核给“加载失败”节点 `state: "load-failed"`、标签为空；`src/workbench/parts/side-panel.tsx:180` 只在 `state === "broken"` 时配“Could not load”，所以界面上是一个没有文字的行。协议层这条已在测试里确认（`state=load-failed`，不可展开、无 target）。需外壳会话认 `load-failed`（`src/design/components/tree.tsx` 的 `TreeNodeState` 也没有这个值）。
2. **结果表格最多 1000 行**（`test.fixme` 的那个用例）：`crates/kernel/src/runs.rs` 的 `MAX_ROWS = 1000`，`big` 动作的 1 万行到结果区只有 1000 行（`total` 仍是 10000、`truncated` 为真）。计划 §1 的“结果区 1 万行”做不到，要么提高上限、要么分页（内核/协调会话定）。现有用例改为在这 1000 行上检查窗口化（DOM 行 < 200、滚到 `data-index=999`、排序）。
3. 夹具修正：内核要求 `children` 返回的 `next` 是**数字**（不是我第一阶段写的字符串），已改夹具和单元测试。内核一批最多 200 个（夹具给 500 个会被截成 200，`next` 由内核算），所以 20000 个节点是 100 批。

## 没验证 / 注意
- 没跑整套 `pnpm e2e`、`workbench.spec.ts`；只跑了 `round10.spec.ts`。截图 `docs/screenshots/round10-*.png`（7 张）是新增的；基准截图已 `git checkout -- docs/screenshots` 还原。
- 合并后外壳有 4 处类型错（协调会话说明外壳在对齐），我没有碰；vite 运行不受影响。
- 大树用例在负载很高时慢（约 1 分钟），已给 120 秒的用例超时。
- 一个坑：在 playwright 里对每个节点写 `expect` 会让 8 万次 `expect` 把用例拖到超时，所以大树的逐节点检查改成普通判断、收集问题后一次 `expect`。
