# claude/week1-shell-74b52c：外壳（主进程库、devhost、Tauri 外皮、真协议客户端）

## 完成了什么
- `crates/host`（`onedesk-host`）：`Host::start/request/events/shutdown`；启动工作进程（短路径套接字）、`hello`、转发（填 `client`）、事件广播、崩溃重启（间隔 100ms×2^n 封顶 6.4s；在途 `workerGone`、新请求最多等 20 秒）、`connection` 事件、退出时关闭连接并给 3 秒收尾再杀、复制内置插件、数据目录规则（D264）。`ws` 模块 + `onedesk-devhost` 可执行文件（127.0.0.1、令牌、`client` 参数、就绪打印 `READY`）。
- `src-tauri`：重写为窗口外皮（单实例、`protocol_request`、`protocol-event`、`pick_folder`）。旧源码、迁移、旧依赖（rusqlite、keyring、http/opener/clipboard 插件）全删。启动失败时窗口照开，界面退回演示数据并提示。
- `src/workbench/protocol/real/`：Tauri 与 WebSocket 传输、事件总线、`hello` 版本核对、`connection restored` 后所有订阅者重读。`mixed-client.ts`：本周方法走内核，其余走演示；演示“资源”树改名 `demo:resources`（“演示资源”），假“文件”树去掉；真树在前。
- 协议对齐：`types.ts` 从 generated 再导出，演示专用类型已注明；`ProtocolClient` 改为 `tree.children` 分批（`loadChildren` 读全）、`page.save`、`resource.delete`、`plugin.grants/grantFolder/revokeFolder`、`workspace.info`。
- 界面：`pick-folder`（桌面系统对话框；浏览器输入路径对话框）、`confirm`、`copy`；树工具栏按 `TreeInfo.toolbar`；内核 id 与错误码的中英文字（`i18n/kernel-texts.ts`）；`page.resolve` 出错在标签页显示错误；`conflict` 有专门提示；演示数据徽标（树标题、页面标题、状态栏）。

## 测试与检查
- `cargo test -p onedesk-host`：9 项集成 + 2 项单元，全过。`cargo clippy -p onedesk-host -p onedesk --all-targets -- -D warnings`：无警告。
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过（新增 real-client、mixed-client、kernel-texts 测试）。
- 纯假数据 `e2e/workbench.spec.ts`：全量跑 21 过、2 失败（深色 SQL 页、树悬停）——失败时机器负载约 470 且我正在改文件触发热更新；单独重跑这两项连同浅色 SQL 页全过。截图已 `git checkout` 还原（未提交）。注意：原 `playwright.config.ts` 的 `webServer.url` 指向根路径，Vite 返回 404 会超时，我用临时配置（指向 `/workbench.html`）跑的；插件会话分支已改。

## 我做的决定
- `client` = Tauri 窗口标签 / WebSocket 的 `client` 参数（缺省 `ws-<n>`；浏览器用 sessionStorage 里的随机 id）。
- 主进程自己回答界面的 `hello`（用缓存的工作进程 hello），版本不符返回 `versionMismatch`。
- 资源/页面归属：先问内核，找不到再归演示，并缓存；演示树发出的 `new:` 目标加 `demo=1` 标记。
- UI 的 `CommandContext/PageContext` 保留 `null`/宽松 JSON（超集），真客户端发送前去掉 null。
- `EventHandler` 增加可选 `payload`；`ui` 事件载荷就是 `CommandEffect`（外壳尚未订阅 `ui` 主题执行，见下）。
- 内置插件目录：开发构建用仓库 `plugins/`，发布构建用 `Resources/plugins`，`ONEDESK_BUILTIN_PLUGINS` 覆盖。

## 新依赖
- Rust：`onedesk-host` 用工作区已有的 tokio、tokio-tungstenite、futures-util、serde(_json)、tempfile（dev）；`onedesk` 用 tauri 2、tauri-plugin-single-instance、tauri-plugin-dialog（均 MIT/Apache-2.0）。
- JS：删除 `@tauri-apps/plugin-{clipboard-manager,dialog,http,opener}`；无新增。

