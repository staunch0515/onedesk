# 本周协议与约定（协调会话定，三块任务共同遵守）

依据：`docs/redesign/kernel-design.md`、`docs/redesign/week1-slice.md`。决定编号 D256–D269 见 `docs/decisions.md`。
**类型以 `crates/protocol/src/lib.rs` 为准**（已写好、已生成 TS 到 `src/workbench/protocol/generated/`）。本文件只写类型表达不了的约定。

## 1. 仓库结构（D256）

| 位置 | 内容 | 写入者 |
|---|---|---|
| `Cargo.toml`、`.cargo/`、`scripts/gen-types.sh`、`docs/decisions.md`、`docs/handoff/week1-protocol.md` | 工作区、类型生成、决定 | 协调 |
| `crates/protocol` | 协议类型（只有类型） | 协调定稿；内核会话可**只增不改**（见 §9） |
| `crates/kernel` | `onedesk-kernel`：内核库，不依赖 Tauri | 内核 |
| `crates/worker` | `onedesk-worker`：一个工作区一个进程 | 内核 |
| `crates/host` | `onedesk-host`：主进程逻辑（不依赖 Tauri）+ `onedesk-devhost` 可执行文件 | 外壳 |
| `src-tauri` | `onedesk`：Tauri 主进程，只是 `onedesk-host` 的窗口外皮 | 外壳 |
| `src/workbench`、`src/design`、`workbench.html`、`vite.config.ts`、`package.json` | 界面 | 外壳 |
| `plugins/<插件id>/` | 内置插件的包（`manifest.json`、`main.js`、`locales/`） | 插件与测试 |
| `e2e/`、`playwright.config.ts`、`scripts/check-arch.mjs`、`scripts/check-ui.mjs`、`docs/screenshots/` | 界面检查、架构检查 | 插件与测试 |

第一版的 `src/kernel`、`src/shell`、`src/platform`、`src/plugins`、`src/plugin-api`、旧 e2e 已删除（D257）。`spikes/kernel-slice/` 是只读参考，可以照抄其中的做法，不要引用它。

## 2. 进程与传输

```
界面 ──(Tauri 命令/事件 或 WebSocket)── 主进程(onedesk-host) ──(Unix 套接字，每行一条 JSON)── 工作进程(onedesk-worker → onedesk-kernel)
```

**线格式**（`Request`、`Response`、`EventMessage`）：请求 `{id, method, params, client?}`；应答 `{id, result}` 或 `{id, error}`；事件 `{topic, payload?, client?}`（没有 `id`）。连接上的第一条请求必须是 `hello`，版本不同返回 `versionMismatch`。

**工作进程的命令行**（内核会话实现，外壳会话调用）：

```
onedesk-worker --workspace <工作区文件夹> --plugins <插件文件夹> --socket <套接字路径>
```

- 启动后在 `--socket` 上监听，只接受一条连接（主进程）；连接断开后完成当前事务并退出（退出码 0）。
- 工作区文件夹已被另一个工作进程锁住：退出码 3。其他启动失败：退出码 1，原因写到 stderr。
- 工作区文件夹不存在或是空的：自己建库（`workspace.json`、`workspace.db`）。工作区 id 随机生成。
- 套接字路径由主进程给，放在系统临时目录下的短路径（macOS 限 103 字节）。
- `client` 由主进程在转发时填写；操作者一律是本机用户 `user`。

**主进程库的接口**（外壳会话实现）：`Host::start(HostConfig { data_dir, worker_bin, builtin_plugins })`；`host.request(client, method, params) -> Result<Value, ProtocolError>`；`host.events()`（广播）。工作进程退出后自动重启（间隔逐次加长），在途请求得到 `workerGone`，重启期间的新请求等待新进程；重启前后各发一条 `connection` 事件（`lost`、`restored`）。启动时把 `builtin_plugins` 下的每个包复制到 `<data_dir>/plugins/<id>/<version>/`（已存在且内容相同则不动）。

