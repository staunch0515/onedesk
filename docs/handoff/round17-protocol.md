# 第十七轮：协议与宿主接口新增的确切名字（内核会话）

其它会话照这里写。协议（`crates/protocol`）只增不改；生成的 TS 已更新（`LineTone.ts`、`TextAppearance.ts`、`PluginReplaceFolderParams.ts`，以及 `ViewNode`、`RunOutput`、`Run`、`CommandEffect` 的新可选字段）。决定编号留给主会话（提议见 `round17-kernel-done.md`）。

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
  - 列名写错内核不报错，外壳按 `default`/最后一列处理。
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

  - 最后一行没有换行也算一行。每个流的总字节仍受 8 MB 限制（超出 `truncated: true`，后面的行不再收）。
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

审计摘要：`files.copy`/`files.move` 为 `{ from, conflict }`（`object` 是最终写到的路径；`skip` 跳过的不记），`files.mkdir`、`files.trash`、`files.remove` 为 `{}`（`object` 是原路径）。被拒绝的调用照旧另记一行（结果 `failed:denied`）。

所有路径规则同已有的 `files.*`：绝对路径须在授权文件夹里（符号链接解析后逐段比较），相对路径是插件自己的 `plugin-data/<id>/`。两个路径的操作（`copy`、`move`）两边都按这个规则检查（可以在两个授权文件夹之间）。**授权文件夹本身**不能被 `move`、`trash`、`remove`（`invalid/isRoot`）。写操作都进审计（`op` 即方法名，`object` 为路径，摘要见表），成功后发插件所提供的树的 `tree:<树>` 主题（同 `writeText`）。事件处理函数里只能用只读的 `list/stat/readText/find`，其余 `denied/notInRun`。

| 方法 | 返回 | 说明 |
|---|---|---|
| `files.mkdir(path, { recursive? })` | 新文件夹的 `Entry` | 已存在 → `conflict/exists`；上级不存在且不给 `recursive: true` → `notFound/path` |
| `files.copy(from, to, { conflict? })` | `{ path, skipped }` | 文件或文件夹（递归；文件夹里的符号链接按链接复制，不跟随）。`to` 是目标的完整路径（不是目标文件夹）。`path` 是最终写到的路径 |
| `files.move(from, to, { conflict? })` | `{ path, skipped }` | 改名也用它（同一文件夹里换名字）；跨卷时复制后删除 |
| `files.trash(path)` | `{ path }`（在废纸篓里的位置） | 移到废纸篓；废纸篓里已有同名的就按“保留两份”起名。不在同一卷上 → `invalid/trashUnavailable` |
| `files.remove(path)` | `null` | **永久删除**（文件夹递归）。内核不再确认，二次确认由插件（`Confirm` 效果）和外壳做 |
| `files.open(path)` | `null` | 用系统默认程序打开 |
| `files.reveal(path)` | `null` | 在 Finder 中显示（选中它） |
| `files.find(path, query, { limit?, offset? })` | `{ entries: Entry[], next }` | 在文件夹里递归按**文件名**找（不跟随符号链接，跳过 `.` 开头的文件夹）：`query` 按空白切成词，每个词都要是文件名的子串（不分大小写）。`limit` 默认 200、最多 1000；最多看 100000 个条目（看到上限时结果多 `capped: true`） |
| `files.addRoot()` | `null` | 让外壳弹出选择文件夹的对话框（`CommandEffect` `pick-folder`），用户选了就是授权（D184） |
| `files.replaceRoot(path)` | `null` | 同上，但效果带 `replace: path`；外壳选好后调 `plugin.replaceFolder` |
| `files.removeRoot(path)` | `{ folders }`（剩下的授权文件夹） | 移除一个授权文件夹（只缩小权限，不删任何资源和文件）；不在列表里 → `notFound/grant` |

`conflict`（同名处理）取值：

