# 第十三轮外壳与主进程 — 完成记录

分支 `claude/r13-shell-c13ac3`（从协调分支切出，未推送、未合并）。

## 做了什么

**主进程（`crates/host`）**
- **D403：不做第一版旧库升级。** 先前写的“移动并备份 `onedesk.db`”（`move_legacy_db`、`legacyMoveFailed`）及界面上的升级失败/未认领类型显示已全部删除；数据目录里有 `onedesk.db` 也完全不碰（有测试：`a_first_version_onedesk_db_is_not_touched`）。这些提交（f413e33、3dab0b9）里的相应部分已被后面的提交撤回。
- **多窗口（D403）**：`Host::bind_client(client, workspaceId)`（新窗口/新标签绑定到某工作区，不改变其他连接的默认）、`unbind_client(client)`（窗口关闭：没有别的连接/默认在用就停掉那个工作区的工作进程）、`window_bounds` / `set_window_bounds`（逻辑像素 `{x,y,width,height}`，存在该工作区 `workspace.json` 的 `window` 字段；内核每次打开工作区会重写 `workspace.json`，所以主进程在工作进程启动后把 `window` 写回）。
- 桌面：Tauri 命令 `open_window { workspace }` 建 `win-N` 窗口（先绑定再建窗，首个 `hello` 就属于该工作区），位置大小取自该工作区的 `window`（偏移 24 像素），没有就 1440×900；窗口 `CloseRequested` 时记位置大小，`Destroyed` 时 `unbind_client`；主窗口启动时按默认工作区的 `window` 恢复位置。`capabilities/default.json` 的 windows 增加 `win-*`。
- 浏览器/devhost：WebSocket 地址参数 `workspace=<id>`，握手后绑定，断开时解绑。外壳“新窗口”= `window.open(当前地址 + workspace=<id>, noopener)`（noopener 使新标签有新的 client id）；该标签里切换工作区时外壳把 `workspace` 参数从地址里去掉再重新载入。
- 多工作区：`Host` 现在是“每个有连接在用的工作区一个工作进程”（`Slot`：自己的连接、重启监视、重启计数）。每个连接（`client`）绑定一个工作区文件夹；没有绑定的连接用“当前默认”（启动时是 `lastOpened` 最近的那个，之后是最后一次切换到的）。请求转给连接所绑定工作区的工作进程；`hello` 返回那个工作进程的 hello。
- 事件：内部事件带工作区（`HostEvent { workspace, event }`，`Deref` 到 `EventMessage`）。`Host::visible_to(&ev, client)`：事件只发给绑定在该工作区的连接，`workspace: None` 的（`app.workspacesChanged`）发给所有人。`ws.rs`（devhost）与 `src-tauri/src/lib.rs` 都用它。`Host::events()` 的返回类型因此变成 `Receiver<HostEvent>`。
- 工作进程启动失败时，把它 stderr 的最后约 2000 字节拼进错误（例如打不开数据库的原因）。
- 新增 `workspaces.rs`：扫描、`workspace.json` 读写、建、移到 trash、读密钥名字。
- 新依赖：`crates/host` 依赖 `onedesk-kernel`（只用 `secrets::SecretStoreHandle` 与 `workspace::stamp`）。**D404：主进程不打开任何数据库，已去掉 `rusqlite`。** 工作区没有可读的 `workspace.json` 时列出为：名称=文件夹名、id=`pending:<文件夹>`、`idPending:true`，可切换，改名/删除返回 `conflict/idPending`；内核打开它时写出 `workspace.json` 后 id 就确定。删除时按前缀 `<工作区id>/` 删钥匙串：给内核 `SecretStore` 加了 `delete_prefix`（内存库有测试；钥匙串实现用 `security-framework` 列出本服务的账户再逐个删，**没有测试——不能碰真钥匙串，未运行过**）；`crates/kernel/Cargo.toml` 因此新增 `security-framework = "3"`（keyring 已带的同一个包，MIT/Apache-2.0），请在 decisions.md 补记。
- `HostConfig` 增加 `secrets: Option<SecretStoreHandle>`（`None` = 按环境：钥匙串或 `ONEDESK_SECRET_STORE=memory`）。测试一律传内存库。

