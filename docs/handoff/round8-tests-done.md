# 第八轮 · 插件与测试 · 第一阶段交接

分支 `claude/r8-tests-b44c32`。只做了第一阶段；`e2e/round8.spec.ts`（第二阶段）没写。

## 做了什么
1. `e2e/fixtures/plugins/com.example.transfer/0.1.0/`：`requires` = `files: true`、`network.fromResources`、系统程序 `cat`；类型 `job`（`url` 带 `grants: network`、`path`）；页面 `editor`（两个绑定字段，运行页只读）；动作 `download` / `upload` / `capture`，`onProgress` 里调 `ctx.progress`，宿主错误不捕获。`capture` 用 `cat <path>` 写到 `<path>.copy`。
2. `com.example.board/0.1.0/`：存储树 `board`、`hidden`；类型 `card`（树 `board`、页面 `card`）；页面 `card` 的动作 `save`（role save）、`upper`（role event，未保存文字改大写经 `changes` 返回，无草稿时退回已存正文）；`exports.trees=[board]`、`exports.pages=[card]`。
3. `com.example.board-extra/0.1.0/`：`depends` board `>=0.1.0`；`memo`（`tree`/`page` 写全名，`menus.new` 含）、`stray`（树 `com.example.board:hidden`，也在 `menus.new` 里，便于验“不可新建”）；动作 `shout`（`kinds: ["memo"]`，正文加 `!`）。
4. 市场插件：下拉改 `param: true`、去掉 `bind` 和渲染的 `values`；读 `ctx.params.pick`；装完返回 `{ params: { pick: "" }, message }`。`plugins/_testing/view-check.ts` 的 `EVENT_RESULT_KEYS` 加了 `params`。
5. `e2e/fixtures/transfer-server.mjs`：`node transfer-server.mjs <port>`（0 = 自动选，会打印）；也可作模块 `startServer({port})`。只监听 127.0.0.1（传别的 host 直接抛错）。路由：`GET /bytes/<n>`（带 Content-Length，字节 i = i%251）、`/nolength/<n>`（分块）、`/slow[/<毫秒>]`（每次 1 KiB，默认 100 ms，最长 10 分钟，用于取消）、`/status/<码>`、`PUT|POST /sink[/名]`（记字节数）、`GET /received`、`POST /reset`。

测试：`plugins/_testing/round8-fixtures.test.ts`（三个夹具，假 host）、`plugins/_testing/transfer-server.test.ts`（真起本机服务）、`plugins/org.onedesk.market/main.test.ts` 更新。

## 结果（实际运行）
- `pnpm test`：40 个文件、335 个测试全过。`pnpm lint`、`pnpm typecheck` 通过。
- 所有新 JSON 用 `python3 -m json.tool` 校验过。
- 没跑：cargo、clippy、e2e（不在本阶段范围，也没有内核实现可连）。

## 我的假设（合并后对着真内核核对）
- 新清单字段 `exports.trees/pages`、类型的全名 `tree`/`page` 当前内核还不认；夹具只是按 round8-plan §4 写的，没被真内核加载过。
- 页面声明里 `role: "save"` 的动作 `id` 取 `save`、`role: "event"` 的取 `upper`；`board` 没有 kind 级动作（任务书的 `save` 理解为页面动作）。
- `board` 的 `card` 页面没写 `recompute`（默认 false）；`transfer` 的 `editor` 也是。
- 页面参数字段的键就是字段 `name`（`pick`），`ctx.params.pick`。参数里的值若已不在选项里，市场不清它（旧版会在渲染时清）；安装时由内核校验文件夹。
- `transfer` 的类型字段 `path` 没标 `grants: files`（文件授权走宿主的 `files` 规则，不靠资源授权）；若第二阶段发现要靠字段授权再改。
- `stray` 没有 `page`；`transfer.job` 用 `tree: "resources"`（同 command 夹具）。
- 夹具的图标名（`arrow-down-up`、`notebook-pen`、`megaphone`、`case-upper`、`circle-help`、`eye-off`、`layout-dashboard`）没核对外壳的图标表，不认的话可能显示默认图标。

## 没验证
- 夹具没被真内核加载过；`transfer.*` 的真实行为、进度回调节奏、取消后的临时文件全没验。
- 假数据模式/截图没看（市场插件不在假数据原型里，但没确认）。