| 值 | 目标已存在时 |
|---|---|
| `"fail"`（默认） | 抛 `conflict/exists`，什么都不动 |
| `"overwrite"` | 先删掉目标（文件夹整个删），再写 |
| `"skip"` | 什么都不做，返回 `{ path: to, skipped: true }` |
| `"keepBoth"` | 换一个名字：`name 2.ext`、`name 3.ext`…（与 Finder 相同），返回新路径 |

- `from` 与 `to` 相同、或把文件夹复制/移动到它自己里面 → `invalid/intoItself`。
- `open`、`reveal`、`addRoot`、`replaceRoot` 不进审计（不改任何东西）；`removeRoot` 进审计（见 3.2）。

### 3.2 授权文件夹的增、查、改、移除（外壳）

已有（不变）：`plugin.grants`（查）、`plugin.grantFolder`（增）、`plugin.revokeFolder`（移除）。

- **新增** `plugin.replaceFolder`：`PluginReplaceFolderParams { plugin, path, newPath }` → `PluginGrants`。`newPath` 的检查同 `grantFolder`（绝对、存在的文件夹、不碰数据目录）；新文件夹占旧的位置；`newPath` 已在列表里时只删掉旧的。旧的不在列表里 → `notFound/grant`。
- **新增** `CommandEffect` `pick-folder` 的可选字段 `replace?: string`：有它时外壳选好文件夹后调 `plugin.replaceFolder { plugin, path: replace, newPath }`，否则照旧调 `plugin.grantFolder`。
- **审计**：增、改、移除每次一行：`plugin.grantFolder`、`plugin.replaceFolder`、`plugin.revokeFolder`，`object` 为插件 id，摘要 `{ folder }`（改为 `{ folder, from }`）。移除授权不删资源和文件（资源照旧在树里，只是插件读不到那里的文件了）。
- 授权变化后照旧发 `plugins` 和该插件所提供的树的 `tree:<树>` 主题。

### 3.3 废纸篓位置（测试用）

- 正式：`~/.Trash`。
- 工作进程读环境变量 **`ONEDESK_TRASH_DIR`**（测试、验收用）：设了就把它当废纸篓（须是已存在的文件夹，且与要删的文件在同一卷，例如临时目录）。
- 工作进程读 **`ONEDESK_OPEN_LOG`**：设了就不真的打开/显示，而是往这个文件追加一行 `open <路径>` 或 `reveal <路径>`（e2e 用，免得弹出 Finder）。
- 内核库里是 `KernelConfig.trash_dir` 与 `KernelConfig.opener`；Rust 测试一律用临时目录和记录器。

## 4. X6 搜索（`search.query`、插件的 `resources.search`）

接口不变，只是行为：

- 按空白切成词，**所有词都要满足**。
- 3 个字符以上的词走全文索引（trigram，名字、描述、标签、正文）。
- 更短的词（1–2 个字符）走模糊匹配：名字里**按顺序出现这些字符**（中间可以隔别的字，如 `ab` 匹配 `a-x-b`），或正文等里含这个子串。不分大小写（ASCII）。
- 排序不变（名字命中 → 收藏 → 最近使用）。“任一词命中、按相关度排序”留到 AI 那一轮。

## 5. 新原因码（外壳需配文字的）

| 码 | 出现在 | 含义 |
|---|---|---|
| `conflict/exists` | `files.mkdir/copy/move`（已有码，新场景） | 目标已存在 |
| `invalid/intoItself` | `files.copy/move` | 复制或移动到它自己（里面） |
| `invalid/isRoot` | `files.move/trash/remove` | 不能移动或删除授权文件夹本身 |
| `invalid/trashUnavailable` | `files.trash` | 这个位置不能移到废纸篓（不同卷） |
| `notFound/grant` | `files.removeRoot`、`plugin.replaceFolder` | 不是已授权的文件夹 |
| `invalid/badOutput` | `runs.partial` | 部分输出的格式不对 |

运行结果里的 `stopped`（`timeout`、`maxLines`）是插件自己拿到的值，由插件配文字。
