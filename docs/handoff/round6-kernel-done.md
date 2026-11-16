# 第六轮内核：完成记录

分支 `claude/r6-kernel-e6782f`（从协调分支切出，未推送、未合并）。范围：`round6-plan.md` §3–§6 的内核与工作进程部分。

## 完成了什么

- **清单（§3，D331、D335）**：`requires.programs` 改为对象数组；`contributes.events`；字段声明可带 `label`。
- **`ctx.host.process`（§4，D332–D334）**：`run`、`ready`；不经过 shell、不继承环境、进程组取消（SIGTERM，2 秒后 SIGKILL）、超时、输出截断、流式回调、密钥代入与抹除、`cwd` 限制、同一运行最多 4 个、`process.allow` 策略、审计与合并计数、`plugin-data/<插件id>/`（按需建 `bin/`、`tmp/`）。新文件 `crates/kernel/src/process.rs`。
- **`host.events`（§5，D335–D336）**：`resource.changed`、`run.ended`；提交后异步、每个插件一条有序队列；处理函数 5 秒上限；失败记 `events.failed`；防循环；停用/未确认不收；惰性激活；处理函数结束后发 `plugin:<id>`。新文件 `crates/kernel/src/events.rs`。
- **小项（§6，D337）**：`PluginDetail.switchFailure`；插件树节点 `stateReason: "switchFailed"`；`RefInfo.fieldLabel`；`refs.incoming` 对已删除目标本来就可查（`visible_row` 用 `get_any`），补了测试。
- **顺带修的引擎问题（sandbox.rs）**：rquickjs 的调度器只记住最后一个轮询它的 waker。一个短调用（如页面渲染）轮询过运行时后结束，其他调用里还在等的 future（定时器、数据库回复）被唤醒时唤醒的是那个已结束的任务，于是永远不再被轮询。事件处理函数与渲染并发时必现（处理函数 `util.sleep` 之后的宿主调用卡到超时）。修法：每次 `call_with` 结束和激活完成后，往运行时推一个空任务（`ctx.spawn(async {})`），让运行时自己的驱动任务重新登记为 waker（`Sandbox::rearm`）。前几轮应该也偶发，只是并发调用同一插件少见。

## 测试结果（本会话实际运行）

见文末“运行结果”。新增：`crates/kernel/tests/round6.rs`（20 个）、`manifest.rs` 单元测试 1 个（`program_and_event_declarations_and_their_rejections`）；`round5.rs` 的 `params.known` 断言加了 `process.allow` 一行。

§8 要求与测试的对应：

| 要求 | 测试 |
|---|---|
| 清单 `programs`、`events` 的每种拒绝；指纹随程序清单变化 | `manifest::program_and_event_declarations_and_their_rejections` |
| 未声明、找不到、不可执行；插件自带程序（包里、`plugin-data/bin` 优先）；非 0 退出码；信号；stdin | `declared_found_and_executable_programs_only` |
| 不经过 shell（`;`、`$()`、反引号、`*`、`&&` 原样到达）；环境不继承（测试进程里设变量，子进程看不到）；固定的四个变量 | `no_shell_and_no_inherited_environment` |
| `env` 密钥代入、输出/流式/进度/摘要抹除、未授权的密钥名被拒 | `secrets_in_the_environment_are_substituted_and_scrubbed` |
| `cwd` 的每种拒绝（`..`、绝对路径、工作区、兄弟插件目录、指向外面的链接）、子目录、不存在、授权文件夹 | `working_folder_is_the_plugins_own_or_a_granted_one` |
| 输出截断（9 MB → 8 MB、`truncated`）；流式回调顺序、运行中进度 | `output_is_truncated_and_streamed_in_order` |
| 超时；取消后子进程和孙进程都不在（`sh -c 'sleep 100 & wait'`）；正常退出后留下的后台进程也被结束 | `timeouts_and_cancellation_end_the_whole_process_group` |
| 并发上限；非运行上下文被拒；`ready` 在命令里可用 | `at_most_four_programs_at_once_and_only_inside_a_run` |
| `ready` 的四种原因；不记审计 | `ready_tells_the_four_reasons` |
| `process.allow` 各层交集、环境层（含继承）、空名单、`layer` 参数、环境页 `restricted` | `process_allow_layers_intersect` |
| 审计与合并计数、不记参数内容、被拒也记 | `every_run_is_audited_and_repeats_are_counted` |
| 升级多了程序要重新确认（未确认、指纹不同、仍用旧版） | `more_programs_in_a_new_version_need_a_new_confirmation` |
| 工作进程退出不留子进程 | `shutting_down_ends_running_programs` |
| 只收自己类型的、五种变化、提交后才投递（处理函数看到新资源）、按顺序 | `resource_changes_of_its_own_kinds_in_order_after_commit` |
| `run.ended`（无资源、有资源）、别的插件收不到 | `run_ended_reaches_the_plugin_of_the_action` |
| 处理函数里的写入不再投递给自己；处理函数里外部程序、网络被拒 | `a_handlers_own_writes_are_not_delivered_back_and_programs_are_refused_there` |
| 处理函数抛错、超时不影响写入；之后插件照常工作 | `failing_or_slow_handlers_do_not_affect_the_write` |
| 停用的不收（重新启用后不补发）；未确认的新版本不收（已确认的旧版本照收）；只读时处理函数被调用、写入被拒 | `disabled_and_unconfirmed_get_nothing_and_readonly_refuses_handler_writes` |
| 惰性激活、`plugin:<id>` 主题 | `an_event_activates_a_subscribed_plugin_and_announces_its_page` |
| `switchFailure` 记录、树节点原因、用户处理后清掉 | `a_failed_automatic_switch_is_recorded_until_resolved` |
| `fieldLabel`（有标签给、没有不给）；已删除目标的 `refs.incoming` | `references_carry_the_field_label_and_deleted_targets_list_theirs` |

