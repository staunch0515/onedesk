# 第十六轮：协议与宿主接口新增的确切名字（内核会话）

其它会话照这里写。协议（`crates/protocol`）本轮**没有改动**：下面全是清单字段、宿主接口（`ctx.host.*`）和已有字段的新取值。外壳需要配文字的新原因码见最后一节。

## 1. X13 清单 `activation`（工作区打开后）

```json
{ "activation": ["workspace.opened"] }
```

- 清单顶层字段，字符串数组。目前只有一个值 `"workspace.opened"`；其它值、重复 → 清单无效，原因 `badActivation`。
- 处理函数用已有的事件注册：`host.events.on("workspace.opened", async (ctx, payload) => { … })`。`activation` 里声明了就可以注册，不必再写进 `contributes.events`。
- 何时调用：工作进程打开工作区、插件读完之后，对**每个已启用、当前版本已确认**并声明了它的插件各调用一次（之后启用的插件不补调）。按插件 id 顺序排队，彼此独立，不阻塞工作区打开。
- `ctx`：`{ event: "workspace.opened" }` 加 `ctx.host`；`payload`：`{}`。
- 规则与事件处理函数相同（D336）：可以用 `resources.*`、`files.*`、`storage.*`、`settings.get`、`params.*`；`network.request`、`process.*`、`transfer.*` 为 `denied/notInRun`；写入不对本插件再触发 `resource.changed`。时限 **60 秒**（普通事件 5 秒）。失败记审计 `events.failed`，不影响工作区。

## 2. 查询目录需要的宿主能力

### 2.1 `files.*`：已有的授权文件夹 + 插件自己的目录

- 已有（不变）：`files.roots()`、`files.list(path, { offset?, limit? })` → `{ entries: [{ name, path, dir, size, modifiedAt, hidden }], next }`（`modifiedAt` 为毫秒，即 mtime）、`files.stat(path)`、`files.readText(path)` → `{ text, basis }`、`files.writeText(path, text, { basis? })`。授权文件夹仍需清单 `requires.files: true` 和用户授权。
- **新增**：**相对路径**指插件自己的目录 `plugin-data/<插件id>/`，不需要 `requires.files`，也不需要授权（与 `transfer`、输出文件相同）。也接受落在自己目录里的绝对路径。`..` 出不去 → `denied/outsideGrant`；自己的 `bin/` 不能读写 → `denied/ownPrograms`。`files.roots()` 不列它。返回的 `path` 是绝对路径（可原样再传回）。

### 2.2 `resources.upsertByKey`：按外部键批量写入

```js
const r = await ctx.host.resources.upsertByKey("query", items, { othersMissing: true });
// items: [{ key, name?, description?, body?, parent? }]
// r: { created, updated, unchanged, restored, missing, ids: { [key]: id } }
```

- `kind`：自己的类型（短名或全名），否则 `denied/foreignKind`。
- `items`：最多 **5000** 条（`invalid/tooMany`）；`key` 为 1–1024 字符的字符串（`invalid/badKey`），同一批里不能重复（`invalid/duplicateKey`）。外部键的唯一范围是类型（§7.6）。
- 每条在**一个事务**里（全部成功或全部不写）：
  - 没有这个键：新建。`name` 不给时用键最后一段（`/` 之后）；`body` 不给时用类型默认值；`parent` 只在新建时用（同 `resources.create`）。
  - 已有：**只按给出的字段提交**——`name`、`description`、`body` 里给出的那些键（其余键保留）。没给的字段、**标签、收藏、位置**都不动；什么都没变的不写历史、不记审计（计入 `unchanged`）。不接受 `tags`（`invalidParams`）。
  - 已有但被删除了：恢复（§3.4 “同一外部键再次导入时恢复原记录”，整批恢复），再按上一条提交；计入 `restored`。
  - 之前是“失效”的：恢复为正常，计入 `restored`。
  - 计数互斥：`created`（新建）、`restored`（从删除或失效回来，不论字段是否也变了）、`updated`（字段有变化）、`unchanged`（什么都没变）；`missing` 是本次被标为失效的条数。
  - 返回值没有 `ids` 以外的资源对象；要看某一条用 `resources.get(id)`。
