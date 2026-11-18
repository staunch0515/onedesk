# 任务：第十三轮——插件与测试（Sonnet）

协调分支 `claude/onedesk-coord-4-3ac9ba`（你的工作树从它切出）。

## 第一阶段
1. 第一版测试夹具：`e2e/fixtures/legacy-v1/` 里一个按 `git show bf8f6b0^:src-tauri/migrations/0001_init.sql` 建库并写入数据的脚本（Node，不加依赖；用现有 devDependencies 里能开 SQLite 的，没有就用 `sqlite3` 命令行并在交接文件写明），数据覆盖：每种第一版类型（网址、笔记、提示词、HTTP 请求，正文字段按第一版源码 `bf8f6b0^` 里的写法）、多层 `group_name`、两种集合规则、插件存储、密钥名字、`app_settings` 的语言。
2. 内置插件的 `upgrade`（`round13-plan.md` §2，宿主接口 `host.kinds.handle(kind, { upgrade(ctx, { body, legacyKind }) })`）：网址、笔记、提示词、HTTP 请求把第一版的正文字段转成现在的字段（已有字段名不改）；集合插件加 `legacyKinds: ["collection"]`，把 `ruleType/ruleValue`（`tag`/`kind`）转成 `tags`/`kinds` 条件（第一版 kind 规则里的短类型名转成对应的全名）。假 host 的 vitest 覆盖每种转换和坏数据。
## 第二阶段（合并后，协调会话通知你）
`e2e/round13.spec.ts` 连真内核（`round13-plan.md` §5）；补本轮外壳新增英语文字的中、日译文。

## 允许修改
`plugins/**`、`e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`docs/screenshots/`；`docs/handoff/round13-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 完成标准
`pnpm test`（含 lang-check、locale-check）、`pnpm lint`、`pnpm typecheck` 通过；第二阶段 `round13.spec.ts` 跑通，没有 `test.fixme`（别人的缺陷可先 fixme 并写进交接文件）。

## 交付物
小步提交（不推送、不合并）；`round13-tests-done.md`：夹具的内容与用法、第一版各类型字段与转换表、测试结果、我做的决定、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round13-plan.md`、本文件；设计文件按需读小节，不整篇读。
- 只改“允许修改”里的文件。内核里不得出现任何具体插件的名字或逻辑。与设计不一致或设计没写到的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录、本机临时 HTTP 服务和内存密钥库（`ONEDESK_SECRET_STORE=memory`），绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`（那里可能有用户真实的第一版 `onedesk.db`，**不要读、不要拷**；夹具自己建）。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。做完用 SendMessage 把汇报发给协调会话（回复它发给你的消息的发送方），开头写分支名和最后一个提交号。
