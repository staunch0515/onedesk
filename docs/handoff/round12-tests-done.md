# 第十二轮 · 插件与测试 · 第一阶段完成说明

只动了 `plugins/org.onedesk.composite/`、`plugins/org.onedesk.collection/`（新）、`plugins/org.onedesk.http/`、`plugins/_testing/locale-check.test.ts`（把两个新插件加进三语键一致检查）和本文件。没改 `scripts/check-*.mjs`（架构检查不需要认新字段）、没写 `e2e/round12.spec.ts`（第二阶段）。

## 1. 做了什么

- **综合 `org.onedesk.composite`**：`requires.resources: true`；类型 `composite`（树 `resources`，`children: true`，`drop: true`，`accepts: ["composite"]`，默认 `items: []`）。
  - `drop(ctx, ev)`：把 `ev.sources` 的 id 追加进 `body.items`（已有的、综合自己不加；上限 1000），用 `ctx.host.resources.update(id, {"body.items": [...]})` 写；返回 `{ handled: true, message: "已加入 N 项" }`（N 为新加的个数）。
  - `children(ctx, node, offset)`：按 `items` 顺序，每批 200，`next` 是插件自己的位置；`resources.search({ ids, limit: 500 })` 取名称图标；节点键 `ref-<id>`，带 `target: "resource:<id>"`；查不到或已删除的给“（已不存在）”节点，不带 `target`。
  - 页面 `editor`：表格（图标、名称、类型）+ `rowTargets`（点行打开资源，失效行为空串）；空时一句“把内容拖到这个节点上。”；页面动作只有“保存”。
  - 页面事件：`remove:<资源id>`、`up:<资源id>`、`down:<资源id>`，返回 `changes: {"body.items": 新数组}`（改未保存草稿，保存后才落库），移除另带提示文字。优先读草稿里的 `body.items`。
- **集合 `org.onedesk.collection`**：`requires.resources: true`；类型 `collection`（`children: true`；字段 `kinds`、`tags`、`text` 都是文字）。`children` 用 `resources.search({kinds?, tags?, text?, limit: 200, offset})`，三项都空不给节点；节点键 `hit-<id>`，带 `target`；集合自己不出现在结果里。页面：三栏条件表单（绑定 `body.kinds/tags/text`，`recompute: true`，按未保存草稿搜索）+ 总数提示 + 结果表（前 200 条，`rowTargets`）；全空时提示“至少填一项条件”。
- **HTTP 请求补全 `org.onedesk.http`**（旧字段名一个没改）：
  - 方法只留 GET/POST/PUT/PATCH/DELETE/HEAD（去掉了原来的 OPTIONS，发 OPTIONS 报“不支持这个方法”）；新增字段 `query`（多行 `名=值`，`secrets: true`，参与 `:name` 参数），发送时拼到地址后（已有 `?` 用 `&`，`#` 之前，名和值做百分号编码，`{{secret:…}}` 原样保留）。
  - 页面分区：方法+地址一行、查询参数、令牌、请求头、正文。
  - 结果：新增结果页签 `info`“状态”（状态码+状态文字、耗时、大小）；原 `headers` 页签（表）不变；`response` 输出：`Content-Type` 含 json 且能解析时 2 空格缩进排版，否则原样；HEAD 输出为空。摘要“200 OK · 12 ms · 5 bytes”。状态文字取宿主给的 `statusText`，没有就查一张小表，再没有就空。
  - 英、中、日三份语言文件键一致（新增 9 个键，日文原来就有）。

## 2. 测试结果（在本工作树实际跑过）

