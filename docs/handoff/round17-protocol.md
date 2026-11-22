# 第十七轮：协议与宿主接口新增的确切名字（内核会话）

其它会话照这里写。**第二版**（协调会话要求后的补充）：文件接口名字**不变**（只有一套，见 3.1）；新增 `writeText` 的 `executable`/`conflict`（3.1b）、确认效果的 `choices`/`choiceArg`/`irreversible`（D428，3.6）、页面动作的 `command`（D429，3.7）、密钥的 Basic/base64 代入（3.4）、`searchPaths` 的 `~/` 与位置检查、程序最长 2 小时（3.5）、提供树节点的 `menu`/`draggable`/`accepts`（D430，3.8）、动作返回 `failed`（D435，3.9）。协议（`crates/protocol`）只增不改；生成的 TS 已更新（`LineTone.ts`、`TextAppearance.ts`、`PluginReplaceFolderParams.ts`，以及 `ViewNode`、`RunOutput`、`Run`、`CommandEffect` 的新可选字段）。决定编号留给主会话（提议见 `round17-kernel-done.md`）。

## 1. X10 文字按行标色与“终端样式”

### 1.1 协议类型

```ts
type LineTone = "default" | "muted" | "success" | "warning" | "danger" | "stderr";
type TextAppearance = "plain" | "terminal";
```

- `ViewNode` 的 `text` 节点新增两个可选字段：
  - `lineTones?: (LineTone | null)[]`：`text` 按 `\n` 切成行，第 i 项是第 i 行的语气；`null`、缺项 = `default`；多出的项忽略（内核不报错）。
  - `appearance?: TextAppearance`：不给 = `plain`。`terminal` = 等宽、终端底色（token）、按行显示、语气按终端配色。
- `RunOutput` 的 `text` 同样新增 `lineTones?`、`appearance?`。
- `RunOutput` 的 `table` 新增三个可选字段（分页的表也保留，数据文件输出也可以带）：
  - `appearance?: TextAppearance`：`terminal` 时外壳可以把每行画成一行文字（导出仍是表）。
  - `toneColumn?: string`：一列的 `key`，该列每行的值是那一行的 `LineTone` 名（如 `"stderr"`、`"danger"`）；不认识的值（如 `"stdout"`）= `default`。
  - `lineColumn?: string`：终端样式下作为行文字的列 `key`；不给 = 最后一列。
  - **审查后（#16）**：`toneColumn`、`lineColumn` 必须是 `columns` 里的 `key`，否则运行失败 `badOutput`（`runs.partial` 为 `invalid/badOutput`，数据文件输出同样）。
- 插件返回数据文件输出时（`{ type: "table", file, … }`）也可以带 `appearance`、`toneColumn`、`lineColumn`；`{ type: "text", file }` 可以带 `appearance`。

服务器命令的典型输出：

```js
return { output: { type: "table",
  columns: [{ key: "stream", label: "Stream" }, { key: "line", label: "Line" }],
  rows: [["stdout", "hello"], ["stderr", "oops"]],
  appearance: "terminal", toneColumn: "stream", lineColumn: "line" } };
```

## 2. X17 外部程序按行输出、部分输出

### 2.1 `ctx.host.process.run(options)` 新选项

| 选项 | 类型 | 含义 |
|---|---|---|
| `lines` | `true` | 结果多一个 `lines`，并改变超时、行数上限的处理（见下） |
| `maxLines` | 正整数，最多 `100000` | 只与 `lines: true` 一起用；两个流合计到这么多行时立即结束进程 |

- 结果（`lines: true` 时）：

  ```js
  { code, signal, stdout, stderr, truncated,
    lines: [{ stream: "stdout" | "stderr", text: "…" }],   // 按到达的先后，text 不含换行（行尾的 \r 也去掉）
    stopped: null | "timeout" | "maxLines" }
  ```

  - 最后一行没有换行也算一行。**审查后（#5）**：超过 64 KB 还没有换行的，每 64 KB 切成一行（在完整的 UTF-8 字符处切）。
  - stdout 与 stderr 的先后只是近似的（两个管道分别读取，按读到的先后排）。
  - 跨行的密钥值（如多行私钥），除了整体，每一行（8 字节以上）也会抹掉（#16）。每个流的总字节仍受 8 MB 限制（超出 `truncated: true`，后面的行不再收）。
  - 不给 `maxLines` 时行数上限为 `100000`（超出时同样 `stopped: "maxLines"`）。
  - **超时**：`lines: true` 时不再抛 `invalid/timeout`，而是立即结束进程组，返回已收到的行，`stopped: "timeout"`、`code: null`、`signal: null`。（不带 `lines` 时与之前相同：抛 `invalid/timeout`。）
  - **行数上限**：到达时立即结束进程组，返回 `stopped: "maxLines"`、`truncated: true`，`lines` 恰好 `maxLines` 行。
  - **取消**（运行被取消）：与之前相同，立即结束进程组并抛 `denied/cancelled`。
  - “立即结束” = 对进程组发 SIGTERM，2 秒后仍在则 SIGKILL（D333，不变）；调用本身立即返回。
  - 密钥值在每行里抹除（`***`），与 `stdout`/`stderr` 相同。