## 协议变更
无。建议：`TreeNode.parentKey` 内核省略而非 null（已按此适配）。

## 没做或没验证
- **没有对接真内核**：工作进程仍是占位，所有对内核的调用只在假工作进程和假内核下测过。合并后需用真 worker 跑 devhost + 界面验收。
- `ui` 主题事件（插件 `host.ui.open/notify/copy`）外壳还没订阅执行。
- 发布构建（`index.html` 入口、打包 worker 与插件）没做，见 todo.md。
- `pnpm check` 全量、`cargo test --workspace` 没跑（其他 crate 不归我）。
- ⌘W/⌘N/⌘1…9、编辑器、日期控件在 WKWebView 中的表现：见下节。

## Tauri 窗口
`pnpm tauri dev`（首次编译 12 分钟，机器负载很高）开出了窗口。工作进程仍是占位（立刻退出码 0），所以主进程报 `cannot start the workspace worker`、窗口照开，界面退回纯演示数据。我用 `screencapture` 看到的（第一次截图是空白，约 20 秒后才加载完，那时负载高）：
- 原型整体渲染正常，布局与 Chromium 里一致：顶部栏、活动栏、资源树、标签栏、信息面板、参数条、SQL 编辑器（透明 textarea 叠着色文本，行号与着色对得上，没有错位）、结果区。
- 日期时间控件显示为 `11/15/2026, 12:30 P`，右侧被截断（原生控件在 WKWebView 里比 Chromium 宽）——**未修**，需要时调 `src/design` 里该字段的宽度 token。
- 没有看到启动失败的提示条（截图时可能已消失，或没出现）——**未确认**。
- ⌘W/⌘N/⌘1…9 没有试（我没有办法向窗口发键盘事件）。

## 审查后的修改
- 已合并 `claude/week1-slice-3b4ae5`（无冲突）。
- 审查 #5：`onedesk-devhost` 空令牌退出码 2；`ws.rs` 比较前对地址里的 `token`/`client` 做 `%XX`/`+` 解码，且 `serve` 遇到空令牌拒绝所有连接。新增测试：解码单元测试、编码令牌通过且空令牌被拒的集成测试、devhost 空令牌拒绝启动。
- `ui` 主题事件：`WorkbenchProvider` 订阅 `ui`，载荷当作 `CommandEffect` 执行（`actions.runEffects`）。主进程已只把带 `client` 的事件发给对应窗口/WebSocket；WebSocket 传输里还补了一道 `client` 不符就丢弃。没有对真插件跑过（`open` 新标签页、`notify`、`copy` 只靠既有的效果处理）。
- `src-tauri/src` 只剩 `lib.rs`、`main.rs`，旧文件已无。
- 为通过 `pnpm lint` 把我测试里的插件相关词（`note`）改成 `alpha`。**`pnpm lint` 仍失败（25 条），全部在 `crates/kernel/**`（如 `tests/pipeline.rs` 出现 "sql"），不是外壳文件**，由内核会话/协调会话处理。
- 通过：`cargo test -p onedesk-host`（3+11）、clippy（`onedesk-host`、`onedesk`）、`pnpm typecheck`、`pnpm test`（87）。