外部程序只用 `/bin/echo`、`/bin/sh`、`/bin/sleep`、`/bin/cat` 和测试临时写的脚本（`sh -c` 里用到了系统的 `head`、`tr`、`wc`、`env`、`pwd`、`kill`）。每个跑程序的测试结尾检查 `Kernel::live_programs() == 0`。

## 清单新增部分

```jsonc
"requires": {
  "programs": [
    { "name": "echo", "source": "system" },                         // 不许带 path
    { "name": "hello", "source": "plugin", "path": "bin/hello.sh" } // 必须带 path
  ]
},
"contributes": {
  "events": ["resource.changed", "run.ended"],
  "kinds": [{ "fields": { "text": { "type": "longtext", "refs": true, "label": "field.text" } } }]
}
```

- `name`：`[A-Za-z0-9._-]{1,64}`（另拒 `.`、`..`），清单内唯一。
- `path`：相对包根，只许普通路径段（无 `..`、非绝对、非空）；文件存在时跟随链接后必须仍在包内。**文件不存在不拒**（运行时报 `notFound`），因为插件可以运行时往 `plugin-data/<id>/bin/` 放。
- `source` 只认 `system` / `plugin`。
- 新拒绝原因：**`badPrograms`**（以上任一违规，`detail` 为 `<name>: <原因>`）、**`badEvents`**（未知事件名或重复）。
- 字段 `label`：语言键（或文字），用插件语言文件翻译；用于 `RefInfo.fieldLabel`。
- 权限：`PluginPermission.id = "programs"`，`detail` 例 `echo, hello (plugin)`（按原子排序）。原子 `programs:<name>`、`programs:<name> (plugin)` 进指纹。

## 宿主接口的确切签名

```ts
// 只在运行（动作的执行）里；别处 → denied/notInRun
ctx.host.process.run(opts: {
  program: string;              // 清单声明的名字
  args?: string[];              // ≤256 个、合计 ≤256 KB、不含 NUL
  env?: Record<string, string>; // 值可含 {{secret:名字}}；名字非空、不含 = 和 NUL
  cwd?: string;                 // 绝对路径，或相对 plugin-data/<id>/
  stdin?: string;               // ≤8 MB；不给则标准输入为 /dev/null
  timeoutMs?: number;           // 默认 60000，夹在 1..600000
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void | Promise<void>;
}): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean }>;

// 任何上下文（含 migrate、事件处理、渲染），纯查询，不记审计
ctx.host.process.ready(program: string): Promise<{ ready: true } | { ready: false; reason: "undeclaredProgram" | "notFound" | "notExecutable" | "blockedByPolicy" }>;

// 注册（activate 收到的 host 上；ctx.host.events.on 是同一个函数）；只能注册清单声明过的，否则同步抛 code = "denied"
host.events.on(name: "resource.changed" | "run.ended", handler: (ctx, payload) => unknown): void;
// resource.changed: { id, kind, change: "created" | "updated" | "deleted" | "restored" | "purged" }
// run.ended:        { run, action, status, resource? }   action 是短名（不带插件前缀）；status 是 success / error / cancelled；无资源时没有 resource 键
// 处理函数的 ctx 有 ctx.event（事件名）、ctx.host、ctx.t；没有 resource、envId
```

