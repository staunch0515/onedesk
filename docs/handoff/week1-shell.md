# 任务：外壳（分支 `week1/shell`，Sonnet）

## 目标

让原型在真正的桌面窗口里跑起来，并接上真协议：`onedesk-host`（主进程逻辑，不依赖 Tauri）、`onedesk-devhost`（无界面，WebSocket）、`src-tauri`（Tauri 主进程）、界面的真协议客户端。**界面外观不得走样**：不改任何视觉；所有 CSS 只在 `src/design`，只用 token；`src/workbench` 里不写样式。

内核由另一个会话同时在写，你拿不到真的工作进程。所以：按 `week1-protocol.md` 写，并在 `crates/host/tests/` 里写一个**假工作进程**（一个测试用的小可执行文件或线程，按同样的命令行和线格式应答几条固定请求、可以按指令崩溃），用它测主进程库。合并后由协调会话用真的工作进程验收。

## 允许修改

`crates/host/**`、`src-tauri/**`（旧的第一版源码、`migrations/` 全部删除重写）、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只在桌面窗口里表现不对时才动，且只用 token）、`workbench.html`、`vite.config.ts`、`package.json`（依赖和 `tauri` 相关脚本）、`scripts/dev.sh`、`scripts/build-prototype.mjs`；自己的交接文件；`docs/handoff/todo.md`（只追加）。

## 只读依赖

`crates/protocol`、`src/workbench/protocol/generated/`（由 `pnpm gen:types` 生成，不手改）、`docs/handoff/week1-protocol.md`、`docs/handoff/stage0-ui-prototype.md`、`spikes/kernel-slice/crates/kernel/src/transport.rs`（Supervisor 的做法可以照抄）。

## 要做的（按优先顺序）

1. `onedesk-host`：`week1-protocol.md` §2 的主进程库——启动工作进程（短路径套接字）、`hello`、转发（填 `client`）、事件广播、崩溃后重启（在途请求 `workerGone`、新请求等待、间隔逐次加长、`connection` 事件）、退出时让工作进程收尾、复制内置插件、数据目录规则（D264）。工作进程可执行文件：与自身同目录的 `onedesk-worker`，`ONEDESK_WORKER_BIN` 覆盖。
2. `onedesk-devhost`（`crates/host/src/bin/`）：WebSocket，只听 127.0.0.1，令牌校验，就绪打印 `READY`。每条 WebSocket 连接一个 `client`（取自连接地址的 `client` 参数）。
3. `src-tauri`：只做窗口外皮——单实例、一个窗口、命令 `protocol_request`、事件 `protocol-event`、系统的选择文件夹对话框（给 `pick-folder` 效果用）。不打开任何数据库，不含业务逻辑。入口改为 `workbench.html`（或把它改名为 `index.html`，自行决定）。`pnpm start` 要能一条命令启动（先构建 `onedesk-worker`）。删除不再需要的旧依赖（keyring、rusqlite、tauri-plugin-http 等）和旧的 `capabilities` 项。
4. 界面的真协议客户端（`src/workbench/protocol/real/`）：传输层两种（Tauri、WebSocket），`hello` 版本核对，事件按主题分发，`connection` 的 `restored` 之后整体刷新。
5. 协议对齐：`src/workbench/protocol/types.ts` 里与生成类型重叠的类型改为从 `generated` 再导出（`TreeNode`、`TreeInfo`、`MenuCommand`、`Resource`、`PageDescriptor`、`ViewNode`、`ViewField`、`ActionDecl`、`CommandEffect`、`CommandContext`、`NewItem`、`Label` 等）；只有假数据用的类型（运行、环境、插件页、审计、搜索、`placeholder` 节点）留在 `types.ts` 并注明“演示，未进协议”。`ProtocolClient` 接口相应调整：`tree.children` 分批、`page.save` 取代 `resource.update/create`、增加 `resource.delete`、`plugin.grants/grantFolder/revokeFolder`、`tree.createGroup` 等按 `week1-protocol.md` §3。假实现跟着改到能通过类型检查和原有界面检查。
6. 混合客户端（D265）：有真内核时，`week1-protocol.md` §3 表里的方法走内核，其余走假实现；假实现提供的树、页面在界面上有“演示数据”标记（用已有的徽标组件，不新写样式）；假“资源”树改名“演示资源”，假“文件”树去掉；真的树排在前面。
7. 界面接新东西：新的 `CommandEffect`（`pick-folder`：桌面用系统对话框，浏览器模式用一个输入路径的对话框；`confirm`；`copy`）；树工具栏按 `TreeInfo.toolbar` 显示命令；内核的命令、树、类型、错误码的文字加进 `src/workbench/i18n/`（英、中）；`page.resolve` 出错时标签页里显示错误；保存冲突（`conflict`）给出提示。
8. 在 Tauri 窗口里实际看一遍原型（纯假数据模式即可）：编辑器（透明 textarea 叠着色文本）、日期控件、⌘W/⌘N/⌘1…9。发现的问题能修就修，修不了记入交接文件。

## 完成标准

- `cargo test -p onedesk-host` 全过（含：崩溃后自动重启且下一条请求成功、在途请求得到 `workerGone`、`connection` 事件、令牌不符被拒绝、内置插件被复制）；`cargo clippy -p onedesk-host -p onedesk --all-targets -- -D warnings` 无警告；`pnpm typecheck`、`pnpm lint`、`pnpm test` 通过。
- 纯假数据模式下 `E2E_PORT=1432 pnpm exec playwright test e2e/workbench.spec.ts` 仍然全过，截图与原来一致（外观基准；`e2e/` 不归你改，若某项检查因协议对齐必须改，写进交接文件由协调会话处理）。
- `pnpm tauri dev` 能开出窗口并显示原型（没有真工作进程时可以显示连接错误或退回假数据，如实写明你看到了什么）。

## 交付物

分支 `week1/shell` 上的提交；交接文件 `docs/handoff/week1-shell-done.md`。

## 共同规则

- 先读：`CLAUDE.md`、`docs/redesign/week1-slice.md`、`docs/handoff/week1-protocol.md`（协议与约定，必须逐条遵守）、本文件。按需读 `docs/redesign/kernel-design.md` 的相关小节。
- 只改“允许修改”里的文件；范围外的问题追加到 `docs/handoff/todo.md` 的末尾（只追加）。不清楚的地方自行按内核设计决定，并写进交接文件的“我做的决定”，不要停下来问。
- 改完就编译、就跑对应测试；`cargo clippy -p <你的包> --all-targets -- -D warnings` 无警告。测试只用临时目录，绝不碰 `~/Library/Application Support/onedesk*`。
- 小步提交到自己的分支，提交信息 `<范围>: <做了什么>` + 空行 + 为什么。不推送、不合并。
- 省额度：不做范围外的事；不重读已读过的大文件；长时间的构建放后台。
- 结束时写交接文件 `docs/handoff/<分支名把/换成->.md`（模板见 `docs/handoff/README.md`，另加“我做的决定”“新依赖”“协议变更”三节），如实写出没做、没验证的地方。