**外壳**
- 标题栏工作区菜单：列出全部（当前的打勾，点别的就切换并整页重新载入）、“New workspace…”、“Manage workspaces…”；“新窗口”仍隐藏。
- 对话框（`parts/workspace-dialogs.tsx`）：新建、改名（1–100 字符，空/过长即时提示）、管理列表（名称、文件夹、改名、删除，当前的删除按钮禁用）、删除确认（写明移到数据目录的 trash 文件夹、钥匙串条目一并删除）。`workspacesChanged` 时标题栏、状态栏、管理列表刷新。
- `ProtocolClient.workspace` 增加 `create / switchTo / rename / remove`，`list` 现在返回 `WorkspaceEntry { id, name, folder?, lastOpened?, current }`；真实客户端调 `app.*`，混合客户端委托给内核客户端，假数据客户端有 2 个工作区的演示（电商数据 Shop Data、个人 Personal；状态存 localStorage，`?reset` 回到初始）。
- 标题栏菜单“Open a workspace in a new window…”打开管理列表，每行有“在新窗口中打开”按钮（`client.workspace.openWindow(id)`）。

## 主进程方法与事件的确切形状

| 方法 | 参数 | 结果 |
|---|---|---|
| `app.workspaces` | — | `{ items: WorkspaceEntry[] }`，`lastOpened` 新的在前；`current` = 本连接所绑定的 |
| `app.createWorkspace` | `{ name }` | `WorkspaceEntry`（`current:false`）。不切换 |
| `app.switchWorkspace` | `{ id }` | `WorkspaceEntry`（`current:true`）。未知 id → `notFound`（`what: workspace`） |
| `app.renameWorkspace` | `{ id, name }` | `null` |
| `app.deleteWorkspace` | `{ id }` | `null`。当前的/有连接绑定的/有工作进程在跑的 → `conflict` + `params.reason = "inUse"` |

`WorkspaceEntry = { id, name, folder, lastOpened?: number(ms), current }`（camelCase；`lastOpened` 为 0 时省略）。名称去首尾空白后空或超过 100 个字符 → `invalidParams`。事件 `app.workspacesChanged`（无参数、无 client）在新建、改名、删除之后推给所有连接；切换不推（外壳自己重新载入）。

## 文件夹命名与 trash 规则

- 文件夹由名称生成：字母数字（含中日文）保留并转小写，空白/`-`/`_`/`.` 变成单个 `-`，其余丢弃，最多 40 字符，空则 `workspace`；已存在则加 `-2`、`-3`…。`workspace.json` 的 id 是 32 位随机十六进制（与内核同形），不等于文件夹名。
- 一个文件夹算工作区：含 `workspace.json` 或 `workspace.db`。没有可读 `workspace.json` 的（例如刚移过来的旧库）由主进程补写：id 取库里的 `meta.workspace_id`，没有就新生成，名称取文件夹名（新装时主进程自己建的默认工作区叫 `Default`）。
- 删除：先读库里的 `secret_names` 和 `meta.workspace_id`，把文件夹移到 `<数据目录>/trash/workspaces/<文件夹>-<YYYY-MM-DD-HHMMSS>`（UTC，重名加 `-2`），再删钥匙串账户 `<工作区id>/<名字>`；钥匙串删除失败只记日志。不会自动清空 trash。
- 新建：`workspace.json` + 工作进程回答的 `workspace.settingsSnapshot` 写成 `init-settings.json`（内容原样，主进程不解释）。内核没有该方法（`unknownMethod`）时建空工作区、不写 `init-settings.json`。

## 测试结果

- `cargo test -p onedesk-host`：单元 31 + 集成 34，全过（含多窗口：绑定/解绑、最后一个窗口关闭停工作进程、占用中不能删、窗口位置保存、浏览器标签 `workspace` 参数；`onedesk.db` 不被碰）。
- `cargo clippy -p onedesk-host -p onedesk --all-targets -D warnings`（含 `src-tauri`）通过。
- 假数据模式 `e2e/workbench.spec.ts`：23 过、1 跳过（原本就跳过的 review shots），截图基准没改。
- 对着真内核走了一遍（临时目录、内存密钥库，`/private/tmp/claude-501/smoke.mjs`，不在仓库里）：devhost → `app.workspaces` → 新建 → 切换（`workspace.info` 变成新工作区）→ 删除当前的被拒 → 改名 → 切回 → 删除，文件夹进了 `trash/workspaces/second-…`，事件 3 次。**当时内核还没有 `workspace.settingsSnapshot`，所以新建时没有 `init-settings.json`；内核合并后要再走一遍。**
- `pnpm typecheck`、`pnpm lint` 通过。`pnpm test`：574 过、4 失败，**4 个都是 `plugins/_testing/lang-check.test.ts`（中日各两条：键必须等于 en-US、不得为空）**——因为我只加了英语文字（按任务书），中日由测试会话补。其余全过（含新增的 `workspace-dialogs.test.tsx`）。


## 新增文字键（只加了 en-US）

