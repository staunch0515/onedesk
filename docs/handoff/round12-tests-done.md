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