- `signal`：被信号结束时 `code: null`、`signal: "SIGTERM"` 之类（常见信号有名字，其他 `SIG<n>`）；正常退出时 `signal: null`（不是缺省）。
- `onOutput`：按整行交出，不满一行的每 100 ms 交一次（在 UTF-8 字符边界切）；stdout/stderr 按到达顺序；每路最多交 8 MB。`run` 的结果在所有块都交给 `onOutput` 之后才返回。`onOutput` 抛错：结束该程序（进程组），`run` 以该错误结束。
- 内部宿主方法（只给沙箱引导代码用，插件代码直接调也只能在运行里）：`process.output(streamId)`（长轮询，返回块数组，流关闭后返回 `null`）、`process.stop(streamId)`。
- 固定环境变量（**覆盖**插件给的同名变量）：`PATH` = 六个系统目录 + `plugin-data/<id>/bin` + 包里第一个插件程序所在目录；`HOME` = 工作进程的 `HOME`（没有则 `plugin-data/<id>`）；`LANG=en_US.UTF-8`；`TMPDIR` = `plugin-data/<id>/tmp`。

## 协议上“只增”加的字段

- `PluginDetail.switchFailure?: SwitchFailure`（新类型 `SwitchFailure { version, reason, at }`，`at` 为毫秒）。
- `RefInfo.fieldLabel?: Label`（没有标签时不出现）。
- 主题常量 `topic6::PLUGIN = "plugin:"`（Rust 侧；TS 不生成常量）。
- 已提交生成的 `PluginDetail.ts`、`RefInfo.ts`、`SwitchFailure.ts`、`index.ts`。

## 新增错误原因码（外壳据此配文字）

| 方法 | code | `params.reason` | 其他参数 |
|---|---|---|---|
| `process.run`（运行之外）、事件处理函数里的 `process.run` 和 `network.request` | `denied` | `notInRun` | |
| `process.run` | `denied` | `undeclaredProgram` | `program` |
| `process.run` | `notFound` | （`what: program`） | `program` |
| `process.run` | `invalid` | `notExecutable` | `program`；spawn 失败时有 `detail` |
| `process.run` | `denied` | `blockedByPolicy` | `program`、`layer`（配置节点或环境节点 id） |
| `process.run` | `invalid` | `badArgs`、`badEnv`、`tooLarge`（stdin）、`timeout`、`tooManyProcesses` | |
| `process.run`（`onOutput` 抛错后） | `denied` | `cancelled` | |
| `process.run` | `denied` | `outsideGrant` | |
| `process.run` | `notFound` | （`what: folder`，`cwd` 在允许范围内但不存在） | |
| `process.run` | `denied` | `secretNotAllowed`、`unknownSecret`（同网络） | |
| 插件树节点 `stateReason` | — | **`switchFailed`**（优先于 `unconfirmedVersion`） | |
| `SwitchFailure.reason` | — | 拒绝的 `reason`（`migrateFailed`、`readonly`、`grantField`、`notConfirmed`…），没有 reason 时为 code | |

运行被取消时调用直接随运行结束（运行状态 `cancelled`），插件拿不到 `denied/cancelled`（它的调用已被中止）。参数类型错（`program` 不是字符串等）是 `invalidParams`。

## 审计操作名

- **`process.run`**：对象是程序名字。成功（含非 0 退出码、被信号结束）：同一运行同一程序只一行，其余进 `audit_counts`（第四轮的计数表）；摘要 `{ args: 参数个数, ms: 耗时, code }` 或 `{ args, ms, signal }`；不记参数内容和环境变量。**任何失败**（被拒、找不到、不可执行、超时、并发上限、`cwd`）各写一行，`result = failed:<code>`。
- **`events.failed`**：对象是插件 id；`result = failed:<code>`（`pluginError`、`pluginTimeout`、宿主错误的 code 如 `denied`）；错误参数里带 `event`。

## 我做的决定（设计没写到或需要取舍的）