`topbar.manageWorkspaces`、`workspace.name`、`workspace.nameEmpty`、`workspace.nameTooLong`、`workspace.folder`、`workspace.current`、`workspace.newTitle`、`workspace.create`、`workspace.renameTitle`、`workspace.rename`、`workspace.renameAction`、`workspace.deleteAction`、`workspace.deleteTitle`、`workspace.deleteBody`、`workspace.delete`、`workspace.manageTitle`、`workspace.manageBody`、`kernel.error.conflict.inUse`、`workspace.openWindowAction`（`topbar.openInNewWindow` 早已存在，现在启用）。`kernel-texts.ts` 加了 `conflict.inUse` 映射。

## 我做的决定

1. 工作进程的数量按“连接绑定”管理：切走后没有别的连接（也不是默认）用的工作区立刻关闭；切回时重新启动（先等旧进程退出，释放锁）。
2. 没有绑定的连接（新开的页面、测试里 `client=None`）用“默认”工作区，切换会改默认——Tauri 单窗口等于“上次切到的”。
3. `workspace.settingsSnapshot` 不可用时建空工作区而不是报错（兼容合并前的内核）。
4. 删除前检查四种“占用”：本连接绑定、默认、任何连接绑定、有工作进程在跑。
5. 完全不依赖 `crates/protocol` 的新类型：`WorkspaceEntry` 在主进程与外壳各自定义（外壳在 `protocol/types.ts`）；内核会话把同名类型加进协议并生成后，把外壳的 `types.ts` 里的定义换成生成的即可。
6. 改名只改 `workspace.json`；运行中的工作进程的 `workspace.info` 名称在下次启动前仍是旧的，界面以 `app.workspaces` 为准（外壳的标题栏与状态栏也用 `app.workspaces`）。

## 没做 / 没验证

- **桌面窗口（Tauri）里没有看到**：没有启动 `pnpm start`；`src-tauri` 只做了编译与 clippy 检查，事件按窗口过滤的改动没有在真窗口里运行过。
- 切换后的“整页重新载入”靠 `window.location.reload()`，在真窗口里没试；浏览器里的 devhost 方式没有用 Playwright 点过（`e2e/round13.spec.ts` 是测试会话的）。
- 重复 id 的工作区文件夹（手动拷贝）没有处理（设计 3.1 说后发现的赋新 id）。
- **多窗口在桌面里没有运行过**：`open_window`、窗口事件、位置恢复、按窗口过滤事件只做了编译和 clippy；主进程的绑定/解绑/位置保存和浏览器标签的绑定有测试。浏览器标签的“新窗口”没有用 Playwright 点过。
- 浏览器标签的 WebSocket 断线重连时，只有带 `workspace` 参数的标签能回到原工作区，切换过的标签会回到默认工作区。
- 在 `docs/decisions.md` 里补记 host 对 `onedesk-kernel` 的依赖和内核新增的 `security-framework`，需协调会话做（我无权改该文件）。
- 钥匙串的 `delete_prefix` 真实现没运行过（只编译、clippy）。

## 与内核对齐（合并协调分支后）

- 主进程与外壳改用 `crates/protocol` 的 `WorkspaceEntry`、`WorkspacesResult`、`CreateWorkspaceParams`、`WorkspaceIdParams`、`RenameWorkspaceParams`、`method13::APP_*`、`topic13::APP_WORKSPACES_CHANGED`、`INIT_SETTINGS_FILE`、`WORKSPACE_SETTINGS_SNAPSHOT`；删掉自己的重复定义。**`idPending` 没进协议**：主进程内部用 id 形如 `pending:<文件夹>` 表示（外壳 `isPendingWorkspace(w)` 判断 `id.startsWith("pending:")`）；是否把它做成协议字段由协调会话定。
- 对真工作进程走出的一个问题：内核只接受不带 `client` 的 `workspace.settingsSnapshot`（`denied/mainProcessOnly`），主进程原先转发时带了 client，新建会失败——已改为不带 client 发给该连接所绑定工作区的工作进程，并加了断言。
- 真工作进程脚本（`/private/tmp/claude-501/smoke2.mjs`，临时目录+内存密钥库，不在仓库里）全过：A 改 `ui.density` 并停用 `org.onedesk.link`、建一个分组后新建工作区 → `init-settings.json` 写出；标签 B 以 `?workspace=<id>` 连上后：两个标签属于两个工作区；`init-settings.json` 首次打开后被删；B 里配置跟过去、插件仍停用、数据（分组）没过去；改 B 的配置不影响 A；列表里 `current` 按连接；关掉 B 后 Second 的工作进程在 2.5 秒内退出，A 不受影响。