- `npx vitest run plugins`：19 个文件、295 个用例全过（新增 composite、collection 两个测试文件，http 增加 8 个用例并改了 3 个旧断言：OPTIONS、分区个数、摘要里的状态文字）。
- `pnpm lint` 通过；`pnpm typecheck`（`tsc -p .`）无输出通过；`pnpm test` 539 个用例全过（61 个文件）。第一次全量跑时与 lint、typecheck 并行，有 3 个用例失败（`src` 里虚拟滚动 Tree 的大数据用例，按时间断言，机器负载高时超时，不是我改的代码）；单独重跑全过。
- 没跑：`pnpm test:rust`、`pnpm e2e`（没碰这些）。没连真内核。

## 3. 我做的假设（合并后要对着真内核核对）

1. **表格行事件**：现有视图表格没有“行内按钮”，事件也不带参数。我约定事件名 `remove:<id>`、`up:<id>`、`down:<id>`（`PageEventParams.event` 是字符串，内核按“视图节点携带的名字”放行；**内核是否放行这种未在页面 `actions` 里声明的事件名，没核对**）。外壳要在综合页的表格行上给出这三个按钮并按这个名字发事件；外壳没做的话，页面上现在看不到这些按钮（点行打开资源可用）。
2. **失效节点**：自供子节点只允许 `key/label/icon/expandable/target/badge`，没有“状态”字段。我用图标 `unlink`、名称“（已不存在）”、不带 `target` 表达；“失效样式”要外壳按图标或空 `target` 处理。
3. **`items` 存数组**：`resources.update(id, {"body.items": [...]})` 能写数组、清单里 `defaults.items: []` 能放数组、页面事件的 `changes` 能带数组并在“保存”时合并进正文——都没有真内核验证。`items` 没在 `fields` 里声明（不是文字字段）。
4. **`search` 的返回**：`{ items, total, next? }`；`ids` 取回时已删除的带 `deleted: true`（我把它们当失效处理）；`kindLabel` 可有可无。集合的续取用插件位置（= `search` 的 offset），`next` 有就继续。
5. **`drop` 的 `ctx.resource.body`** 可读 `items`；`ev.sources[i].id` 是资源 id；返回的 `message` 我给的是纯字符串（`Label` 的文字形式），没给多语言对象。
6. 集合的 `kinds` 条件要填类型**全名**（如 `org.onedesk.note:note`），页面里没做类型下拉。
7. 综合 `accepts: ["composite"]` 按计划写的类型短名；内核若要求全名要改。
8. 清单新字段（`requires.resources`、`drop`）：`pnpm lint` 的架构检查只扫文件内容，没有清单字段校验，所以没改脚本；内核的清单校验若先于本轮内核合并，这两个插件会被旧内核拒绝（预期）。

## 4. 没验证的

- 两个新插件和 http 的新页面在真内核、真界面里的样子（拖放、展开、图标、行按钮、保存草稿）。
- `requires.resources` 进安装确认与指纹、`resourcesAll` 权限文字（内核和外壳的活）。
- 本轮内核/外壳合并后的集成：留给第二阶段 `e2e/round12.spec.ts`。


# 第二阶段（`e2e/round12.spec.ts` 连真内核）

## 结果
- `E2E_PORT=1437 pnpm exec playwright test e2e/round12.spec.ts`：**27 通过、0 跳过、0 fixme**（连真内核；devhost 用内存密钥库和临时目录）。（协调会话说 1436 端口；我这边被一次中断的运行占着，换了 1437，无影响。）
- `pnpm lint` 通过；`pnpm typecheck` 通过（修了 spec 里一处类型）；`vitest run plugins`：291 通过、4 失败——都是 `plugins/_testing/lang-check.test.ts`，即协调会话说的“`en-US.ts` 新键两个语言插件还没补”，**按指示没动**，等第十一轮 `kernel.*` 补完合并后再补本轮的 `permission.resourcesAll` 等键（中文：读取本工作区所有内容的名称、类型和位置（不含正文））。
- 截图 `docs/screenshots/round12-*.png` 留在工作树里未提交（`git checkout -- docs/screenshots` 已执行，不影响已跟踪文件）。