1. **流式回调的实现**：沙箱引导代码把 `onOutput` 拆成并行的两件事——`process.run` 宿主调用，和一个反复调 `process.output` 的取块循环；块由宿主按运行 id + 流 id 存放。没有新增宿主到 JS 的推送通道。
2. **程序正常退出后**：再等最多 500 ms 读完管道里的输出，然后对进程组发 SIGKILL，结束它留下的后台进程（“每次调用跑到结束、不留孤儿”）。若后台进程一直占着输出管道，结果在 500 ms 后照常返回。
3. **进程组**：每个程序 `setpgid(0,0)` 自成一组（不在工作进程的组里），这样取消能连孙进程一起结束；工作进程正常退出（`Kernel::shutdown`）时对所有活着的组发 SIGKILL。**工作进程被 SIGKILL 时程序不会被结束**（macOS 没有 `PR_SET_PDEATHSIG`），见“没做”。
4. **并发上限**：第 5 个直接拒绝（`invalid/tooManyProcesses`），不排队。
5. **固定的四个环境变量覆盖插件给的同名变量**；`HOME` 用真实的家目录（`ssh`、`git` 之类要用），`LANG` 固定 `en_US.UTF-8`。
6. **`cwd` 相对路径**从 `plugin-data/<id>/` 算；用真实路径（跟随链接）判断范围。授权文件夹只在插件声明了 `requires.files` 时算数。
7. **`process.allow`**：名字精确匹配（不支持通配）；配置节点（根优先）和环境父链里每个定义了的都要含这个名字；`layer` 报第一个不含它的那一层。环境页的 `restricted` 同样适用（本层的名字有上层没列的）。`params.known` 加了 `process.allow`（`list`、`allowList`、`["config","env"]`）。
8. **事件投递**：每个插件一个无界有序队列、一个任务；处理函数按插件内顺序执行，插件之间并行。投递前和执行时各查一次启用与确认。资源变化的种类按命令定：新建/导入新行 `created`（导入时已有行被更新为 `updated`）；改、参数、移动、历史恢复、升级接管、撤销升级 `updated`；删除 `deleted`；恢复删除 `restored`；永久删除 `purged`。只投给拥有该类型的插件（`<插件id>:<类型>` 且该类型在当前活动版本里存在）。一个命令改了多行（例如删除一个分组连同里面的资源）每行一个事件。
9. **`run.ended`** 在运行记录写好结束状态之后投递；内核拒绝的运行（未知动作，没有插件）不投。
10. **防循环**只看“写入是不是这个插件的事件处理函数做的”：处理函数的写入不再投给同一个插件，但照常投给别的插件（目前别的插件收不到别人的类型，所以实际上不投）。
11. **`plugin:<id>`** 在每个处理函数结束后都发（成功或失败），不判断它改没改存储。
12. **`switchFailure`** 存在插件状态节点的参数 `switchFailure`（JSON），只读下照样能写（插件状态在只读放行之列）。只记**自动**切换（启动、`rescan`、确认权限后、取消钉住后的 `auto_switch`）的失败；手动 `activateVersion` 失败照旧直接把错误返回给界面。清掉的时机：任何一次成功的版本切换（含手动）、`setPinned`（钉住或取消钉住）。
13. **`RefInfo.fieldLabel`** 用来源资源绑定版本的字段声明；没有绑定版本时用活动版本。
14. **事件处理函数里的网络请求**也拒绝（`denied/notInRun`），与外部程序一致（D336）。页面事件处理函数里的网络请求不变。
15. **`process.run` 的超时与动作的总时长**：动作仍受 D288 的 60 秒总时长约束（`KernelConfig.action_timeout`），所以超过它的 `timeoutMs` 实际被动作超时截断。没有改 D288，见“没做”。

## 新依赖

无（`libc` 已在内核依赖里；`tokio` 的 `process` 特性工作区已开）。

## 没做 / 没验证的

- **工作进程被强杀（SIGKILL）时，正在跑的外部程序不会结束**：它们自成进程组，不随工作进程消失。正常退出（主进程关连接）会清理。要彻底解决需要额外的看门进程或 kqueue 监视父进程，留给协调会话决定（已记 `todo.md`）。
- **动作 60 秒总时长 vs `timeoutMs` 最长 600 秒**：见决定 15，需协调会话决定是否让运行外部程序时延长动作时长（已记 `todo.md`）。
- 运行被取消（future 被丢弃）时，那一次 `process.run` **不写审计行**（运行本身有 `run.end` 审计）。
- 抹除按块做：一个密钥值恰好被切在两个流式块之间时，那两块各自不含完整值，不会被抹（最终的 `stdout`/`stderr` 是整体抹除的）。
- 进程组 id 复用：程序退出后对它的组发 SIGKILL 时，理论上该组 id 可能已被系统复用（极小概率）。
- 没有在真应用里手动验证；外壳、e2e 不在本会话范围，未运行。worker 层（`crates/worker/tests`）没有为外部程序加专门测试，靠内核的 `shutting_down_ends_running_programs`。