## 验收后的修改
- 已合并 `claude/week1-slice-3b4ae5`（e638f90 起），无冲突。
- 保存（#1、#2）：保存逻辑抽到 `state/save.ts`（`saveTab`）。任何目标都走 `page.save`；`resource:`/`node:` 带标签页当前的 `basis`（`PageHost` 每次解析后写进 `TabState.basis`），`new:` 不带。成功后清掉已保存的草稿（保存期间新输入的保留）、用返回页面的 `basis` 更新标签页、`TabState.reload` 加一让页面重新解析。`conflict` 抛出后草稿和旧 basis 不变，提示用 `kernel-texts` 里已有的文字。
- 授权文件夹对话框：回车等于“授权”。
- 提供树（`groups` 为 false）不显示“新建分组”按钮。
- locale（#5）：`page.resolve`/`page.save` 的 context 已带当前语言；`command.execute` 没有——`CommandContext` 协议类型里没有 locale 字段，内核 `commands.rs` 给命令处理函数的 ctx 里 `locale` 写死为 `null`。笔记“创建副本”的中文界面显示英文后缀就是这个原因，需要内核/协议加字段（外壳再带上），我没改。
- 测试：`state/save.test.ts`（4 项）、混合客户端 `node:` 保存走内核（1 项）。`pnpm typecheck`、`pnpm lint`、`pnpm test`（92）通过；纯假数据 `e2e/workbench.spec.ts` 23 过 1 跳过（原来就跳过），截图已还原。未用真内核（devhost）实跑这几处。

## 收尾
- 已合并 `claude/week1-slice-3b4ae5`（d7169ae）。`command.execute` 现在带当前界面语言（`createKernelClient` 的 locale 回调，调用方给的 `locale` 优先）；测试在 `real-client.test.ts`。
- 发布构建：`scripts/prepare-bundle.sh [release|debug]` 构建 `onedesk-worker` 并复制为 `src-tauri/binaries/onedesk-worker-<三元组>`（`externalBin` sidecar），把 `plugins/<id>/`（不含 `_*` 目录、`*.test.*`）放到 `target/bundle-inputs/plugins`（`resources` → `Resources/plugins`）。`beforeBuildCommand`/`beforeDevCommand` 都先跑它。`src-tauri/build.rs` 在缺文件时放空占位，所以不跑脚本也能 `cargo clippy/test --workspace`（占位已 git 忽略）。入口：新增根目录 `index.html`（立刻跳到 `workbench.html`），vite 构建入口含两者；`workbench.html` 地址不变，`pnpm start` 与 e2e 照旧。只打 `app` 目标。CSP 未放宽。
- `pnpm tauri build` 成功（release 约 8 分钟），产出 18.3 MiB 的 `OneDesk.app`：`Contents/MacOS/{onedesk,onedesk-worker}`，`Contents/Resources/plugins/{org.onedesk.files,org.onedesk.note}`（无测试文件）。
- **没能按要求从 `.app` 启动验证**：在我的会话环境里，从命令行（直接执行、`open -n`、复制到别处再执行）启动 `.app` 内的可执行文件，进程会卡在 AppKit 的 `-[NSApplication finishLaunching]`（`_NSPersistentUIEstablishTalagentCommunication`，`sample` 看到的），等了几分钟也没进入 `setup`，数据目录始终是空的。这像是该环境无法给 `.app` 做正常的图形启动，不是应用逻辑问题，但我没能证明。请在你们的桌面会话里再按“`ONEDESK_DATA_DIR=<临时目录> OneDesk.app/Contents/MacOS/OneDesk`”验证一次。
- 替代验证（做了的）：把 `.app` 里的 `MacOS/` 和 `Resources/` 原样复制成没有 `Info.plist` 的 `Contents/` 目录结构（不是 .app 包，AppKit 不会走包启动路径），用 `ONEDESK_DATA_DIR=<临时目录>` 运行其中的 `onedesk`：主进程在、`onedesk-worker`（sidecar，由 `resolve_worker_bin` 在同目录找到）在，临时目录出现 `plugins/org.onedesk.files`、`plugins/org.onedesk.note`（由 `Resources/plugins` 复制，说明内置插件目录按包内位置找到了）、`workspaces/default/workspace.db`，`ui_state` 里有 `main|layout`（窗口里的界面经 Tauri 连上了内核）。随后结束了进程。这证明路径解析、sidecar、插件复制和界面连内核都对，但不证明 `.app` 本身在图形环境里能正常打开；窗口内容我没有再看。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（93）、`cargo clippy -p onedesk-host -p onedesk --all-targets -- -D warnings` 通过。纯假数据 e2e 这次没重跑（只改了入口与构建配置，改动不涉及界面代码）。
