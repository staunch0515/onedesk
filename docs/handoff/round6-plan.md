# 第六轮：外部程序、事件订阅，和前几轮验收留下的小项（协调会话定，2026-11-16）

依据：`dev-plan.md` 阶段 3 的剩余部分；`kernel-design.md` §6.3、§7.2、§7.4、§7.5（“外部程序”一段全文、`events`、插件自己的目录）、§13。沿用前五轮的全部约定和共同规则（`round4-plan.md`、`round5-plan.md`、`coordinator-handover.md` §3–§5）。决定 D331–D337 见 `docs/decisions.md`。
这一轮面向界面的协议几乎不变；新增的都是清单和宿主接口，名字在本文件里**定死**。确实缺字段时内核按“只增不改”加，并写进交接文件。

## 1. 做完是什么样

- 装一个声明了外部程序的插件（`e2e/fixtures/plugins/` 里的示例“命令”插件）：安装确认框单独一段写明“它会运行外部程序，这些程序可以访问这台电脑上你能访问的一切”，列出程序名字。新建一条“命令”，选程序、填参数，“运行”后结果区边跑边出输出，结束后显示退出码；运行中可以取消，它启动的子进程一起结束。没声明的程序、系统里找不到的程序被拒并说明缺哪个。
- 环境或工作区配置里设 `process.allow`（已知参数，允许名单）后，名单外的程序被拒；空名单 = 禁止一切外部程序。
- 示例插件订阅了“自己类型的资源变化”和“运行结束”：页面上显示“最近一次运行：退出码、时间”和“本类型资源数”，别的标签页里改了、跑了之后它自己更新。
- 小项：自动升级失败时插件页和插件树有提示；永久删除的确认框写明被引用数；引用面板显示字段的标签而不是 `body.text`。

## 2. 范围

**做**：宿主能力 `process`（`run`、`ready`）、`events`（`on`）；清单 `requires.programs`、`contributes.events`；权限项 `programs` 的单独确认；策略 `process.allow`；插件自己的目录 `plugin-data/<插件id>/`；审计；示例插件；§6 的三条小项。

**不做（之后）**：`transfer`；`plugins`（插件请求安装）与本地插件市场；依赖与导出点（§7.3）；`param_decls`；清单缓存；空闲回收；第一版旧库升级；`ai.policy`；用系统沙箱进一步约束外部程序（设计里列为评估项）；长驻的外部程序（本轮每次调用跑到结束）。

## 3. 清单（D331）

```jsonc
"requires": {
  "programs": [
    { "name": "echo", "source": "system" },
    { "name": "hello", "source": "plugin", "path": "bin/hello.sh" }   // 相对包的根；不许 ..、不许绝对路径、不许指向包外的链接
  ]
},
"contributes": { "events": ["resource.changed", "run.ended"] }
```

- `name`：`[A-Za-z0-9._-]{1,64}`，同一清单内唯一。`source: "system"` 时 `name` 就是可执行文件名，不许带 `path`；`source: "plugin"` 必须带 `path`。拒绝原因统一 `badPrograms`，`badEvents`（未知的事件名）。
- 系统程序只在固定位置找，按顺序：`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`、`/usr/local/bin`、`/opt/homebrew/bin`；不读 PATH。
- 插件自己的程序：先找 `plugin-data/<插件id>/bin/<name>`（插件运行时自己放进去的），再找包里的 `path`。包对工作进程只读；内核不给包里的文件加执行权限——不可执行就报 `notExecutable`。
- 权限：`PluginPermission.id = "programs"`，`detail` 是程序名列表（逗号分隔，插件自带的标 `(plugin)`）。它算“新增权限”，升级时多了程序名要重新确认（指纹包含程序清单）。

## 4. `ctx.host.process`（D332–D334）

