# 第十三轮独立审查（只读的 Opus 子代理，2026-11-18；第四个协调会话整理并分派）

范围：`git diff 89e468a HEAD`（多工作区、多窗口；旧库升级已按 D403 取消）。审查者跑了 `check-arch`、`check-ui`（通过），没跑 cargo、vitest。每条修改都要补测试；处理结果写进各自 `round13-*-done.md` 的“审查后的修改”一节。主进程代码（`crates/host`、`src-tauri`）归外壳会话。

| # | 级别 | 问题 | 位置 | 处理人 | 处理 |
|---|---|---|---|---|---|
| 1 | 必须修 | 真环境里 `app.createWorkspace` 一定失败：主进程转发 `workspace.settingsSnapshot` 时带着界面连接的 `client`，内核回 `denied/mainProcessOnly`；主进程测试的假工作进程不查 `client`，没发现 | `crates/host/src/lib.rs:788`；`workspace_settings.rs:88-90` | 外壳 | 以主进程身份转发（`client: None`）；测试用会拒绝的假工作进程或真内核 |
| 2 | 必须修 | 没绑定的连接（`main` 窗口、不带 `workspace=` 的标签页）跟着全局 `active` 走，别的窗口一切换就被悄悄带走；`active` 指向的工作区永不停、永不能删 | `lib.rs:436-440,800-817` | 外壳 | D406：连接第一次出现就绑定到当时的默认工作区；`active` 只决定新连接的默认值，不参与路由，也不算“在用” |
| 3 | 应修 | 删除与切换/新窗口绑定之间有竞态（启动工作进程期间删除能通过） | `lib.rs:443-470,800-812,839-856` | 外壳 | 工作区操作串行（同一把锁），切换在启动前先登记占用；补测试 |
| 4 | 应修 | 并发同名新建撞到同一个文件夹（`exists()` + `create_dir_all`） | `workspaces.rs:99-108,164-167` | 外壳 | 用 `create_dir`，`AlreadyExists` 换后缀重试；补并发测试 |
| 5 | 应修 | 两个文件夹 id 相同（手动复制）：`find` 只命中第一个，删除会按前缀删掉另一个的钥匙串条目 | `workspaces.rs:123-139`；`lib.rs:706-708,850` | 外壳 | 主进程扫描时发现重复 id：后发现的那个标为待定（同 `pending:`，不能改名删除），并在列表里提示；按 §3.1 分配新 id 记 `todo.md` |
| 6 | 应修 | 装/移插件只让发起请求的那个工作进程做 `plugin.checkRemove` 和重扫；别的窗口的工作进程不知道 | `lib.rs:523-601` | 外壳 | 本轮修：移除前问所有运行中的工作进程，装/移后让它们都重扫 |
| 7 | 应修 | 浏览器（devhost）下“新窗口”不可用：`ws-transport` 没实现 `openWindow` | `ws-transport.ts`；`real-client.ts:78` | 外壳 | 浏览器下新开带 `?workspace=<id>` 的标签页 |
| 8 | 应修（原“只记录”） | 快照把 `Secret` 类型参数（密钥名）复制过去，新工作区里指向不存在的密钥 | `workspace_settings.rs:42,94` | 内核 | 像 `Ref` 一样跳过；补测试 |
| 9 | 只记录 | 只改过设置、没建过资源的旧工作区若被放进 `init-settings.json` 会被覆盖（需能写数据目录） | `workspace_settings.rs:117-140` | — | 记 `todo.md` |
| 10 | 应修 | 改名后内核 `workspace.info` 仍是旧名；工作进程崩溃重启后 `workspace.json` 的 `window` 字段丢失 | `kernel.rs:556`；`workspace.rs:133`；`lib.rs:615-618` | 外壳（`window` 字段在重启路径补回）；内核名称记 `todo.md`（界面以 `app.workspaces` 为准，D400） | |
| 11 | 只记录 | `round11.spec.ts` 注释里还有 `legacyKinds` | `e2e/round11.spec.ts:3,124` | 插件与测试 | 顺手删 |
| 12 | 只记录 | `top-bar.tsx` 缩进；主进程自己的 `WorkspaceEntry` 与协议重复；删除确认按钮无 busy 状态 | `top-bar.tsx:48,75`；`workspaces.rs:18` | 外壳 | 对齐协议类型时一并处理 |
| 13 | 应修（测试） | 缺：真内核下的新建、未绑定窗口被带走、删除/切换竞态、并发同名、重复 id、Secret 不复制、多工作区 e2e | `crates/host/tests`；`e2e/` | 各自；e2e 由插件与测试 | |

没有问题的检查点：主进程不打开工作区库、无插件名；名称校验与路径穿越；`pending:` 不能改名删除；删除移到 trash、按前缀只删本工作区条目、占用中被拒；`settingsSnapshot` 拒绝带 `client` 的请求、`init-settings.json` 只用一次、不带密钥值；事件按连接绑定过滤、每个工作区独立进程；旧库升级在代码、清单、协议、i18n 里无残留；界面只用基础组件与 token。