- 与 `onOutput` 一起用时（`lines: true`），回调收到的每项是**一整行**：`{ stream, text }`，`text` 不含换行；不再按 100 ms 交出半行（最后一行在结束时交出）。不带 `lines` 时不变。
- 审计行不变（`process.run`，摘要多一个 `stopped` 键，只在有值时）。

### 2.2 部分输出：`ctx.host.runs.partial(output)`

- 只在运行里（动作执行中）；其他地方 `denied/notInRun`。
- `output` 与动作返回的 `output` 相同的形状，按动作声明的输出类型检查（类型不符或格式错 → `invalid/badOutput`）；`table` 最多 `MAX_ROWS` 行（多的截掉，`truncated: true`），大小限制同最终输出。不接受数据文件（`file`）。
- 内核把它（抹掉密钥后）记在内存里，替换上一次的；不写数据库、不进历史、不审计。
- 外壳：运行中 `run.get` 的 `Run.partial` 就是它；内核发 `run:<id>`（与进度相同，至多每 100 ms 一次；最后一次一定会在 100 ms 内补发）。运行结束后 `partial` 消失，看 `output`。运行列表（`run.tasks` 等）不带 `partial`。
- 典型用法：`process.run({ …, lines: true, stream, maxLines })` 的 `onOutput` 里把行攒起来，调 `runs.partial({ type: "table", columns, rows, appearance: "terminal", toneColumn: "stream", lineColumn: "line" })`。

## 3. X18 文件接口与授权文件夹

### 3.1 新的 `ctx.host.files.*`

**名字只有这一套**（文件插件与外壳都已按它写）：`mkdir`、`copy`、`move`、`trash`、`remove`、`open`、`reveal`、`find`、`addRoot`、`replaceRoot`、`removeRoot`；同名处理的选项叫 `conflict`。没有 `createFolder`、`addFolder`、`renameFolder`、`onConflict` 这些名字。

所有路径规则同已有的 `files.*`：绝对路径须在授权文件夹里（符号链接解析后逐段比较），相对路径是插件自己的 `plugin-data/<id>/`。两个路径的操作（`copy`、`move`）两边各自按这个规则检查（可以在两个授权文件夹之间，也可以从自己的目录复制到授权文件夹）。**授权文件夹本身**不能被 `move`、`trash`、`remove`（`invalid/isRoot`）。成功后发插件所提供的树的 `tree:<树>` 主题（同 `writeText`）。事件处理函数里只能用只读的 `list/stat/readText/find`，其余 `denied/notInRun`。