- `run({ program, args?, env?, cwd?, stdin?, timeoutMs?, onOutput? })` → `{ code, signal?, stdout, stderr, truncated }`
  - 只能在**运行**里调用（动作的执行上下文）；渲染、`migrate`、事件处理、命令里调用 → `denied`（`reason: notInRun`）。
  - `program` 必须是清单声明的名字 → 否则 `denied/undeclaredProgram`；找不到可执行文件 → `notFound`（`what: program`，`params.program`）；不可执行 → `invalid/notExecutable`。
  - `args`：字符串数组，直接作为参数向量，**不经过 shell**；上限 256 个、合计 256 KB。
  - `env`：只有这里给的变量，加内核固定给的 `PATH`（§3 的系统目录加该插件两个 `bin` 目录）、`HOME`、`LANG`、`TMPDIR`（指向 `plugin-data/<插件id>/tmp`）。值里可写 `{{secret:名字}}`，由宿主代入，规则与网络相同（D318 的按资源范围）；代入过的值从输出、进度、摘要里抹掉。不继承工作进程的环境。
  - `cwd`：默认 `plugin-data/<插件id>/`；可以是它之内的子目录，或用户授权给该插件的文件夹之内；别处 → `denied/outsideGrant`。
  - `stdin`：文字，上限 8 MB；不给则关闭标准输入。
  - 输出：`stdout`、`stderr` 各自最多保留 8 MB（超出截断，`truncated: true`），按 UTF-8 宽松解码；`onOutput({ stream, text })` 边跑边回调（按行或每 100 ms 一批），回调里可以调 `ctx.progress`。
  - 超时：默认 60 秒，最长 600 秒；超时或运行被取消时结束整个进程组（先 SIGTERM，2 秒后 SIGKILL），调用以 `denied/cancelled` 或 `invalid/timeout` 结束。工作进程退出时不留孤儿（进程组 + 退出时清理）。
  - 退出码非 0 不是错误：照常返回 `code`。被信号结束时 `code: null`、`signal` 是信号名。
  - 同一次运行里可以先后或同时跑多个程序（同时最多 4 个）。
- `ready(program)` → `{ ready: boolean, reason?: "undeclaredProgram" | "notFound" | "notExecutable" | "blockedByPolicy" }`：任何上下文可调，纯查询，不记审计。
- 策略 `process.allow`（已知参数，`allowList`，层：config、env）：条目是程序名字。工作区配置和（有环境时）环境父链每一层定义了的名单都要包含这个名字；任何一层的名单是空的 = 这一层禁止一切外部程序；都没定义 = 不额外限制。被拒 → `denied/blockedByPolicy`（`params.layer`）。`protection.readonly` 生效时运行本来就被拒，无需另管。
- 审计：每次 `process.run` 一行（操作 `process.run`，对象是程序名，摘要含参数个数、退出码或信号、耗时；不记参数内容和环境变量）；同一次运行里对同一程序的重复调用合并计数（用第四轮的计数表）。被拒也记。
- 插件的外部程序不能调宿主接口（没有通道）；本轮不做任何系统级沙箱。

## 5. `ctx.host.events`（D335–D336）

- 清单 `contributes.events` 声明订阅哪些事件；代码里 `host.events.on(name, handler)` 注册（只能注册声明过的）。
- 事件：`resource.changed`——`{ id, kind, change: "created" | "updated" | "deleted" | "restored" | "purged" }`，只有**这个插件自己类型**的资源（依赖方的类型等 §7.3 做了再放开）；`run.ended`——`{ run, resource?, action, status }`，只有这个插件自己动作的运行。
- 投递：写入提交之后、异步、按顺序；处理函数以插件身份执行，能做的事与页面事件处理相同（读写自己的资源和存储，不能跑外部程序、不能发网络请求——那些只在运行里）；每次最长 5 秒，超时或抛错记日志和审计（`events.failed`），不影响触发它的写入。
- 防循环：由某个事件处理函数的写入引起的 `resource.changed` 不再投递给同一个插件。
- 停用的插件、未确认的版本不收事件；只读时处理函数里的写入被拒（处理函数照常被调用）。订阅了事件的插件在有事件时被激活（惰性激活的一个触发点）。
- 页面刷新：处理函数改了自己的存储后，界面怎么知道？内核在处理函数结束后对该插件发已有的 `plugin:<id>` 主题（没有就加，名字定死为 `plugin:<id>`），外壳收到后重新 `page.resolve` 该插件打开着的页面。