**数据目录**（D264）：发布构建 `~/Library/Application Support/onedesk/`；开发构建 `~/Library/Application Support/onedesk-dev/`；环境变量 `ONEDESK_DATA_DIR` 覆盖。本周只有一个工作区 `workspaces/default/`。不读、不改旧的 `onedesk.db`。测试只用临时目录。

**界面的三种连接方式**（外壳会话实现，同一套界面代码）：

1. 桌面窗口：Tauri 命令 `protocol_request(method, params)` + Tauri 事件 `protocol-event`。
2. 浏览器连真内核（界面检查用，D266）：地址带 `?kernel=ws://127.0.0.1:<端口>&token=<令牌>`，经 WebSocket 连 `onedesk-devhost`。
3. 两者都没有：纯假数据（原型原样）。它是外观基准，`e2e/workbench.spec.ts` 继续跑它。

`onedesk-devhost --data-dir <目录> --port <端口> --token <令牌>`：只监听 127.0.0.1，令牌不符拒绝；就绪后在 stdout 打印一行 `READY`。它与桌面主进程共用 `onedesk-host` 库。

## 3. 方法（本周实现的全部）

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `hello` | `HelloParams` → `HelloResult` | |
| `workspace.info` | — → `WorkspaceInfo` | |
| `tree.list` | — → `TreeInfo[]` | 内核的 `resources` 树 + 各插件清单声明的树。不激活插件 |
| `tree.children` | `TreeChildrenParams` → `TreePage` | 存储树直接读库；提供树调用插件的 `children`。每批最多 200 |
| `tree.path` | `TreeNodeParams` → `string[]` | 从根到该节点的 key。提供树由插件的 `path` 给出 |
| `tree.move` | `TreeMoveParams` → `null` | 只对存储树；提供树返回 `unsupported`。拒绝：移到自己或自己的后代里、目标不接受该类型（`invalid`） |
| `tree.createGroup` | `TreeCreateGroupParams` → `TreeNode` | `core:group` |
| `tree.rename` | `TreeRenameParams` → `null` | 存储树 = 改资源的 `name`；空名字 `invalid` |
| `resource.get` | `ResourceIdParams` → `Resource \| null` | 信息面板用 |
| `resource.delete` | `ResourceIdParams` → `null` | 做删除标记；分组连同后代作为一批（§3.4） |
| `page.resolve` | `PageResolveParams` → `PageDescriptor` | 见 §5。目标不存在：`found:false, page:"missing"`，不是错误 |
| `page.save` | `PageSaveParams` → `PageSaveResult` | 保存的唯一入口（D259）。见 §5 |
| `command.newItems` | — → `NewItem[]` | “新建”下拉：`node.newGroup` + 各清单 `menus.new` |
| `command.execute` | `CommandExecuteParams` → `CommandEffect[]` | 见 §6 |
| `plugin.grants` | `PluginParams` → `PluginGrants` | |
| `plugin.grantFolder` / `plugin.revokeFolder` | `PluginFolderParams` → `PluginGrants` | 见 §7 |
| `ui.get` / `ui.set` | `UiGetParams` → 值或 `null` / `UiSetParams` → `null` | 按 `client` 分开存（§9.2）；没有 `client` 时用 `default` |

**事件**（内核提交后发出；本周不做服务端订阅，全部推给主进程，界面按主题过滤，D258）：`tree:<树id>`（该树的节点有增删改移）、`resource:<id>`、`plugins`（授权变化）、`ui`（载荷是一个 `CommandEffect`，带 `client`）、`connection`（主进程发）。文件树的内容来自硬盘，内核不监视硬盘；保存文件后内核发 `tree:<文件树id>`。