| 方法 | 返回 | 说明 |
|---|---|---|
| `files.mkdir(path, { recursive? })` | 新文件夹的 `Entry` | 已存在 → `conflict/exists`；上级不存在且不给 `recursive: true` → `notFound/path` |
| `files.copy(from, to, { conflict? })` | `{ path, skipped }` | 文件或文件夹（递归；文件夹里的符号链接按链接复制，不跟随）。`to` 是目标的完整路径（不是目标文件夹）。`path` 是最终写到的路径 |
| `files.move(from, to, { conflict? })` | `{ path, skipped }` | 改名也用它（同一文件夹里换名字）；跨卷时复制后删除 |
| `files.trash(path)` | `{ path }`（在废纸篓里的位置） | 移到废纸篓；废纸篓里已有同名的就按“保留两份”起名。不在同一卷上 → `invalid/trashUnavailable` |
| `files.remove(path)` | `null` | **永久删除**（文件夹递归）。内核不再确认，二次确认由插件（`Confirm` 效果）和外壳做 |
| `files.open(path)` | `null` | 用系统默认程序打开。**审查后（D432）**：只能用于授权文件夹（插件自己的目录 → `denied/outsideGrant`）；链接被解析到真实路径后再核对授权，打开的是真实路径；会被系统执行的东西一律拒绝 → **`denied/unsafeOpen`**：有任一可执行位的文件，以及扩展名为 `app`、`command`、`terminal`、`tool`、`workflow`、`action`、`scpt`、`pkg`、`jar`、`webloc`、`sh`、`py` 等的（全表见 `files.rs` 的 `RUNS_WHEN_OPENED`，不分大小写） |
| `files.reveal(path)` | `null` | 在 Finder 中显示（选中它）。同样只能用于授权文件夹，显示的是真实路径 |
| `files.find(path, query, { limit?, offset? })` | `{ entries: Entry[], next }` | 在文件夹里递归按**文件名**找（不跟随符号链接，跳过 `.` 开头的文件夹）：`query` 按空白切成词，每个词都要是文件名的子串（不分大小写）。`limit` 默认 200、最多 1000；最多看 100000 个条目（看到上限时结果多 `capped: true`） |
| `files.addRoot()` | `null` | 让外壳弹出选择文件夹的对话框（`CommandEffect` `pick-folder`），用户选了就是授权（D184）。**不等用户回答**：选好后授权以 `plugins` 事件和插件所提供的树刷新到达；取消则什么都不发生 |
| `files.replaceRoot(path)` | `null` | 同上，但效果带 `replace: path`；外壳选好后调 `plugin.replaceFolder`。`path` 不是授权文件夹 → `notFound/grant` |
| `files.removeRoot(path)` | `{ folders }`（剩下的授权文件夹） | 移除一个授权文件夹（只缩小权限，不删任何资源和文件）；不在列表里 → `notFound/grant` |

`conflict`（同名处理）取值：

| 值 | 目标已存在时 |
|---|---|
| `"fail"`（默认） | 抛 `conflict/exists`，什么都不动 |
| `"overwrite"` | 先删掉目标（文件夹整个删），再写 |
| `"skip"` | 什么都不做，返回 `{ path: to, skipped: true }` |
| `"keepBoth"` | 换一个名字：`name 2.ext`、`name 3.ext`…（与 Finder 相同），返回新路径 |

- `from` 与 `to` 相同、或把文件夹复制/移动到它自己里面 → `invalid/intoItself`。
- **审查后**：
  - 只差大小写的两个名字指向同一个文件时（按 (dev, ino) 判断），`move` 直接改名，不管 `conflict` 是什么，绝不删源文件；`copy` 报 `invalid/intoItself`（#2）。
  - `overwrite` 的目标若是授权文件夹、插件自己的目录，或里面含有授权文件夹 → `invalid/isRoot`，什么都不动；`move` 的源、`trash`、`remove` 若含有授权文件夹，同样 `isRoot`（#3）。
  - 所有写操作都先钉住父文件夹（不跟随链接）再改名或创建；新名字用 `RENAME_EXCL`/`O_EXCL`，检查之后才冒出来的同名文件绝不被覆盖，报 `conflict/exists`（#10）。删除文件夹的内部仍按路径删（Rust 标准库的 `remove_dir_all`）。
- 审计：`files.mkdir`、`files.copy`、`files.move`、`files.trash`、`files.remove` 各一行。`copy`/`move` 摘要 `{ from, conflict }`（`object` 是最终写到的路径；`skip` 跳过的不记），其余摘要 `{}`（`object` 是原路径）。被拒绝的调用照旧另记一行（结果 `failed:denied`）。`open`、`reveal`、`addRoot`、`replaceRoot` 不进审计（不改任何东西）；`removeRoot` 进审计（见 3.2）。

### 3.1b `files.writeText` 新选项（第二版）

`files.writeText(path, text, { basis?, executable?, conflict? })` → `{ basis, path, skipped: false }` 或 `{ skipped: true }`。

- `executable: true`：在可读的地方加上可执行位（新文件 `0755`）。
- `conflict`：取值同上表；**不给时与之前相同：替换已有文件**（保留它原来的权限）。`keepBoth` 返回新路径；`fail` 抛 `conflict/exists`；`skip` 什么都不写。

### 3.2 授权文件夹的增、查、改、移除（外壳）

已有（不变）：`plugin.grants`（查）、`plugin.grantFolder`（增）、`plugin.revokeFolder`（移除）。

