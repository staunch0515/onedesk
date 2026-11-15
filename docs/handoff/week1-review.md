# 本周合并前审查（独立审查，只看代码与设计）

审查对象：`git diff e02ab2d e027ac9`。处理人写在每条后面。

| # | 级别 | 位置 | 问题 | 处理 |
|---|---|---|---|---|
| 1 | 必须修 | `plugins/org.onedesk.files/main.js:104-108` / `crates/kernel/src/pages.rs:72-78` | 文件插件返回的面包屑每项带 `tree`，内核的 `PluginCrumb` 只认 `label`、`key`（严格校验）→ 任何文件页都打不开（`pluginError/badOutput`） | 插件会话：去掉 `tree`（协议 §7 写的就是 `{label, key?}`） |
| 2 | 应该修 | `crates/kernel/src/sandbox.rs:507-510`、`host.rs:199-209` | 调用超时或取消时，`writeText` 的写盘照样完成，但之后的审计不再执行 → 文件改了、审计里没有 | 内核会话：写盘与审计放进一个不可取消的任务 |
| 3 | 应该修 | `crates/kernel/src/host.rs:55-70,132,142,153,172-174`、`files.rs:49-53` | 插件越权的 `resources`/`files` 调用被拒绝时不写审计（§4.3：被拒绝的命令单独写审计） | 内核会话 |
| 4 | 应该修 | `crates/kernel/src/commands.rs:91-93` | 插件命令返回的效果原样交给界面：可返回 `pick-folder{plugin: 别人}` 诱导授权；`open` 的目标未校验 | 内核会话：插件命令的效果只允许 `open`（目标合法）、`toast`、`reveal`、`rename`、`close-target`、`copy`、`reload`；`pick-folder`、`confirm` 一律拒绝（`pluginError/badOutput`） |
| 5 | 应该修 | `crates/host/src/bin/onedesk-devhost.rs:16`、`ws.rs:40` | 空令牌能启动且任何带 `?token=` 的连接都通过；服务端不做 URL 解码而前端做了编码 | 外壳会话：空令牌拒绝启动；比较前解码 |
| 6 | 以后 | `crates/kernel/src/commands.rs:103-129` | 授权文件夹是“读-改-写”，并发时可能丢一次授权或建出两行状态节点 | 内核会话顺手修（写线程里一个事务内完成）；来不及则记 todo |
| 7 | 以后 | `crates/kernel/src/files.rs:146-169` | 解析之后、改名之前目录被外部进程换成符号链接，写入可能落到范围外 | 记 todo（需要 `openat` + `O_NOFOLLOW`） |
| 8 | 以后 | `crates/kernel/src/pages.rs:379-381` | `page.save` 对 `node:` 目标没检查树是提供树 | 内核会话顺手修 |

已核对未发现问题：内核与主进程没有混入插件名或特判；`src/workbench` 无 CSS、无内联样式、无写死的颜色像素，`src/design` 未改，`plugins/` 无 CSS/TSX；`files` 五个方法的声明检查与路径判断（`..`、外向符号链接、同名前缀、新建文件的父目录、临时文件位置）；`resources` 只限自己的类型且进不了隐藏树；写入只有一个入口、审计与数据同事务、审计表触发器；沙箱全局、模块加载、`activate` 的 `host`、超时后拒绝宿主调用；`grantFolder` 与 `ui.open` 的参数校验；devhost 只听 127.0.0.1、Tauri 命令只转发、`capabilities` 只有 `core:default`。