**保留假数据的方法**（界面里标明“演示数据”，D265）：`workspace.list/startTargets/getConfig/setConfig`、`resource.history/restore/listDeleted/undelete/purge`、`params.*`、`plugin.get/setEnabled/…`、`page.event`、`run.*`、`search.*`、`audit.*`、`command.palette`。也就是：环境树、配置树、插件树、数据源树、运行记录、收藏、已删除这些树及其页面仍由假实现提供。假实现原来的“资源”树改名为“演示资源”留着（SQL 等页面从这里进），假的“文件”树去掉。

**错误**：内核不含界面文字（§11）。`ProtocolError.code` + `params`，外壳在 `src/workbench/i18n/` 里按 `code` 配文字。内核自带的命令、树、类型同理：`label`/`title`/`kindLabel` 就是它们的 id（如 `node.rename`、`resources`、`core:group`），外壳按 id 查文字，查不到就原样显示（D262）。插件的文字由内核从插件的语言文件里取出，作为 `Label` 的多语言形式给出。

## 4. 存储树与内核命令

- 内核自带一棵通用存储树 `resources`（D260）；类型在清单里用 `tree` 声明放在哪棵树。`core:group` 可以放进任何存储树，接受该树的任何类型（`accepts: ["*"]`）。
- 节点：`key` = 资源 id；`target` = `resource:<id>`（分组没有 `target`）；`icon`、`draggable`、`accepts`、右键项来自类型的清单声明；`kind` 是完整类型名。
- 排序：`pos`。`tree.move` 的 `before/after` 相对目标节点，`inside` 放到末尾。
- 内核命令（`command.execute` 的 `id`）：

| id | 作用 | 效果 |
|---|---|---|
| `node.open` | — | `open` |
| `node.rename` | — | `rename`（界面开始行内改名，提交时调 `tree.rename`） |
| `node.newGroup` | 在 `context.nodeKey`（是分组时）或根下建分组，名字取 `context.args.name`，没有则由内核给一个不重名的默认名 `New group` | `reveal` + `rename` |
| `node.delete` | 删除 `context.nodeKey` | `close-target`（被删的每个有页面的资源各一条） |
| `new:<完整类型名>` | 来自“新建”下拉或右键 | `open`，目标 `new:<类型>?parent=<context.nodeKey 是分组时的 id>` |
| `plugin.grantFolder` | `context.args.plugin` 或由 `context.tree` 推出所属插件 | `pick-folder` |
| `<插件id>:<命令名>` | 交给插件的 `commands.handle` | 插件返回的效果 |

- 存储树节点的右键项 = `node.open`（有页面时）、`node.rename`、`node.newGroup`（分组）、类型清单里声明的命令、`node.delete`（`danger`，前面有分隔线）。空白处右键和工具栏：`node.newGroup` + 清单 `menus.new` 的各项。

## 5. 页面

`page.resolve(target)`：

- `resource:<id>`：按资源绑定的类型找到清单里的页面，调用插件的 `render(ctx)`。内核填 `title`（资源名）、`icon`、`kindLabel`、`breadcrumb`（树中路径）、`actions`（清单页面声明）、`hasInfo:true`、`basis`（`rev` 的字符串）、`values`（视图里每个 `bind` 路径当前保存的值）。
- `new:<类型>?parent=<id>`：同上，但资源还不存在：`ctx.resource` 是类型的默认值（清单 `defaults`），`title` 取清单 `newName`，`resourceId` 为空。
- `node:<树id>/<key>`（`key` 做 URL 编码）：调用该树声明的页面的 `render(ctx)`，`ctx.node = {tree, key}`。`title`、`icon`、`breadcrumb`、`values`、`basis`、`readOnly` 由插件的返回值给出；`hasInfo:false`。
- 插件返回的视图逐个按 `ViewNode` 严格校验（未知字段、未知节点类型都拒绝），不合格是 `pluginError`。
- 插件未加载、渲染超时：`page.resolve` 返回错误 `pluginError`/`pluginTimeout`；界面在标签页里显示错误，不崩。

`page.save(target, changes, basis)`：

