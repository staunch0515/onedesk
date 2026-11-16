# 任务：第六轮——插件与测试，第一阶段（Sonnet）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。内核和外壳会话同时在写；这一阶段你只做不依赖它们的部分。第二阶段（`e2e/round6.spec.ts` 连真内核）等合并后由协调会话另行通知，**这一阶段不要写**。

## 目标
`e2e/fixtures/plugins/com.example.command/0.1.0/`（示例“命令”插件，清单格式与宿主接口见 `round6-plan.md` §3–§5，名字已定死）：
- 清单：`requires.programs` 声明系统的 `echo`、`sleep`、`sh` 和自带的 `hello`（`bin/hello.sh`，一个打印参数和一个环境变量的小脚本，提交时带可执行位）；`contributes.events: ["resource.changed", "run.ended"]`；类型 `command`（body：`program`〔枚举〕、`args`〔长文本，每行一个参数〕、`env`〔长文本，每行 `名=值`，声明 `secrets: true`〕）；动作 `run`（输出文字）；页面 `editor`；语言文件英、中。
- 动作：`host.process.run({ program, args, env, onOutput })`，`onOutput` 里把输出经 `ctx.progress` 送出；输出文字 = stdout（stderr 接在后面并标出）；摘要 `exit <code> · <耗时> ms`（被信号结束写信号名）；宿主错误原样抛出（保留 `code`/`params`）。
- 事件：`run.ended` 时把 `{ status, at }` 写进存储键 `lastRun`；`resource.changed` 时把自己类型的资源数写进 `count`（用宿主的列出接口）；页面顶部显示这两项。
- vitest（假 host，放在 `plugins/_testing/` 现有的夹具测试旁）：参数按行拆分、环境按行解析、摘要、错误透传、事件处理函数写存储。
- 另备一个清单有错的包 `e2e/fixtures/plugins/bad-programs/`（`source: "system"` 却带 `path`）。

## 允许修改
`plugins/_testing/**`、`e2e/fixtures/**`、`scripts/check-*.mjs`；`docs/handoff/round6-tests-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`docs/handoff/round6-plan.md`、`e2e/fixtures/plugins/org.onedesk.sample/**`（清单与代码的写法照它）、`plugins/**`、`crates/**`、`src/**`。

## 完成标准
`pnpm test`、`pnpm lint`、`pnpm typecheck` 通过；写完 JSON 立即 `python3 -m json.tool` 校验。

## 交付物
自己分支上的提交（不推送、不合并）；`docs/handoff/round6-tests-done.md`：做了什么、测试结果、我做的假设（合并后要对着真内核核对的）、没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round6-plan.md`、本文件；其余按需读。只改“允许修改”里的文件；不清楚的自行决定并写进交接文件，不要停下来问。
- 绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：这一阶段不大，做完就停。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