- `opts.othersMissing: true`：这个类型里**有外部键、未删除、但不在这批里**的资源标为“失效”（计入 `missing`）。不给则不动别的资源。
- 写入审计与历史同 `resources.create`/`update`（每条一行）；另记一行 `resources.upsert`（摘要只有计数）。

### 2.3 资源“失效”状态

- 存在 `resources.state = 'missing'`（§3.3 已有的列）。只由 `upsertByKey` 设置与清除。
- 显示：树节点、`resource.get`、页面描述的 `state` 为已有的 **`"broken"`**，`stateReason` 为 **`"sourceMissing"`**（文字码，外壳配字）。没有新增 `NodeState` 值（外壳的 `Record<NodeState,…>` 不用改）。
- 从搜索中消失：`search.query` 和插件的 `resources.search` 都不返回失效资源；恢复后重新出现。
- 运行记录、历史、收藏、标签都保留；仍可打开（页面照常，显示失效）。
- 插件拿到的资源对象（`resources.get/list/create/upsertByKey` 涉及的）多两个键：`externalKey`（字符串或 `null`）、`missing`（布尔）。这是宿主接口里的 JSON，不在协议类型里。

## 3. E3（X8）从运行记录打开带当时的参数

- 已有命令（不变）：`run.reuse`（运行树节点右键与 `command.execute`，参数 `{ run }` 或节点上下文）→ 效果 `Open { target: "resource:<id>", params: <那次运行的参数>, envId: <那次的环境> }`；`run.openResource` 只打开不带参数。最近运行与已保留结果两组都有。
- **新增**：没有资源的运行（`new:` 标签页里运行的）若记下了类型，`run.reuse` 打开 `new:<类型>` 并带上参数；之前是 `notFound/resource`。资源已删除时仍是 `notFound/resource`。
- 外壳：点开最近运行要“回到查询并带上当时的值”就执行 `run.reuse`；点开保留结果仍用节点的 `target`（`run:<id>`）。

## 4. X9 树工具栏命令

- 已有（不变）：`contributes.trees[].toolbar: ["<命令id>"]`，命令须是自己 `contributes.commands` 里的（否则 `unknownCommand`）；`tree.list` 的 `TreeInfo.toolbar` 带上它们（`MenuCommand`，`id` 为 `<插件id>:<命令>`）。点击 → `command.execute`，插件的 `commands` 处理函数收到 `(ctx, context)`，`context.tree` 为树的全名。
- **新增**：插件命令执行成功后，内核发布它所有**提供树**的 `tree:<树全名>` 主题，外壳据此重取（“一层/两层”切换：命令里 `storage.set` 记下模式，`children` 按模式给节点）。
- 没有“按下/选中”状态：命令的文字/图标是清单里的固定值。

## 5. 被调插件的错误文字带回调用方（D413）

- `ctx.host.actions.call` 被调方出错时，调用方拿到的错误：`code: "pluginError"`、`params.reason: "calleeFailed"`、`params.action`（不变），**新增**：`e.message` 与 `e.detail` 都是被调方错误的第一行文字，已按这次运行读过的密钥值抹除（`***`）。
- 被调方抛带宿主码的错误（`{ code: "invalid", … }`）时原样带回，`detail` 缺省为它的 `message`（同样抹除）。
- 调用方不接住、直接抛出时，运行的错误为 `pluginError`，`message` 即这段文字（外壳不再只显示 “pluginError”）。

## 6. 新增原因码（外壳需配文字）

| 码 | 出现在 | 含义 |
|---|---|---|
| `sourceMissing` | 节点/资源/页面的 `stateReason`（`state: "broken"`） | 源文件已不存在（例如查询目录里的文件被删了） |
| `badActivation` | 插件加载失败原因（插件页） | 清单 `activation` 写了不认识的值或重复 |
| `invalid/tooMany`、`invalid/badKey`、`invalid/duplicateKey` | `resources.upsertByKey` 抛给插件 | 一般只进插件自己的错误，不会到界面 |

（`denied/ownPrograms`、`denied/outsideGrant` 已有。）