- **新增** `plugin.replaceFolder`：`PluginReplaceFolderParams { plugin, path, newPath }` → `PluginGrants`。`newPath` 的检查同 `grantFolder`（绝对、存在的文件夹、不碰数据目录）；新文件夹占旧的位置；`newPath` 已在列表里时只删掉旧的。旧的不在列表里 → `notFound/grant`。
- **新增** `CommandEffect` `pick-folder` 的可选字段 `replace?: string`：有它时外壳选好文件夹后调 `plugin.replaceFolder { plugin, path: replace, newPath }`，否则照旧调 `plugin.grantFolder`。
- **审计**：增、改、移除每次一行：`plugin.grantFolder`、`plugin.replaceFolder`、`plugin.revokeFolder`，`object` 为插件 id，摘要 `{ folder }`（改为 `{ folder, from }`）。移除授权不删资源和文件（资源照旧在树里，只是插件读不到那里的文件了）。
- 授权变化后照旧发 `plugins` 和该插件所提供的树的 `tree:<树>` 主题。

### 3.3 废纸篓位置（测试用）

- 正式：用系统接口 `NSFileManager trashItemAtURL:`（与 Finder 相同，可以“放回原处”）。内核**不**自己打开 `~/.Trash`：没有“完全磁盘访问”的进程打开它会得到 `EPERM`（macOS 隐私保护）。返回的 `path` 是系统给的废纸篓里的位置。
- 错误：文件不在 → `notFound/path`；没有权限（读写被拒、只读卷）→ **`denied/trashDenied`**；那个卷没有废纸篓 → `invalid/trashUnavailable`；其他 → `internal`（`detail` 是系统的说明）。
- 工作进程读环境变量 **`ONEDESK_TRASH_DIR`**（测试、验收用）：设了就不用系统接口，而是改名移进这个文件夹（须是已存在的文件夹，且与要删的文件在同一卷，例如临时目录）。打不开或不许写 → `denied/trashDenied`；不同卷或不存在 → `invalid/trashUnavailable`。
- 工作进程读 **`ONEDESK_OPEN_LOG`**：设了就不真的打开/显示，而是往这个文件追加一行 `open <路径>` 或 `reveal <路径>`（e2e 用，免得弹出 Finder）。
- **审查后（D433，#13）**：这两个环境变量只在同时设了 **`ONEDESK_TEST_HOOKS=1`** 时生效；正式工作进程里设了也不理。e2e 请三个一起设。
- 内核库里是 `KernelConfig.trash_dir: Option<PathBuf>`（`None` = 系统废纸篓）与 `KernelConfig.opener`；Rust 测试一律用临时目录和记录器。

## 3.4 密钥代入的编码（第二版，API 连接要用）

`{{secret:<名字>}}` 照旧代入原值。新增两种写法，**原值仍不经过插件**，用在 `network.request` 的地址、请求头、正文和 `process.run` 的 `env` 里（凡是原来能写 `{{secret:…}}` 的地方）：

| 写法 | 代入的是 |
|---|---|
| `{{secret:<名字>|basic:<用户名>}}` | `base64("<用户名>:<密钥值>")`（HTTP Basic），例：`Authorization: Basic {{secret:api-pw|basic:alice}}` |
| `{{secret:<名字>|base64}}` | `base64(<密钥值>)`（密钥里已经存着 `user:pass` 时用） |
| `{{secret:<名字>|url}}` | 百分号编码后的密钥值（RFC 3986 的非保留字符以外都编码），用于地址的查询参数（D433） |

- 用户名就是写在里面的明文（不能含 `:` 和 `}}`）；它来自插件，不是密钥。
- 不认识的写法（如 `|rot13`、用户名含 `:`）→ `invalid/badSecretFormat`。名字检查与原来相同（`secretNotAllowed`、`unknownSecret`）。
- 编码后的值与原值**都**从返回的内容、运行输出、进度里抹掉（`***`）。
- base64 是标准字母表、带 `=` 填充（RFC 4648 §4），内核自带实现，没有新依赖。

## 3.6 确认效果的选项（D428，第二版）

`CommandEffect` 的 `confirm` 只增三个可选字段（TS 见生成的 `CommandEffect.ts`、`ConfirmChoice.ts`）：

```ts
{ type: "confirm", message: Label, command: string, danger?: boolean,
  choices?: ConfirmChoice[],      // 1–8 个
  choiceArg?: string,             // 不给 = "conflict"（外壳的默认）
  irreversible?: boolean }
type ConfirmChoice = { id: string, label?: Label, danger?: boolean };
```