## 6. 小项

- 自动切换版本失败（`rescan` 或启动时 `migrate` 抛错、只读被拒）：`PluginDetail.switchFailure?: { version, reason, at }`（只增，名字定死；下一次成功切换或用户手动处理后清掉）；插件树节点的状态原因带上；外壳在插件页版本表上方显示提示，文字按 `reason`。
- 永久删除的确认框写明被引用数（外壳；`refs.incoming` 对已删除的目标也要能查——内核确认支持，不支持就补）。去掉 `e2e/round5.spec.ts` 里那条 `test.fixme`。
- 引用面板：`RefInfo` 按“只增”加 `fieldLabel?: Label`（类型字段声明里的标签，没有就不给）；外壳有标签显示标签，没有就不显示“位于…”。

## 7. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3–§6 的内核与工作进程部分 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改） |
| 外壳（Sonnet） | 安装确认框里“外部程序”的单独一段与警告文字；`process.allow` 进“添加参数”（来自 `params.known`，应当不用改代码，核对）；`plugin:<id>` 主题触发页面重新解析；结果区对流式输出的显示（运行中的进度文字/输出，核对现有 `run:<id>` 进度是否够用，不够就补）；§6 三条小项的界面；新增原因码与审计操作名的文字 | 同前几轮 |
| 插件与测试（Sonnet） | 第一阶段：`e2e/fixtures/plugins/com.example.command/0.1.0/`（类型 `command`：程序〔枚举：`echo`、`sleep`、`sh`、`hello`〕、参数〔每行一个〕；动作“运行”，流式输出，摘要含退出码与耗时；自带 `bin/hello.sh`；订阅两个事件并把“最近一次运行”“资源数”写进自己的存储，页面显示；vitest 用假 host）。第二阶段（合并后）：`e2e/round6.spec.ts` | 同前，另加 `e2e/fixtures/**` |

## 8. 完成标准

- 内核必须有的测试：清单 `programs`、`events` 的每种拒绝；未声明的程序、找不到、不可执行；不经过 shell（参数里的 `;`、`$()` 原样到达）；环境不继承（工作进程里设一个变量，子进程看不到）；`env` 里的密钥代入与输出抹除、未授权的密钥名被拒；`cwd` 的每种拒绝；输出截断；流式回调的顺序；超时；取消后子进程和孙进程都不在了（用 `sh -c 'sleep 100 & wait'` 验证）；并发上限；非运行上下文被拒；`process.allow` 各层交集、空名单、环境层；审计与合并计数；指纹随程序清单变化、升级多了程序要重新确认；`ready` 的四种原因。事件：只收到自己类型的、五种变化、`run.ended`、提交后才投递、处理函数里写入不引起自己的事件再投递、处理函数超时与抛错不影响写入、停用和未确认的不收、只读时写入被拒、惰性激活。小项各一条。全部用临时目录；外部程序只用系统自带的 `/bin/echo`、`/bin/sh`、`/bin/sleep`、`/bin/cat` 和测试里临时写的脚本。
- 外壳、测试：同前几轮（`pnpm typecheck`、`lint`、`test`、host 的测试与 clippy、假数据模式 `workbench.spec.ts` 全过且截图不变；`e2e/round6.spec.ts` 连真内核跑通）。
- 交接文件：`docs/handoff/round6-kernel-done.md`、`round6-shell-done.md`、`round6-tests-done.md`。内核的交接文件必须列全：新增的错误原因码、审计操作名、清单新增部分、宿主接口的确切签名、协议上“只增”加的字段。