- `resource:`：`changes` 的键是绑定路径：`name`、`description`、`tags`、`body.<键>`。内核把它变成写入管线的一条命令（权限 → 事务：核对并发、写数据、写 `revisions`、写 `audit` → 提交后发事件）。`basis` 之后同一字段被别人改过：`conflict`。没有变化不记。
- `new:`：先创建再应用 `changes`，一条命令。结果里 `page.target` 是 `resource:<新id>`，界面把标签页改指到它。名字为空用清单 `newName`。
- `node:`：调用插件页面的 `save(ctx, changes, basis)`，插件用 `ctx.host.files.writeText` 等完成，返回新的 `basis`。之后内核重新 `render` 作为结果。
- 结果都是保存后的 `PageDescriptor`。

未保存标记、⌘S、关闭前询问由页面框架处理（原型已有），内核不参与。

## 6. 插件包（清单 v2 的本周子集，D267）

包 = `plugins/<id>/<version>/` 下的 `manifest.json` + `main.js`（可 `import "./x.js"`）+ 语言文件。清单严格校验：未知字段、缺字段、`apiVersion` 不是 `"2"`、id 与文件夹不符、版本与文件夹不符，都不加载。本周所有通过校验的插件默认启用（D263）。

```json
{
  "id": "org.onedesk.note",
  "version": "0.1.0",
  "apiVersion": "2",
  "name": "plugin.name",
  "description": "plugin.description",
  "icon": "sticky-note",
  "main": "main.js",
  "requires": { "files": false },
  "contributes": {
    "kinds": [
      { "id": "note", "label": "kind.note", "icon": "sticky-note", "tree": "resources", "page": "editor",
        "newName": "kind.note.new", "defaults": { "text": "" },
        "draggable": true, "accepts": [], "menu": ["duplicate"] }
    ],
    "pages": [
      { "id": "editor",
        "actions": [ { "id": "save", "role": "save", "label": "action.save", "icon": "save", "primary": true, "shortcut": ["Mod", "S"] } ] }
    ],
    "trees": [
      { "id": "files", "label": "tree.files", "icon": "folder-open", "source": "provided", "page": "text",
        "toolbar": ["plugin.grantFolder"] }
    ],
    "commands": [ { "id": "duplicate", "label": "command.duplicate", "icon": "copy" } ],
    "menus": { "new": ["note"] },
    "locales": { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" }
  }
}
```

- 文字都是键，语言文件是 `{ "键": "文字" }`；`en-US` 必须有。内核把键换成 `Label` 的多语言形式。
- 类型名对外是 `<id>:<kind.id>`；树 id 对外是 `<id>:<tree.id>`；命令对外是 `<id>:<command.id>`。清单里引用自己的东西写短名，引用内核的写全名（`plugin.grantFolder`、`resources`）。
- `icon` 是 lucide 图标名。`kinds[].tree` 省略表示这个类型不进树。`contributes` 下每一项都可省略。
- 给清单里没有的页面、树、命令注册处理函数：激活失败（§7.5“给清单里没有的东西注册行为会被拒绝”）。

## 7. 沙箱与宿主接口（本周子集，D268）

沙箱规则按内核设计 §7.4 和小样结论：每个插件版本一个 rquickjs 运行环境，只有语言内建；模块加载只认包内的 `./x.js`；内存上限 32 MB；同步片段看门狗 1 秒；激活超时 10 秒；每次调用总时限 15 秒；看门狗触发或超内存后丢弃运行环境，下次用到再激活；惰性激活（`tree.list`、存储树的 `tree.children`、`command.newItems` 不激活任何插件）；插件代码不与协议收发共用线程。空闲回收本周不做。

```js
// main.js
export default {
  activate(host) {                       // host 只用来注册
    host.pages.handle("editor", {
      async render(ctx) { return { view: [...] }; },                 // 资源页
      async save(ctx, changes, basis) { return { basis: "..." }; }   // 只有 node: 页面需要
    });
    host.trees.handle("files", {
      async children(ctx, parentKey, offset) { return { nodes: [{ key, label, icon, expandable, target?, badge? }], next? }; },
      async path(ctx, key) { return [key1, key2, ...]; }
    });
    host.commands.handle("duplicate", async (ctx, context) => [ /* CommandEffect */ ]);
  }
};
```

