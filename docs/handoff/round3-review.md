# 第三轮合并前审查（独立审查，只看代码与设计）

审查对象：`git diff 72a3c7c 8f86dc8`。行号以该提交为准。

| # | 级别 | 位置 | 问题 | 处理 |
|---|---|---|---|---|
| 1 | 应该修 | `crates/kernel/src/runs.rs:256-262` | 动作声明了 `kinds` 时必须有已存在的资源；在未保存的 `new:<类型>` 页面上点运行得到 `invalidInput` | 内核：没有资源时用 `new:` 目标里的类型判断是否适用 |
| 2 | 应该修 | `runs.rs:256,277` | 动作没写 `kinds` 时不检查资源归属：`run.start` 带插件 B 的动作和插件 A（或环境）的资源 id，B 的动作就拿到那条资源的完整内容，绕过 `host.resources` 的限制 | 内核：资源不属于该插件的类型 → `invalidInput`，不交给插件 |
| 3 | 应该修 | `pages.rs:523-575` | 停用插件后仍能 `page.save` 它的资源、经 `new:` 新建它的资源（与 D290 不符） | 内核：返回 `denied`（`reason: pluginDisabled`）；信息面板改名等同样被拒 |
| 4 | 应该修 | `runs.rs:494-500` | `page.event` 返回的 `changes` 不过滤：插件借一个事件就能改 `name`、`description`、`tags` 和任意 `body.*` | 内核：只保留本次 `render` 的视图里出现的绑定路径，其余丢弃 |
| 5 | 应该修 | `runs.rs:244,278,490`、`transport.rs:105` | `run.start` 的 `input`/`params`、`page.event`/`page.resolve` 的 `draft`、协议的一行都没有大小上限 | 内核：输入快照与 `draft` 序列化后上限 8 MB（超出 `invalidInput`/`invalidParams`）；协议一行上限 32 MB |
| 6 | 应该修 | `runs.rs:277,469` | 动作和结果页签的 `ctx` 没有 `locale` | 协议已加 `RunStartParams.locale`、`RunRenderParams.locale`（D293）；内核传给 `ctx.locale`；外壳发送 |
| 7 | 应该修 | `src/workbench/i18n/kernel-texts.ts:213-229` | 运行失败原因写的是 `badInput`，内核发的是 `invalidInput`；透传的 `denied`、`invalid` 等没有文字，状态栏和任务面板会显示空白原因 | 外壳：按内核实际发出的码补齐；没有文字时显示通用文字，不留空白 |
| 8 | 顺手 | `runs.rs:274,279` | 运行行写好之后用 `?` 返回协议错误，这条运行一直停在 `running` | 内核：改为以 `error` 结束运行 |
| 9 | 顺手 | `sandbox.rs:536` | 取消后宿主调用被拒的原因是 `callEnded`，计划写的是 `cancelled` | 内核：取消用 `cancelled`，超时用 `timeout`，其余仍为 `callEnded` |
| 11 | 顺手 | `host.rs`（storage）、`manifest.rs` | `storage` 不限键数和总量；`text` 设置值不限长度 | 内核：每个插件版本上限 1000 个键、总量 16 MB；设置值上限 4 KB |
| 13 | 顺手 | `pipeline.rs`（startup）、审计操作名 | 遗留运行改为 `interrupted` 时没写 `run.end` 审计；外壳的审计文字表缺 `run.start`、`run.end`、`plugin.state`，多了内核从不写的两个 | 内核补审计；外壳按内核实际写的操作名对齐 |
| 10 | 以后 | `sandbox.rs:545-548` | 宿主写调用已交给写线程后遇到取消：写入落库而插件收到被拒 | todo |
| 12 | 以后 | `runs.rs:544-551` | 停用与激活之间的窄竞态：运行环境可能被重新激活后留着 | todo |

已核对未发现问题：内核与主进程没有示例插件的名字、类型或 `:name` 语法，拒绝原因都是码；没有新增 CSS、内联样式、写死的数值，插件里没有 CSS/TSX；取消和超时后宿主调用被拒、`sleep` 立即醒来、迟到的结果不覆盖记录、进度节流、输出在写库前校验与截断、审计不含输入正文；`storage` 的隔离与写线程；设置和启用状态经写入管线、插件自己改不了；`params.get` 核对环境类型；停用插件对树、命令、新建、命令面板、`run.render`、宿主调用的拦截；只新增迁移，永久删除连带运行并清理文件残留；混合客户端的路由、执行前确认的时机、数值按类型发送；示例插件只用宿主接口。
