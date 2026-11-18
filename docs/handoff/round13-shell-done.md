# 第十三轮外壳与主进程 — 完成记录

分支 `claude/r13-shell-c13ac3`（从协调分支切出，未推送、未合并）。

## 做了什么

**主进程（`crates/host`）**
- `data_dir.rs::move_legacy_db`：数据目录只有 `onedesk.db`、且 `workspaces/` 下没有任何含 `workspace.db` 的文件夹时，先把 `onedesk.db`（及 `-wal`、`-shm`）**复制**到 `workspaces/default/backups/v1-onedesk.db`（同样的后缀），再把原文件**移动**为 `workspace.db`（及 `-wal`、`-shm`）。复制失败不移动；移动中途失败把已移动的放回。失败时 `Host::start` 返回 `HostError("legacyMoveFailed: …")`，不启动工作进程。已有带数据库的工作区时不碰 `onedesk.db`。
- 多工作区：`Host` 现在是“每个有连接在用的工作区一个工作进程”（`Slot`：自己的连接、重启监视、重启计数）。每个连接（`client`）绑定一个工作区文件夹；没有绑定的连接用“当前默认”（启动时是 `lastOpened` 最近的那个，之后是最后一次切换到的）。请求转给连接所绑定工作区的工作进程；`hello` 返回那个工作进程的 hello。
- 事件：内部事件带工作区（`HostEvent { workspace, event }`，`Deref` 到 `EventMessage`）。`Host::visible_to(&ev, client)`：事件只发给绑定在该工作区的连接，`workspace: None` 的（`app.workspacesChanged`）发给所有人。`ws.rs`（devhost）与 `src-tauri/src/lib.rs` 都用它。`Host::events()` 的返回类型因此变成 `Receiver<HostEvent>`。
- 工作进程启动失败时，把它 stderr 的最后约 2000 字节拼进错误（例如内核的 `legacyUpgradeFailed …`），外壳据此显示原因。
- 新增 `workspaces.rs`：扫描、`workspace.json` 读写、建、移到 trash、读密钥名字。
- 新依赖：`crates/host` 依赖 `onedesk-kernel`（只用 `secrets::SecretStoreHandle` 与 `workspace::stamp`）和 `rusqlite`（只读打开待删工作区的库读 `meta.workspace_id` 与 `secret_names`）。两者都已是工作区内依赖/已在 decisions 的白名单里，没有新的第三方包；**请协调会话在 decisions.md 补一行**（规则 9）。
- `HostConfig` 增加 `secrets: Option<SecretStoreHandle>`（`None` = 按环境：钥匙串或 `ONEDESK_SECRET_STORE=memory`）。测试一律传内存库。

**外壳**
- 标题栏工作区菜单：列出全部（当前的打勾，点别的就切换并整页重新载入）、“New workspace…”、“Manage workspaces…”；“新窗口”仍隐藏。
- 对话框（`parts/workspace-dialogs.tsx`）：新建、改名（1–100 字符，空/过长即时提示）、管理列表（名称、文件夹、改名、删除，当前的删除按钮禁用）、删除确认（写明移到数据目录的 trash 文件夹、钥匙串条目一并删除）。`workspacesChanged` 时标题栏、状态栏、管理列表刷新。
- `ProtocolClient.workspace` 增加 `create / switchTo / rename / remove`，`list` 现在返回 `WorkspaceEntry { id, name, folder?, lastOpened?, current }`；真实客户端调 `app.*`，混合客户端委托给内核客户端，假数据客户端有 2 个工作区的演示（电商数据 Shop Data、个人 Personal；状态存 localStorage，`?reset` 回到初始）。
- 升级失败与未认领类型：启动失败文字里含 `legacyMoveFailed` / `legacyUpgradeFailed` 时用各自的说明（`startup.legacyMoveFailed`、`startup.legacyUpgradeFailed`）。树节点 `state` 为 `"unknownKind"`（内核若用它）或沿用已有的 `missing-plugin` 时，显示为“没有插件处理的类型”（`tree.unknownKind`）。

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
- 一个文件夹算工作区：含 `workspace.json` 或 `workspace.db`。没有可读 `workspace.json` 的（例如刚移过来的旧库）由主进程补写：id 取库里的 `meta.workspace_id`，没有就新生成，名称取文件夹名（`default` 例外：新装与旧库升级的默认工作区都叫 `Default`）。
- 删除：先读库里的 `secret_names` 和 `meta.workspace_id`，把文件夹移到 `<数据目录>/trash/workspaces/<文件夹>-<YYYY-MM-DD-HHMMSS>`（UTC，重名加 `-2`），再删钥匙串账户 `<工作区id>/<名字>`；钥匙串删除失败只记日志。不会自动清空 trash。
- 新建：`workspace.json` + 工作进程回答的 `workspace.settingsSnapshot` 写成 `init-settings.json`（内容原样，主进程不解释）。内核没有该方法（`unknownMethod`）时建空工作区、不写 `init-settings.json`。

## 测试结果

- `cargo test -p onedesk-host`：单元 35 + 集成 31，全过（新增：备份移动、已有 workspaces 不动、移动/备份失败不删、五个方法、占用中被拒、删除移到 trash 并删内存钥匙串里的条目、事件按工作区过滤、WebSocket 上的事件、worker 启动失败带最后几行）。
- 对着真内核走了一遍（临时目录、内存密钥库，`/private/tmp/claude-501/smoke.mjs`，不在仓库里）：devhost → `app.workspaces` → 新建 → 切换（`workspace.info` 变成新工作区）→ 删除当前的被拒 → 改名 → 切回 → 删除，文件夹进了 `trash/workspaces/second-…`，事件 3 次。**当时内核还没有 `workspace.settingsSnapshot`，所以新建时没有 `init-settings.json`；内核合并后要再走一遍。**
- `pnpm typecheck`、`pnpm lint` 通过。`pnpm test`：574 过、4 失败，**4 个都是 `plugins/_testing/lang-check.test.ts`（中日各两条：键必须等于 en-US、不得为空）**——因为我只加了英语文字（按任务书），中日由测试会话补。其余全过（含新增的 `workspace-dialogs.test.tsx`）。
- 假数据模式 `e2e/workbench.spec.ts`、clippy：见本文件末尾“收尾结果”。

## 新增文字键（只加了 en-US）

`topbar.manageWorkspaces`、`workspace.name`、`workspace.nameEmpty`、`workspace.nameTooLong`、`workspace.folder`、`workspace.current`、`workspace.newTitle`、`workspace.create`、`workspace.renameTitle`、`workspace.rename`、`workspace.renameAction`、`workspace.deleteAction`、`workspace.deleteTitle`、`workspace.deleteBody`、`workspace.delete`、`workspace.manageTitle`、`workspace.manageBody`、`kernel.error.conflict.inUse`、`tree.unknownKind`、`startup.legacyMoveFailed`、`startup.legacyUpgradeFailed`、`kernel.label.legacyClaimFailed`、`kernel.error.reason.legacyUpgradeFailed`。`kernel-texts.ts` 加了 `conflict.inUse`、`reason.legacyUpgradeFailed`、`legacyClaimFailed` 三个映射。

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
- 第一版旧库升级的内核部分（转换、认领）不在我的范围，用真旧库走通要等内核合并；主进程这一半只测了字节搬运。
- 窗口位置、多窗口、“新窗口”菜单项：按 D397 留到下一轮。
- 在 `docs/decisions.md` 里补记 host 对 `onedesk-kernel`/`rusqlite` 的依赖，需协调会话做（我无权改该文件）。