- 外壳显示这些选项（没有 `label` 时用外壳自己的 `overwrite`/`skip`/`keepBoth` 文字），用户选了就以 `args: { confirmed: true, [choiceArg]: id }` 再调一次 `command`；取消就什么都不做。`irreversible: true` 时对话框写明不可撤销。
- 内核只转发，不解释选项。**新**：插件命令可以返回 `confirm` 了（之前一律拒绝），条件是它的 `command` 是**本插件自己的命令**（`<本插件id>:<命令>`）；否则、或 `choices` 为空、超过 8 个、`id`/`choiceArg` 不是 1–64 个字母数字 `_` `-`、`choiceArg` 为 `"confirmed"` → 命令失败 `pluginError`（`badEffects`）。`pick-folder` 仍不能由插件命令返回（插件用 `files.addRoot`）。
- 内核自己的 `run.delete`、`deleted.purge` 确认现在带 `irreversible: true`。

## 3.7 页面动作的 `command`（D429，第二版）

- 清单 `contributes.pages[].actions[]` 多一个可选字段 **`command`**（本插件 `contributes.commands` 里的短名），与 `action` 二选一：
  - 两个都写 → 清单无效，原因 **`actionAndCommand`**；
  - `role` 不是 `run`/`save-run` 而写了 `command` → 同样 `actionAndCommand`；
  - `command` 不是本插件声明过的命令 → **`unknownCommand`**（已有码）；
  - `run`/`save-run` 两个都没写 → 照旧 `missingAction`。
- 协议 `ActionDecl` 多一个可选字段 **`command?: string`**，是**全名** `<插件id>:<命令>`（`page.resolve` 的 `actions` 里）。有它时没有 `action`。
- 外壳点击时调 `command.execute { id: command, context: { target: <页面>, tabId, args: <页面上各输入框的当前值> } }`，按返回的效果处理（含 3.6 的确认与重新调用）。`save-run` 先保存再执行命令。

## 3.8 提供树节点的菜单、拖动、可放入（D430，第二版）

插件提供的树（`source: "provided"`）的 `children` 返回的节点，除已有的 `key/label/icon/expandable/target/badge` 外，可以带：

```js
{ key, label, icon, expandable?, target?, badge?,
  menu?: string[],       // 命令 id：本插件的（短名或 "<插件id>:<命令>"），或内核的 node.open（D432：其它 node.* 一律丢弃）
  draggable?: boolean,   // 不给 = false
  accepts?: string[] }   // 原样转给外壳（最多 32 项，每项 1–128 字符）
```

- `tree.children` 的 `TreeNode.menu` 里是对应的 `MenuCommand`（本插件命令用它清单里的文字和图标，`id` 为全名）；重复的只留一个，最多 32 项。别的插件的命令、没声明的命令、不认识的 `node.*` **丢掉**，并写一条插件警告（工作进程的标准错误 `onedesk: plugin <id>@<版本>: …`，同一条只写一次；没有界面）。
- 不给 `menu`：与之前相同（有 `target` 就只有 `node.open`）。给了 `menu`（包括空数组）就完全照它，不再自动加 `node.open`。
- 拖放、“移动到/复制到”、就地改名由外壳按命令 id 结尾的 `:move`、`:copy`、`:rename` 接通（D430，约定见 `plugins/README.md`）；内核不解释，执行时照常走 `command.execute`。
- 资源类型提供的子节点（`kinds.children`，D375）也接受这三个键，但**忽略**（那里的节点不由插件拖放）。

## 3.9 动作“失败但保留输出”（D435）

动作处理函数的返回值多一个可选字段 `failed`（宿主接口的 JSON，不是协议类型，没有 TS 生成）：

```js
return { output: { type: "table", … }, summary: { message: "exit 2" }, failed: { message: "exit code 2" } };
return { failed: { message: "timed out" } };   // 不给 output：用最后一次 runs.partial（没有就没有输出）
```

- 有 `failed` 时：`output` 照常按声明的类型检查（不合格照旧 `badOutput`），`output`、`summary` 照常保存（数据文件输出同样）；运行状态是 **`error`**，`error = { code: "pluginError", message }`，与插件抛错时同一个码。
- `message` 按这次运行读过的密钥值抹除（`***`），超过 **2000 个字符**截断。
- 运行记录、历史（`run.listFor`）、`run.get` 的 `output`、`run.rows`、`run.render`（结果视图页签）、保留结果，都与成功的运行一样能用。
- 没有 `failed` 时 `output` 仍是必填（缺了 → `badOutput`）。
- `actions.call` 调用别的插件的动作时，`failed` 只是返回数据的一部分，原样交给调用方（D435：所以不用 `error` 这个名字）。