## 覆盖
- 综合（协议）：`dropAny` 在综合节点上、笔记没有；移动笔记/网址到综合 → `handled`、提示“Added 1 item(s)”、父节点不变、`items` 增加；重复拖不重复（提示 0 项）；审计 `tree.drop`（来源 plugin、目标名称、摘要含 sources）；`children` 带 `target` 的节点；被引用资源删除后节点“(no longer exists)”、无 target，还原后恢复；综合拖进综合是真移动；嵌套综合里再放引用。
- 综合（页面按钮）：`page.event` 的上移/下移/移除，移除不删资源；没选时提示。
- 综合（界面）：合成指针拖放后出现提示、展开看到引用、点开是原笔记；综合页的列表与“Item”下拉 + 上移/移除按钮。
- 集合：按类型、标签（都含有）、文字、组合；新建符合条件的资源后重新展开出现、改标签后消失；三项都空不列节点且页面提示；页面总数与结果表；230 条分 200 + 30 两批（这条放在最后，免得 230 条笔记把别的条目挤出虚拟滚动的树）。
- 权限：`app.inspectPlugin` 对 peek 列出 `resourcesAll`（detail 为空）、nopeek 没有；`plugin.get` 里综合插件含 `resourcesAll`；`search` 结果没有 `body`/说明、`limit`/`next`/`total`、`ids`（不存在的不出现、已删除的标 `deleted`）；没声明的夹具 → `denied/notRequested`。
- HTTP：GET/POST/PUT/PATCH/DELETE 都到达服务器，GET 不带正文；查询参数拼接与编码；请求头；JSON 排版；状态页签（状态码+文字、耗时、大小）与响应头表；HEAD 无正文；404 仍是成功的运行并显示 404 Not Found；非本机地址 → `denied`；空地址 → 明确错误；页面上点“Send”后看到结果。

## 这一阶段改了什么（相对第一阶段）
- **综合页的按钮做法变了**：第一阶段按“行事件 `remove:<id>`”写，对真内核不成立——内核只放行改“页面上绑定了的字段”的 `changes`，而且表格视图节点没有行内动作。改成：页面里一个参数下拉“Item”（`param: true` 的枚举）选条目，页面动作“Move up / Move down / Remove”（`role: event`）经 `ctx.host.resources.update` 直接写 `body.items`。
- `e2e/fixtures/plugins/com.example.peek`（声明 `requires.resources`）、`com.example.nopeek`（没声明）；`e2e/fixtures/transfer-server.mjs` 加了 `/echo`。
- 重建了 `target/debug/onedesk-worker`（devhost 用的是它，不是 devhost 里的内核；旧二进制不认 `drop`/`legacyKinds`）。

## 发现的、需要别人决定的问题（没有 fixme，因为不影响通过）
1. **外壳的 `rowActions` / `context.row` 与内核不通**：外壳（`round12-shell-done.md` §5）自定了表格节点的 `rowActions` 和事件上下文 `row`，但内核的 `ViewNode::Table`（`deny_unknown_fields`）没有 `rowActions`，`PageContext` 也没有 `row`；插件一返回 `rowActions` 内核就拒绝。要么内核只增这两个字段（并记入 decisions.md），要么外壳删掉。在那之前，行内按钮没有可用路径，综合页用上面的“下拉 + 页面按钮”。
2. 自供子节点没有“状态”字段，失效节点只能靠名称“(no longer exists)”、`unlink` 图标和没有 `target` 表达；外壳里 `state: "broken"` 的样式对它不起作用。
3. `run.get` 的状态是 `success`/`error`（不是 `done`/`failed`）。
4. 审计里 `tree.drop` 的 `target` 是资源名称，不是 id。
5. 第一阶段假设 3（`items` 数组可写、可存、可默认）在真内核里成立；假设 5（`message` 为纯字符串）成立（返回 `Added N item(s)`，内核按 Label 原样给出）。