`render` 的返回值：`{ view: ViewNode[], values?, basis?, title?, icon?, breadcrumb?: [{label, key?}], readOnly? }`（后五项只对 `node:` 页面有意义）。

`ctx`：`{ target, resource?, node?, draft?, locale, host, t(key) }`。`ctx.t(key)` 返回本插件该键的多语言 `Label`。处理函数只能通过 `ctx.host` 调宿主（按调用区分，取消或超时后这次调用再发的宿主调用被拒绝）。宿主调用失败时在 JS 里抛出 `Error`，带 `code`（`ErrorCode` 的值）。

| `ctx.host.` | 方法 | 限制（每一条都要有“被拒绝”的测试） |
|---|---|---|
| `resources` | `get(id)`、`list({kind?, parent?})`、`create({kind, parent?, name, description?, tags?, body})`、`update(id, changes, rev?)`（`changes` 同 `page.save`）、`move(id, {parent?, before?})`、`remove(id)` | 读写都只限自己的类型（别人的：`denied`）。写入走同一条写入管线，操作者是 `plugin:<id>@<version>` |
| `files` | `roots()` → `[{path, name}]`；`list(path, {offset?, limit?})` → `{entries: [{name, path, dir, size, modifiedAt, hidden}], next?}`；`stat(path)`；`readText(path)` → `{text, basis}`；`writeText(path, text, {basis?})` → `{basis}` | 清单没有 `requires.files: true`：`denied`。路径先规范化、解析符号链接，再判断是否在该插件被授权的某个文件夹之内；不在：`denied`（含 `..`、指向外面的符号链接、授权文件夹的同名前缀如 `/a/b` 与 `/a/bc`）。`readText`：超过 2 MB 是 `invalid`（`params.reason = "tooLarge"`），不是 UTF-8 是 `invalid`（`reason = "notText"`）。`writeText` 带 `basis` 且文件已变：`conflict`。写入先写临时文件再改名。每次写入记审计 |
| `ui` | `open(target)`、`notify(message, tone?)`、`copy(text)` | 变成 `ui` 事件发给发起这次调用的客户端。`open` 只接受 §9.1 的目标写法 |

授权文件夹（D261）：存在该插件的 `core:plugin-state` 节点里（存储在不显示的树 `core:plugin-state` 中，body 的参数 `files.folders`），经写入管线，有历史和审计。`plugin.grantFolder` 只接受存在的文件夹的绝对路径，存规范化后的路径；插件自己不能调用它（它不在宿主接口里）。

## 8. 数据库（内核会话）

迁移文件放 `crates/kernel/migrations/NNNN_*.sql`，从 `0001` 起；每个迁移有升级测试（规则 6）。`0001` 按内核设计 §3.2 建：`resources`、`revisions`、`audit`（触发器禁止改删）、`resource_meta`、`plugin_storage`、`ui_state`、`outbox`、`meta`。其余表到用的时候再加迁移。第一版旧库的升级不在本周。

## 9. 协议变更的规矩

- 类型不够用：内核会话可以在 `crates/protocol` 里**新增**类型或可选字段，重新 `pnpm gen:types`，并在自己的交接文件里列出“协议变更”。不许改名、删除、改含义；确实需要的，写 `docs/handoff/blocked-<分支>-<简述>.md`，先做别的。
- 外壳、插件两个会话不改 `crates/protocol`，需要什么写进自己的交接文件。
- 各 crate 需要新依赖：写在自己的 `Cargo.toml` 里，并在交接文件里列出名称、版本、许可证、用途（只允许 MIT/Apache-2.0/BSD/ISC/Zlib/Unicode-3.0）。根 `Cargo.toml` 的 `[workspace.dependencies]` 里已有的直接用。
