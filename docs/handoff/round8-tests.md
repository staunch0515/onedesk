# 任务：第八轮——插件与测试，第一阶段（Sonnet）

协调分支 `claude/onedesk-coord-3-f0c048`（你的工作树从它切出）。内核和外壳会话同时在写；这一阶段你只做不依赖它们的部分。第二阶段（`e2e/round8.spec.ts` 连真内核）等合并后由协调会话另行通知，**这一阶段不要写**。

## 目标
夹具的写法照 `e2e/fixtures/plugins/com.example.command/`、`com.example.note-tools/`；清单格式与宿主接口见 `round8-plan.md` §3–§5，名字已定死。每个都有英、中语言文件和 vitest（假 host）。

1. `e2e/fixtures/plugins/com.example.transfer/0.1.0/`：`requires` 要网络（由连接资源决定，照 `plugins/org.onedesk.http` 的写法）、`files: true`、系统程序 `cat`（照 `com.example.command`）。一个类型 `job`（字段：`url` 授权地址、`path` 文字），页面一个表单；三个动作（输出文字）：`download`（`transfer.download({ url, to: path })`，`onProgress` 里调 `ctx.progress`，输出状态码与字节数）、`upload`（`transfer.upload({ from: path, url })`，输出状态码）、`capture`（`transfer.capture({ program: "cat", args: [path], to: path + ".copy" })`，输出字节数）。宿主错误原样抛出。
2. `e2e/fixtures/plugins/com.example.board/0.1.0/`：自己的两棵存储树 `board`、`hidden`；类型 `card`（在 `board`，页面 `card`：一个绑定 `body.text` 的长文本字段，动作 `save` 和一个 `event` 动作 `upper`——把未保存的文字改成大写，经 `changes` 返回）；`exports`：`trees: [{ id: "board" }]`、`pages: [{ id: "card" }]`（不导出 `hidden`）。
3. `e2e/fixtures/plugins/com.example.board-extra/0.1.0/`：`depends` `com.example.board`（`>=0.1.0`）；类型 `memo`（`tree: "com.example.board:board"`，`page: "com.example.board:card"`，字段 `text` 长文本，`menus.new` 含它）；类型 `stray`（`tree: "com.example.board:hidden"`——用来验证“没导出”）；动作 `shout`（`kinds: ["memo"]`，输出文字：正文加感叹号）。
4. `plugins/org.onedesk.market/`：“要安装的包”下拉从 `bind: "pick"` 改为 `param: true`，读 `ctx.params.pick`，装完后经 `PageEventResult.params` 清空（`{ params: { pick: "" } }`）；更新 vitest。
5. `e2e/fixtures/transfer-server.mjs`（或同类）：第二阶段要用的本机临时 HTTP 小服务（GET 返回指定大小的内容、PUT 记下收到的字节数、一个慢速地址用于取消），只监听 127.0.0.1、端口由参数给；这一阶段只写它和它的单元测试。

## 允许修改
`plugins/**`、`e2e/fixtures/**`、`scripts/check-*.mjs`；`docs/handoff/round8-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round8-plan.md`、`crates/**`、`src/**`、现有夹具。

## 完成标准
`pnpm test`、`pnpm lint`（含架构检查和内置插件的检查）、`pnpm typecheck` 通过；写完 JSON 立即 `python3 -m json.tool` 校验。

## 交付物
自己分支上的提交（不推送、不合并）；`docs/handoff/round8-tests-done.md`：做了什么、测试结果、我做的假设（合并后要对着真内核核对的）、没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round8-plan.md`、本文件；其余按需读。只改“允许修改”里的文件；不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：做完就停。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
