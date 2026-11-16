# 任务：第七轮——插件与测试，第一阶段（Sonnet）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。内核和外壳会话同时在写；这一阶段你只做不依赖它们的部分。第二阶段（`e2e/round7.spec.ts` 连真内核）等合并后由协调会话另行通知，**这一阶段不要写**。

## 目标
1. 内置插件 `plugins/org.onedesk.market/`（`round7-plan.md` §6；清单格式 §3，宿主接口 §5，名字已定死；写法照现有内置插件，如 `plugins/org.onedesk.http/`、`plugins/org.onedesk.files/`）：清单（`requires.files: true`、`requires.plugins.install: true`）、`main.js`、英中语言文件、vitest（假 host：没授权文件夹时的页面、扫描两种目录布局、清单读不了的包、状态“未安装 / 已安装 / 可更新”、点安装后按四种结果刷新与提示、200 个上限）。页面只用视图树，不含 CSS/TSX。
2. 笔记插件 `plugins/org.onedesk.note/manifest.json` 加顶层 `exports`：`{ "kinds": [ { "id": "note", "actions": true, "read": true } ] }`，补 vitest 断言。
3. `e2e/fixtures/plugins/com.example.note-tools/0.1.0/`：`depends` 笔记插件（`>=0.1.0`）；动作 `count`（`kinds: ["org.onedesk.note:note"]`，输出文字：字数与行数，读 `ctx` 里的资源正文）；动作 `stamp`（试图用 `ctx.host.resources.update` 改这条笔记——用来验证被拒，宿主错误原样抛出）；语言文件英、中；vitest（假 host）。
4. `e2e/fixtures/market/`：一个放着三个包的文件夹——`com.example.hello/0.1.0/`（正常的小插件：一个类型、一个页面，不要任何权限）、`broken/`（清单有未知字段）、`org.onedesk.note/<与内置相同的版本>/`（内置笔记的清单副本，用来显示“已安装”）。

## 允许修改
`plugins/**`、`e2e/fixtures/**`、`scripts/check-*.mjs`；`docs/handoff/round7-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round7-plan.md`、`crates/**`、`src/**`、`e2e/fixtures/plugins/com.example.command/**`（夹具的写法照它）。

## 完成标准
`pnpm test`、`pnpm lint`（含“内核里不得出现插件名字”的架构检查和内置插件的检查）、`pnpm typecheck` 通过；写完 JSON 立即 `python3 -m json.tool` 校验。

## 交付物
自己分支上的提交（不推送、不合并）；`docs/handoff/round7-tests-done.md`：做了什么、测试结果、我做的假设（合并后要对着真内核核对的）、没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round7-plan.md`、本文件；其余按需读。只改“允许修改”里的文件；不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：做完就停。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
