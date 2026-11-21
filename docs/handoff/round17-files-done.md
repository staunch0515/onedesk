# 第十七轮：文件与 API 连接插件（r17-files）完成说明

改动范围：`plugins/org.onedesk.files/**`、`plugins/org.onedesk.connection/**`（新）、`plugins/org.onedesk.http/**`。`pnpm test`（79 个文件 841 项）、`pnpm lint`、`pnpm typecheck` 通过。`pnpm check` 里的 Rust 与 e2e 部分没有跑（只改了插件）。最后提交号见文末。

## 需求逐条

### 硬盘文件（I.10b、I.10b-2）——`org.onedesk.files` 0.2.0

| 需求 | 结果 | 怎么验证 |
|---|---|---|
| 授权文件夹的增、查、改、移除 | 通过（依赖假设的接口，见下） | 新树“授权文件夹”：第一个节点“添加文件夹…”，其后每个授权一个节点；页面动作 `grantAdd`、`grantRename`、`grantRemove`。vitest：“authorized folders” |
| 移除授权不删资源和文件 | 通过 | 同上：移除前后资源表和假磁盘逐项相等，没有 trash/remove/move 调用 |
| 导入文件夹为 `disk-file` 资源，记名称、完整路径、大小、修改时间、扩展名 | 通过 | 资源 body：`path`、`size`、`modifiedAt`（ISO）、`ext`、`folder`；名称=文件名；外部键=完整路径 |
| 可选包含子文件夹 | 通过 | 参数 `recursive`（页面上“包含子文件夹”） |
| 分组用所在文件夹名 | 通过 | 新增类型 `disk-folder` 作分组（接受 `disk-folder`、`disk-file`），名称=文件夹名，子文件夹嵌套；文件的 `parent` 是所在文件夹的分组 |
| 重复导入只更新；文件没了标失效 | 通过 | 用 `resources.upsertByKey`；没读到的文件不进批，宿主标“失效”，再出现则恢复。别的文件夹的、以及不含子文件夹时更深的已导入文件以“只有键”的条目放进批，不会被误标 |
| 文件树与列表 | 通过 | 文件夹节点现在也有 `target`，点开是文件夹页（操作表单）；文件是编辑页 |
| 新建文件夹和文件、重命名、移动、复制 | 通过 | 动作 `mkdir`、`touch`、`rename`、`move`、`copy`；在文件上运行“新建”则建在它所在的文件夹 |
| 同名：覆盖、跳过、保留两份 | 通过 | 参数 `conflict`：`ask`（默认，停下并提示去选）、`overwrite`（给宿主 `{onConflict:"overwrite"}`）、`skip`（不动）、`keepBoth`（插件自己取第一个空闲的“名称 copy[ n].扩展名”）。重命名同理 |
| 删除：默认进废纸篓，永久删除二次确认 | 通过 | `trash`（默认）与 `delete`（清单 `confirm: "confirm.delete"`，页面按钮 `danger`）是两个动作；授权文件夹本身不能删（`isRoot`） |
| 打开、在 Finder 中显示 | 通过 | `open`、`reveal`（也可用于 `disk-file` 资源，路径取资源 body） |
| 按文件名搜索 | 通过 | `search`：多词都要在名称里，不分大小写，含子文件夹，最多 500 条、访问 2 万项；结果是表格 |
| 只在授权文件夹内；结果在结果区 | 通过 | 每个动作先 `normalize` 路径并按整段比对授权根（`/docs2` 不算在 `/docs` 里，`..` 逃出被拒），被拒时不调用宿主；动作都返回结果区输出，失败也是结果区的文字。vitest：“nothing outside the authorized folders” |

### API 连接（I.10h）——`org.onedesk.connection` 0.1.0

| 需求 | 结果 | 怎么验证 |
|---|---|---|
| 地址自动成为唯一可访问主机 | 通过 | `url` 字段 `grants: network`；路径拼在基址后，不能含协议或反斜杠，不会换主机 |
| 认证：无、Bearer、Basic、自定义请求头、查询参数 | 通过（Basic 有限制，见下） | `authParts`/`buildRequest` 的测试 |
| 密钥只进钥匙串 | 通过 | `secret` 是 secret 字段，只用 `{{secret:名字}}`；测试里资源与页面输出都不含值；不在 `defaults` 里 |
| 可分组、搜索、按环境覆盖 | 通过（分组、搜索由内核的资源树提供；环境覆盖用地址里的 `:名称`，与 HTTP 插件同一规则） | 页面测试 |
| 导出 `request` 动作；“测试连接” | 通过 | `exports.actions: ["request"]`，入参 `{method, path, query, headers, body, inline}`；`inline:true` 返回 `{status,statusText,headers,body,truncated}` 的 JSON 文字 |
| 每次调用进审计 | 通过（靠内核） | 宿主的 `network.request` 与 `actions.call` 本来就记审计（D309、D413）；插件没有自己的审计接口 |

### HTTP 请求插件

通过。新增可选字段 `connection`（资源选择，`kinds: [org.onedesk.connection:connection]`）；选了连接后“地址”写成路径，请求经 `org.onedesk.connection:request` 发出，认证由连接添加。清单加了 `depends`。没有连接时页面不显示选择器，行为不变。

## 我假设的内核接口（`round17-protocol.md` 出现前按设计写；名字不同时改 `plugins/org.onedesk.files/main.js` 的几处调用）

`ctx.host.files.*`（要求 `requires.files`）：
- `addFolder()` → `{ path, name }` 或 `null`（用户取消）；系统文件夹选择框
- `renameFolder(path, name)`、`removeFolder(path)`（移除授权，进审计，不动资源和文件）
- `createFolder(path)`
- `copy(from, to, opts?)`、`move(from, to, opts?)`，`opts = { onConflict: "overwrite" }`；目标已存在且没给 `onConflict` 时应失败
- `trash(path)`、`remove(path)`（永久，目录递归）
- `open(path)`、`reveal(path)`
- 已有的 `roots/list/stat/readText/writeText` 不变；`stat` 要有 `dir`，找不到时 `notFound`；新建文件用 `writeText(path, "")`

另外假设：节点页动作的参数（`param: true` 的字段）在 `ctx.params`；节点页动作的 `ctx.node.key` 是页面所在节点。

## 限制与范围外

- **Basic 认证**：宿主只能替换 `{{secret:…}}`，不能做 base64，所以密钥字段要填 `user:password` 的 base64。想要“用户名+密码”，需要内核支持带编码的替换（例如 `{{secret:名字|base64}}`）或 Basic 专用字段。建议主会话决定。
- **同名“让用户选”**：现在是表单里的下拉（默认“先问”则停下并提示），不是弹对话框；若 `r17-shell` 做了冲突对话框，需要约定它怎样把选择交回动作（建议还是写进 `conflict` 参数）。
- **导入的上限**：一批最多 5000 条（`upsertByKey` 限制）；已有 `disk-file` 加新文件超过就报 `error.tooMany`。大文件夹需要分批的“只更新不标失效”模式，留给后续。
- **授权文件夹页的“改”**只改显示名；是否支持由内核的 `renameFolder` 决定。
- 内置的 `plugin.grantFolder` 工具栏命令保留在“文件”树上。
- 外壳还不认识的新原因码：无（错误都是插件自己的文字）。
- 新依赖：无。

## 最后提交

见 `git log` 中 `plugin/files`、`plugin/connection`、`plugin/http` 的提交（本文件随其中最后一个提交）。
