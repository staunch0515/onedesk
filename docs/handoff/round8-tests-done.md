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


---

# 第二阶段（`e2e/round8.spec.ts` 连真内核）

分支已合并协调分支 `c037b00`。devhost 用 `cargo build -p onedesk-worker -p onedesk-host` 在本工作树里编的；运行：`E2E_PORT=1435 pnpm exec playwright test e2e/round8.spec.ts`（devhost 内存钥匙串、临时数据目录；传输服务在进程内起、只听 127.0.0.1）。

## 结果（实际跑过）
- `round8.spec.ts`：19 个，**18 过、0 失败、1 `test.fixme`**（下面的内核缺陷）。
- 回归：`round5.spec.ts` + `round7.spec.ts` 共 35 个全过（round7 里市场的 `page.event` 上下文改成 `params: { pick }`，因为市场不再读草稿里的 pick）。`round5` 里已没有 `test.fixme`（外壳会话早已去掉，“永久删除确认框的被引用数”那条是正常通过的测试）。
- `pnpm test`（40 文件/337 条）、`pnpm lint`、`pnpm typecheck` 通过。`workbench.spec.ts`、round2/3/4/6、cargo、clippy 这次没跑。
- 新截图 `docs/screenshots/round8-*.png`（5 张）保留；已 `git checkout -- docs/screenshots` 还原基准。

## 覆盖（对应 round8-plan §1）
transfer：小文件、40 MB（沙箱内存上限以上）和 5 MB 分块（无 Content-Length）下载逐字节相同（sha256）；非 2xx 不写文件；上传 3 MB+17 服务端收到的字节数；capture 的 `.copy` 逐字节相同；审计三种操作名、不含地址路径、不重复记 `network.request`/`process.run`；慢速下载在界面里发起，状态栏/结果区/任务面板有 “N bytes” 进度，取消后目录里没有目标文件也没有 `.part-`（期间确实存在 `.part-`）；拒绝：地址不在授权（`hostNotAllowed`）、路径在授权外（`outsideGrant`）、目标已存在（`conflict/exists`，文件不变）、程序被 `process.allow` 挡（`blockedByPolicy`，`params.program = cat`，界面文字里有“cat”）。
导出点：安装 board、board-extra，确认框权限 `pages`（detail 含 `com.example.board:card`），board 本身没有；board 树的 menu 有 `new:…:memo`、没有 stray；`stray` 新建 → `denied/notExported`，`export = com.example.board:hidden`，`unmetExports` 正是它；memo 建在 board 树里（不在 resources 树）；页面是 board 的（字段 `body.text`、`save`/`upper`、操作区有 shout、没有 `view` 页签）；`upper` 经 `changes` 返回，保存后重开仍在；`shout` 运行结果 `MAKE THIS LOUD!`；界面里编辑、转大写、Cmd+S、重开仍在；插件页写明没导出的类型；停用 board 被拒（dependents），board-extra 先停再停 board 再启 board-extra → `dependsUnmet`，board 回来恢复、memo 内容仍在。
市场：选包后没有“Unsaved”，装完下拉清空。

## 缺陷（`test.fixme`）
- **内核：被拒的网络地址的 `RunError.params` 里没有 `host`。** 复现：transfer 的 job 资源保存的地址是 `http://127.0.0.1:<端口>/…`，运行时把 `body.url` 换成 `http://localhost:<端口>/bytes/10` 跑 `download` → `error = { code: "denied", reason: "hostNotAllowed" }`，没有 `params`。外壳有 `reason.hostNotAllowed|host`、`blockedByPolicy|host` 的文字，但内核只给程序一端带 `program`/`layer`（`crates/kernel/src/process.rs:555`），`network.rs` 的 `denied("hostNotAllowed")`/`denied("blockedByPolicy")` 不带 `host`。所以“网络被拒的运行错误里写明是哪个主机”目前做不到。用例 `refused: the error of a refused address names the host`，修了去掉 `.fixme`。

## 观察到、没追的
- 一次早先的运行里 vite 日志出现 `Maximum update depth exceeded`（慢速下载正在高频进度、界面刚打开时；之后的运行没再出现），之后状态栏的按钮一度找不到。没有稳定复现，也没确认根因；怀疑外壳在运行进度更新上有 setState 循环，供外壳会话留意。
- 市场页在选包/装完时 Radix 的 `Select is changing from uncontrolled to controlled`（和反向）警告各出现一次——选包参数在值为空时变成 undefined，建议外壳传 `""`。
- 状态栏在有运行时显示 “N running” 而不是 “Tasks: N”（测试里按两者之一找按钮）。
- 任务面板只列本窗口发起的运行：用协议客户端（另一个连接）发起的运行不在面板里，所以进度那条用例是在界面里点 “Download” 发起的。

## 我做的假设（已对真内核验证的）
- 回环地址要在工作区配置 `network.allow` 里写成 `127.0.0.1:<端口>`（不写端口只允许 80/443）；资源保存的地址授权主机，运行输入里的 `body.url` 不授权。
- 夹具 `transfer.job` 的 `path` 不需要 `grants: files`，授权文件夹用 `plugin.grantFolder` 即可。
