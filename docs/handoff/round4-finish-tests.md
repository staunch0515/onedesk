# 任务：第四轮收尾——插件与界面检查（Sonnet）

协调分支：`claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。上一个测试会话的进度已合并在这个分支里：先读 `docs/handoff/round4-tests-done.md`（尤其是它最后写的“做到哪、还差什么”），**从它停下的地方接着做，不要重写**。

## 目标

1. HTTP 插件清单：`request` 类型的 `url`、`headers`、`body` 字段声明 `"secrets": true`（D318；清单格式见 `docs/handoff/round4-kernel-done.md` 的“验收后的修改（D317、D318）”一节）。如已做，核对并补 vitest。
2. 把 `e2e/round4.spec.ts` 做完并连真内核跑通。必须覆盖（`round4-plan.md` §1，加审查与 D311–D318）：
   - 安装确认框列出权限、新增的被标出；坏包被拒并说明原因；手动拷进插件文件夹的包显示未确认、不能启用。
   - 装 `0.2.0`：自动切换与接管（`note` 出现）；版本表；切回 `0.1.0`；撤销升级后**重启不会又升回去**；`0.3.0` 升级失败且什么都没变；移除有资源绑定的版本后显示缺少插件。
   - 密钥页：新增、改值、删除，值看不到。
   - HTTP 请求：发送后状态码、耗时、正文；`{{secret:名字}}` 代入后本机测试服务器收到真值，而界面、`run.get`、数据库文件里都没有；换端口被拒（D317）；重定向到别的主机（端口）时密钥头不带过去（D316）；`network.allow` 收紧；草稿里新写的密钥名字未保存就发送被拒；未保存的新建请求页面填了密钥直接发送后数据库文件里没有明文。
3. 发现内核或外壳的缺陷：不改别人的文件，用 `test.fixme` 标出并写进交接文件（问题、复现步骤、位置）。外壳会话同时在补 `RunError.reason` 的文字，所以涉及“被拒时显示的文字”的断言先按原因码或 `data-` 属性断言，不要断言具体文字。

## 允许修改

`plugins/**`、`e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`docs/screenshots/`（只新增 `round4-*`；别的基准截图被改写了就 `git checkout` 还原，不要提交）；`docs/handoff/round4-tests-done.md`（追加“第二阶段”一节）；`docs/handoff/todo.md`（只追加）。

## 只读依赖

`crates/**`、`src/**`、`docs/handoff/round4-plan.md`、`round4-review.md`、`round4-kernel-done.md`、`round4-shell-done.md`、`e2e/round3.spec.ts`（连真内核的写法照它）。

## 完成标准

- `E2E_PORT=1434 pnpm exec playwright test e2e/round4.spec.ts` 全过（`test.fixme` 的逐条在交接文件里说明）；`pnpm test`、`pnpm lint`、`pnpm typecheck` 通过；其余 e2e（`workbench`、`week1`、`round2`、`round3`）不因你的修改而失败。
- 测试启动的 devhost 一律 `ONEDESK_SECRET_STORE=memory`、数据目录为临时目录。

## 交付物

自己分支上的提交（不推送、不合并）；`docs/handoff/round4-tests-done.md` 追加“第二阶段”：覆盖了哪些、跑的结果（通过数/fixme 数）、发现的缺陷、没验证的。

## 共同规则

- 先读 `CLAUDE.md` 和本文件；其余按需读，不要整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 小步提交：`<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。