## 3.10 页面动作的 `ignoreRequired`（D436）

- 清单 `contributes.pages[].actions[]` 与协议 `ActionDecl` 各增一个可选字段 `ignoreRequired?: boolean`。
- 内核只校验它是布尔值（不是布尔值时插件加载失败，原因 `schema`），在 `page.resolve` 的 `actions[]` 里原样透传；没写时不出现。
- 有 `ignoreRequired: true` 的动作，外壳不检查任何必填（D436 ②）；参数字段只拦 run / save-run（D436 ①）也是外壳的事，内核不变。

## 3.5 程序的查找与时长（第二版）

- 清单 `requires.programs[].searchPaths` 可以写 **`~/` 开头**的路径（如 `~/.docker/bin`），按当前用户的家目录展开（不支持 `~其他用户`）。
- 从 `searchPaths` 找到的程序（含 `~/`），若它自己或它上面的任何一层文件夹**属于 root 和当前用户以外的人，或别人可写，或组可写而组不是 0（wheel）**（审查 #6），就不用它；链接本身和它所在的各层文件夹（不跟随）也要满足；通过检查后执行的是**真实路径**：`process.ready` 为 `{ ready: false, reason: "unsafeLocation" }`，`process.run` 抛 `denied/unsafeLocation`（`params.program`）。固定的系统目录（`/usr/bin` 等）不受影响。这是第十五轮审查 #15 的补上。
- `process.run` 的 `timeoutMs` 上限从 10 分钟提到 **2 小时**（`7200000`）；默认仍是 60 秒，长任务请显式写 `timeoutMs`。`transfer.capture` 的上限也从 1 小时提到 2 小时。取消照旧立即结束。等程序的时间不算进动作的 60 秒（D355，不变）。

## 4. X6 搜索（`search.query`、插件的 `resources.search`）

接口不变，只是行为：

- 按空白切成词，**所有词都要满足**。
- 3 个字符以上的词走全文索引（trigram，名字、描述、标签、正文）。
- 更短的词（1–2 个字符）走模糊匹配：名字里**按顺序出现这些字符**（中间可以隔别的字，如 `ab` 匹配 `a-x-b`），或正文等里含这个子串。不分大小写（ASCII）。
- 排序不变（名字命中 → 收藏 → 最近使用）。“任一词命中、按相关度排序”留到 AI 那一轮。

## 5. 新原因码（外壳需配文字的）

| 码 | 出现在 | 含义 |
|---|---|---|
| `conflict/exists` | `files.mkdir/copy/move/writeText`（已有码，新场景） | 目标已存在 |
| `invalid/intoItself` | `files.copy/move` | 复制或移动到它自己（里面） |
| `invalid/isRoot` | `files.move/trash/remove` | 不能移动或删除授权文件夹本身 |
| `invalid/trashUnavailable` | `files.trash` | 这个位置没有废纸篓（那个卷不支持，或测试用的废纸篓文件夹不在、不同卷） |
| `denied/trashDenied` | `files.trash` | 不许把它移到废纸篓（权限、只读卷）；外壳英文已加 |
| `notFound/grant` | `files.removeRoot`、`plugin.replaceFolder` | 不是已授权的文件夹 |
| `invalid/badOutput` | `runs.partial` | 部分输出的格式不对 |
| `actionAndCommand` | 插件加载失败原因（插件页） | 页面动作同时写了 `action` 和 `command`，或非 run 项写了 `command`（D429） |
| `invalid/badSecretFormat` | `network.request`、`process.run` | `{{secret:…|…}}` 的写法不认识 |
| `denied/unsafeOpen` | `files.open` | 这个文件打开时会运行程序，所以不打开（D432；外壳英文已加） |
| `denied/unsafeLocation` | `process.run`、`process.ready` 的 `reason`、程序不可用的提示 | 找到的程序在别人可改的位置，不用它（**外壳的 `kernel-texts.test.ts` 要求为它配文字**） |

运行结果里的 `stopped`（`timeout`、`maxLines`）是插件自己拿到的值，由插件配文字。
