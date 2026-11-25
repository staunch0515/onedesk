# 插件开发规范（spec）

本文是 OneDesk 插件的**开发标准**：包的结构、清单的每个字段、宿主接口、视图树、权限、多语言、错误、沙箱限制、版本与升级、命名。照本文写的插件应能一次通过 `pnpm plugin:check` 和验收（见 [acceptance.md](acceptance.md)）。

本文与代码不一致时**以代码为准**，并请记到 `docs/handoff/todo.md`。依据的代码：

| 内容 | 代码 |
|---|---|
| 清单字段与拒收原因 | `crates/kernel/src/manifest.rs`（`parse_package`） |
| 视图树、运行输出、错误码 | `crates/protocol/src/lib.rs`（TS 生成在 `src/workbench/protocol/generated/`） |
| 宿主接口 | `crates/kernel/src/sandbox.rs`（`BOOTSTRAP` 里的 `makeHost`）、`crates/kernel/src/host.rs` 及 `network.rs`、`process.rs`、`carry.rs`、`round18.rs`、`calls.rs`、`secrets.rs`、`install.rs`、`reach.rs` |
| 动作返回值的校验 | `crates/kernel/src/runs.rs`（`ActionOut`、`check_output`） |
| 页面返回值的校验 | `crates/kernel/src/pages.rs`（`RenderOut`） |
| 测试辅助 | `plugins/_testing/view-check.ts` |
| 自动规则 | `scripts/check-arch.mjs`、`scripts/check-ui.mjs`、`pnpm plugin:check` |

清单格式、宿主接口、协议的变更由协调会话决定并记入 `docs/decisions.md`（项目规则 10）。**插件作者不能扩展它们**：需要新能力时写到 `docs/handoff/todo.md`，不要绕。

---

## 0. 产品要求（用户定的，每个插件都必须做到）

> 用户 2026-11-24 重申（D466）。这些是 OneDesk 的核心设计，**不是可选项**；写插件、改插件、验收插件都先对照这一节。做不到的，先问用户，不要自己降级。

1. **一切皆资源。** 插件提供的内容都是资源，都有名称、描述、标签、位置、创建/修改时间等基本信息，统一显示在框架的**信息面板**里。插件不得自己再画一份名称/描述字段，也不得让自己的资源页没有信息面板。
2. **每个标签页都能选环境。** 页面默认使用环境（清单不写 `usesEnv` 即为 `true`，内核的默认值）。不用环境的页面要在清单里写 `"usesEnv": false`，这是例外，必须写明理由并经用户同意。用户已同意的例外（2026-11-24）：欢迎页、插件市场的“浏览”页、文件插件的“已授权文件夹”页（后两个是工具页，不是内容）。
3. **插件天生是模板。** 页面内容可以用占位符（如 `{{名字}}`，语法由插件定义）从当前环境取值（`ctx.host.params.get(name)`，项目规则 5）；换一个环境，同一个资源得到不同的结果。这是 OneDesk 的独特之处，每个插件都要想清楚“选了环境之后，我的内容会怎样变”。内置插件共用一份 `template.js`（每个插件包里各放一份相同的副本，`plugins/_testing/template-copies.test.ts` 检查它们一致）：`{{名字}}` 先取本标签页填的值，再取环境的值；`{{secret:名字}}` 不是占位符，永远不显示；页面上用一条“占位符 + 环境值”的字段条（`holeStrip`）告诉用户每个值从哪个环境来。授予网络的字段（如连接地址）不能用占位符，内核按写下的原文授权。
4. **环境参数随便加。** 环境里的参数由用户自由添加：任意名字、任意值，不是从少数几个预设参数里挑。插件只按名字取值，不规定环境里必须有哪些参数。
5. **一个功能只有一个入口。** 操作栏（工具栏）已有的功能，页面内容里不要再放一个同样作用的控件（例如操作栏有“阅读/编辑”切换，页面里就不再放“模式”选择框）。同理，信息面板里已有的名称、说明（描述）、标签，页面内容里不要再放一份。
6. **AI 生成按资源的说明来写。** 不弹对话框收集指令：资源信息面板里的**说明（描述）**是给 AI 的长期背景；“AI 对话”里什么都不写直接发送，就按说明生成。要求每次不同时，在对话框里直接说（D479）。（用户 2026-11-24 重申，“说过多少次了”；2026-11-25 补充：说明只能用一次不够，要能多次对话。）
7. **不要乱加东西，不要加用户看不懂的东西。** 只做用户要的；能在原地直接做的事不要再开一个对话框（例如环境参数直接在参数表里加）；系统内部名字（如 `network.allow`）不要摆到普通界面上让用户挑。

各插件按这些要求逐个审查的结论记在 [`docs/handoff/plugin-review.md`](../handoff/plugin-review.md)。

---

## 1. 总则（硬性规则）

1. 插件只通过 `ctx.host` 与外界打交道。沙箱里没有 `fetch`、`console`、`setTimeout`/`setInterval`、`require`、`process`、`window`、`document`、`localStorage`，也没有 Node 模块；只能 `import "./x.js"` 引入**包内**文件。
2. 插件**不含 CSS、TSX/JSX、HTML**，只返回视图树（§6）。代码里不写颜色、像素、时长，不用 `style`、`className`、`innerHTML`。
3. 所有给人看的文字都是**语言文件里的键**，不在代码或清单里写死（§8）。
4. 密钥只在钥匙串：用密钥字段（`type: "secret"`）和 `{{secret:name}}` 占位符，插件拿不到原值（§7.3）。数据库、清单、存储、输出、错误文字里都不得出现明文密钥。
5. 不声明就没有权限（§7）。只申请真正用到的。
6. 测试只用假宿主、内存数据或临时目录，**绝不访问真实服务**、真实数据目录或真钥匙串（D440）。
7. 不直接调用 AI 服务商插件，不自己画 AI 界面（§11）。
8. 内核、主进程里不得出现任何具体插件的名字；插件之间只通过 `depends`/`exports` 或 `implements`/`uses` 打交道。

---

## 2. 包的结构

### 2.1 源码目录

```
<插件目录>/                 文件夹名 = 清单的 id（官方插件放在仓库的 plugins-external/<id>/）
  manifest.json            必需
  main.js                  必需：ES 模块，default export { activate(host) }
  locales/en-US.json       必需（兜底语言）
  locales/zh-CN.json       官方插件必需；其他语言可选（ja-JP.json …）
  *.js                     可选：被 main.js import 的包内模块
  main.test.ts             必需：vitest 测试，与源码同目录（打包时剔除）
  README.md                可选
  CHANGELOG.md             官方插件必需：每个版本改了什么
  bin/…                    可选：`requires.programs` 里 `source: "plugin"` 的自带程序
```

- 位置：`plugins/` 只放**随应用打包**的最小一组内置插件；其他官方插件放仓库根的 `plugins-external/<id>/`，在本仓库开发、测试，但不随应用打包，以包文件发布。第三方作者在自己的文件夹里用同样的布局。
- 内置插件（`plugins/`）还必须带 `ja-JP`，且三种语言键完全一致（`plugins/_testing/locale-check.test.ts`）。

### 2.2 发布包（`.odplugin`）

| 规则 | 内容 |
|---|---|
| 格式 | zip 文件 |
| 文件名 | `<id>-<version>.odplugin`，如 `org.example.notes-0.2.0.odplugin`；文件名里的 id 和版本必须等于清单里的 |
| 结构 | `manifest.json` 在压缩包**根目录**（没有外层文件夹） |
| 不得包含 | 测试文件（`*.test.*`）、`._*`、`.DS_Store`、符号链接 |
| 大小 | ≤ 200 MB（主进程 `MAX_PACKAGE_BYTES`，按解开后的文件总和） |
| 生成 | 只用 `pnpm plugin:pack <插件目录>` 生成（先跑 `plugin:check`），产物在 `dist/plugins/<id>-<version>.odplugin` |

安装后包被放到数据目录 `~/Library/Application Support/onedesk/plugins/<id>/<version>/`。内核加载时要求文件夹名等于 `id`、版本文件夹名等于 `version`（否则 `idMismatch` / `versionMismatch`）。同一 id 的多个版本可以并存（§9）。

---

## 3. 清单 `manifest.json`

校验严格：**任何未知字段、缺少必填字段、类型不对、引用不存在的东西，整个包都不加载**（插件页上列为“被拒”，带一个稳定的原因码）。写完立即 `python3 -m json.tool manifest.json` 校验 JSON。

### 3.1 顶层字段

| 字段 | 类型 | 必填 | 规则 | 违反时的原因码 |
|---|---|---|---|---|
| `id` | string | 是 | 只能是小写字母、数字、`.`、`-`、`_`；1–128 字符；不以 `.` 开头或结尾；不能是 `core`。约定用反向域名（`org.example.notes`）；官方插件用 `org.onedesk.<名>` | `badId`；与文件夹名不同 `idMismatch` |
| `version` | string | 是 | semver（`0.1.0`、`1.2.0-beta.1`） | `badVersion`；与版本文件夹不同 `versionMismatch` |
| `apiVersion` | string | 是 | 必须是 `"2"`（字符串） | `apiVersion` |
| `name` | string | 是 | 语言键（不是文字） | — |
| `description` | string | 否 | 语言键 | — |
| `icon` | string | 是 | lucide 图标名（kebab-case，如 `sticky-note`） | — |
| `main` | string | 是 | 包内相对路径，以 `.js` 结尾，文件必须存在，不得含 `..` 或绝对路径 | `mainMissing` |
| `author` | string | 否 | 纯文字 | — |
| `license` | string | 否 | 纯文字（官方插件写 `MIT`） | — |
| `homepage` | string | 否 | 纯文字 | — |
| `upgradesFrom` | string | 否 | semver 范围（如 `>=0.1.0 <0.3.0`），见 §9 | `badUpgradesFrom` |
| `requires` | object | 否 | 权限，见 §7 | 见 §7 |
| `depends` | array | 否 | 依赖的其他插件，见 §3.4 | `badDepends`、`undeclaredDepend` |
| `exports` | object | 否 | 给依赖方的能力，见 §3.4 | `badExports` |
| `implements` | object | 否 | 实现的插件接口，见 §3.5 | `badImplements` |
| `uses` | array | 否 | 使用的插件接口，见 §3.5 | `badImplements` |
| `activation` | string[] | 否 | 除“被用到”以外的激活时机；目前只能是 `"workspace.opened"`，不得重复 | `badActivation` |
| `contributes` | object | 否 | 插件提供的东西，见 §4 | 见 §4 |

其他拒收原因：文件不是合法 JSON `badJson`；字段未知、类型不对、缺必填 `schema`；没有 `manifest.json` `noManifest`。

### 3.2 名字的写法

- **短名**（kind、page、tree、command、action、setting 的 `id`/`name`，结果标签页 id、结果区动作 id）：`[A-Za-z0-9._-]`，1–64 字符，**不能含 `:`**。同类里不得重复。违反：`badName` / `duplicate`。
- **全名**：`<插件 id>:<短名>`，如 `org.onedesk.note:note`。清单里写自己的东西用短名，写别人的用全名，写内核的用内核名：命令 `plugin.grantFolder`、`node.newGroup`；树 `resources`（通用资源树）。
- 代码里 `host.resources.create({ kind })` 等既可写短名也可写全名。
- 接口名：`<名字>/<主版本>`，名字 `[a-z0-9._-]+`，版本 1–6 位数字，总长 ≤ 128，如 `onedesk.ai.chat/1`。

### 3.3 文字都是语言键

`name`、`description`、所有 `label`、`newName`、`hint`、`confirm`、`ai.description` 等都是 `locales/*.json` 里的键。内核把它换成多语言标签；找不到翻译时显示键本身（这算缺陷，`plugin:check` 会查出缺键）。

### 3.4 `depends` / `exports`（插件之间的依赖）

```jsonc
"depends": [ { "id": "org.onedesk.datasource", "version": "^0.1" } ],
"exports": {
  "kinds":   [ { "id": "note", "actions": true, "read": true } ],
  "trees":   [ { "id": "library" } ],
  "pages":   [ { "id": "editor" } ],
  "actions": [ "query" ]
}
```

| 字段 | 规则 |
|---|---|
| `depends[]` | 每项只有 `id`、`version`（semver 范围）；不得依赖自己、不得重复；最多 32 项。依赖未安装、未启用或版本不在范围内时，本插件保持关闭（资源仍可见，灰显） |
| `exports.kinds[]` | 每项 `{ id, actions?, read? }`，`id` 是自己的 kind；`read: true` 允许依赖方读这种资源（读不到密钥字段）；`actions: true` 允许依赖方给它加动作 |
| `exports.trees[]` | `{ id }`，只能是自己的 `source: "stored"` 树；依赖方的 kind 可以放进去（`tree: "<你的 id>:<树>"`） |
| `exports.pages[]` | `{ id }`，自己的页面；依赖方的 kind 可以借用（`page: "<你的 id>:<页>"`） |
| `exports.actions[]` | 自己的动作 id（字符串）；依赖方可以 `host.actions.call` 调用。带 `confirm` 的动作不能导出 |

`exports` 只允许 `kinds`、`trees`、`pages`、`actions` 四个键。违反：`badExports`。kind 的 `tree`/`page` 写了别的插件的全名，而那个插件不在 `depends` 里：`undeclaredDepend`。

### 3.5 `implements` / `uses`（插件接口）

内核把接口名当不透明字符串，只比较名字。

```jsonc
// 实现方
"implements": { "onedesk.ai.chat/1": { "actions": ["chat", "models", "test"], "kind": "connection" } },
"exports": { "actions": ["chat", "models", "test"] },
// 使用方
"uses": ["onedesk.ai.chat/1"]
```

- `implements.<接口>.actions`：非空，每个都必须在自己的 `exports.actions` 里，不得重复。
- `implements.<接口>.kind`：可选，自己的 kind 短名，作为调用时的“锚点资源”（如服务商连接）。不写则 `interfaces.call` 不需要资源（D445）。
- `implements.<接口>.kinds`（D487）：可选，更多自己的 kind 短名，这些资源也能把调用带到这个实现者（`interfaces.call(…, { resource })` 按资源的类型找实现者）。不得与 `kind` 重复。
- `uses`：接口名列表，不得重复；它是一项权限（`uses:<接口>`），允许列出实现者、读取实现者的锚点资源（不含密钥）并调用。
- 违反：`badImplements`。

---

## 4. `contributes`

全部可选。各子项都是严格校验（未知字段 → `schema`）。

### 4.1 `kinds`（资源类型）

```jsonc
{
  "id": "memo", "label": "kind.memo", "icon": "file-text",
  "tree": "resources", "page": "editor", "newName": "kind.memo.new",
  "defaults": { "text": "" },
  "fields": { "text": { "type": "longtext" } },
  "draggable": true, "accepts": [], "menu": ["duplicate"],
  "children": false, "drop": false
}
```

| 字段 | 类型 | 必填 | 说明与规则 |
|---|---|---|---|
| `id` | string | 是 | 短名 |
| `label` | string | 是 | 语言键 |
| `icon` | string | 是 | lucide 图标名 |
| `tree` | string | 否 | 出现在哪棵树：`resources`（通用资源树）、自己的 `stored` 树短名、或依赖方导出的树全名。不写则不出现在任何树。未知树 `unknownTree` |
| `page` | string | 否 | 打开时用的页面：自己的页面短名，或依赖插件导出的页面全名。未知 `unknownPage` |
| `newName` | string | 否 | 新建时的默认名（语言键） |
| `defaults` | object | 否 | 新建资源的初始 `body` |
| `fields` | object | 否 | body 字段的声明，键是 body 的键，见下表 |
| `draggable` | bool | 否 | 节点可拖动。放在资源树（`tree: "resources"`）里的类型必须写 `true`：资源由用户放到想放的分组里（D476，`plugins/_testing/kinds-movable.test.ts` 检查） |
| `accepts` | string[] | 否 | 可以放进来的子类型：自己的短名、全名或 `*`。未知 `unknownKind` |
| `menu` | string[] | 否 | 右键菜单命令：自己的命令短名或内核命令。未知 `unknownCommand` |
| `children` | bool | 否 | 代码在存储的子节点之后再补子节点（`host.kinds.handle(kind, { children })`）。必须有 `tree`，否则 `childrenWithoutTree` |
| `drop` | bool | 否 | 拖到它节点上的东西交给代码处理（`host.kinds.handle(kind, { drop })`）。必须有 `tree`，否则 `dropWithoutTree` |
| `embed` | bool | 否 | D481：别的资源用 `![[名称]]` / `![[名称#标题]]` 嵌入它时，显示什么由代码给出（`host.kinds.handle(kind, { embed })`）。不声明时显示成卡片（图标、名称、说明） |
| `place` | bool | 否 | D487：用户把节点拖进、移到这种资源下面，或在它下面新建时，落在哪里由代码决定（`host.kinds.handle(kind, { place })`）。必须有 `tree`，否则 `placeWithoutTree` |

声明了 `refs: true` 的文本字段（D482）：内核在页面视图里给它标上 `refs`，外壳在里面输入 `[[`、`![[` 或 `[[=` 时弹出候选列表。引用的写法是 `[=]路径/名称[#节][|参数]`：`路径` 是上级的名字，从后往前匹配，用来区分同名资源；名字里的 `/`、`#`、`|` 写成 `\/`、`\#`、`\|`。插件不用为此做任何事。

`fields.<键>`：

| 字段 | 说明 |
|---|---|
| `type`（必填） | `text`、`longtext`、`code`、`number`、`boolean`、`date`、`datetime`、`enum`、`secret`、`ref`、`attachment`（D484） |
| `grants` | 只能是 `"network"`，只用于 `type: "text"`：这个字段里网址的主机会放行给插件。要求 `requires.network.fromResources: true`，否则 `grantsUndeclared`；别的值 `badGrants` |
| `secrets` | 只用于 `text`/`longtext`/`code`，不能与 `grants` 同时用：文字里可以写 `{{secret:名字}}`，保存的文字里出现的名字就是用户允许这个资源使用的密钥。违反 `badSecretsField` |
| `refs` | 只用于 `text`/`longtext`/`code`，不能与 `grants` 同时用：文字里的 `[[名字]]` 是对其他资源的引用。`type: "ref"` 的字段不能再带 `refs`/`grants`。违反 `badRefsField` |
| `label` | 字段名（语言键），显示在引用面板等处 |
| `accept` | 只用于 `type: "attachment"`，必填，目前只能是 `["image"]`。附件字段不能带 `refs`/`secrets`/`grants`。违反 `badAttachmentField` |

- `type: "secret"` 的字段由框架直接写进钥匙串；资源里只存 `{ "secret": "<名字>" }`，插件永远拿不到值，也不能写它。
- 带 `grants`、`secrets` 或 `type: "secret"` 的字段是**受保护字段**：插件不能改（只有用户能改），升级迁移也不能改（§9）。

### 4.2 `pages`（页面）

```jsonc
{
  "id": "editor",
  "actions": [
    { "id": "count", "role": "run", "action": "count", "label": "action.count", "icon": "hash", "primary": true, "shortcut": ["Mod", "Enter"] },
    { "id": "save", "role": "save", "label": "action.save", "icon": "save", "shortcut": ["Mod", "S"] }
  ],
  "resultTabs": [ { "id": "out", "type": "output", "label": "tab.output" } ],
  "recompute": false, "usesEnv": true, "startup": false
}
```

| 字段 | 说明 |
|---|---|
| `id`（必填） | 短名 |
| `actions` | 页面的按钮，见下表；同页内 id 不得重复（`duplicate`） |
| `resultTabs` | 结果区标签页 `{ id, type, label, icon? }`，`type` 是 `output`、`history`、`view`；id 是短名且不重复 |
| `recompute` | 绑定内容停止变化约 300 ms 后带草稿重新 `render`（实时预览） |
| `usesEnv` | 页面使用环境（显示环境选择）。**默认 `true`**（D466）；只有经用户同意的例外才写 `false` |
| `startup` | 启动且没有标签页时打开的独立页面。每个插件最多一个；这个页面不能被任何 kind 或 tree 使用。违反 `badStartup` |

页面按钮 `pages[].actions[]`：

| 字段 | 说明 |
|---|---|
| `id`（必填） | 页内唯一；`role: "event"` 时它就是发给 `onEvent` 的事件名 |
| `role`（必填） | `run`：运行 `action` 指定的动作；`save`：保存资源（**保存内容的唯一方式**）；`save-run`：先保存再运行；`event`：发页面事件给 `onEvent`；`command`：执行命令 |
| `label`（必填） | 语言键 |
| `icon`、`primary`、`danger`、`shortcut` | 可选；`shortcut` 如 `["Mod", "S"]` |
| `action` | `run` / `save-run` 必须有（否则 `missingAction`），必须是自己的 `contributes.actions` 里的 id（否则 `unknownAction`） |
| `command` | 代替 `action`：自己的命令短名；只能配 `role: "run"` 或 `"save-run"`；不能与 `action` 同时写（`actionAndCommand`）；未知 `unknownCommand` |
| `ignoreRequired` | `true` 时外壳在这个按钮前不检查必填字段 |

外壳把前 4 个按钮显示出来，其余放进“更多”。必填字段（视图字段 `required: true`）在 `run`、`save-run` 前由外壳检查，`save` 前不检查。

### 4.3 `actions`（动作：会“运行”的东西）

```jsonc
{ "id": "count", "label": "action.count", "icon": "hash", "kinds": ["memo"], "output": "text",
  "shortcut": ["Mod", "Enter"], "saveFirst": false, "confirm": null, "ai": null }
```

| 字段 | 说明 |
|---|---|
| `id`、`label`（必填） | 短名、语言键 |
| `output`（必填） | `table`、`text`、`link`、`none`；动作返回的 `output.type` 必须与之相同（否则运行失败 `badOutput`） |
| `kinds` | 适用的资源类型（自己的短名，或依赖插件导出的 kind 全名）。不写 = 不绑定资源（可在命令面板运行）。未知 `unknownKind` |
| `icon`、`shortcut` | 可选 |
| `saveFirst` | 运行前先保存 |
| `confirm` | 可选，语言键：外壳运行前先请用户确认。带 `confirm` 的动作不能导出、不能给 AI 用 |
| `ai` | 可选：允许外部 AI 客户端（MCP）运行，见 §4.9 |

一次运行会被记录（历史、审计），可以报告进度和部分输出。

### 4.4 `trees`（插件的树）

```jsonc
{ "id": "files", "label": "tree.files", "icon": "folder", "source": "provided", "page": "node", "toolbar": ["refresh"] }
```

| 字段 | 说明 |
|---|---|
| `id`、`label`、`icon`、`source`（必填） | `source`：`stored`（节点是资源，移动/改名/删除是内核命令）或 `provided`（节点由插件的 `children`/`path` 处理函数按需提供） |
| `page` | 节点打开时的页面（自己的页面短名；未知 `unknownPage`） |
| `toolbar` | 树工具栏上的命令（自己的命令短名或内核命令；未知 `unknownCommand`） |

### 4.5 `commands`（命令）

`{ "id": "duplicate", "label": "command.duplicate", "icon": "copy", "palette": false }`。显示在菜单里；`palette: true` 时也进命令面板。由 `host.commands.handle` 处理（§5.4）。

约定（D430）：provided 树节点菜单里，短名为 `move`、`copy`、`rename` 的命令（全名以 `:move`、`:copy`、`:rename` 结尾）由外壳接到拖放、“移动到/复制到”和就地改名上。参考 `org.onedesk.files`。

### 4.6 `settings`（插件设置，显示在插件页）

```jsonc
{ "name": "limit", "label": "setting.limit", "type": "number", "default": "100", "hint": "setting.limit.hint" }
```

| 字段 | 说明 |
|---|---|
| `name`、`label`、`type`、`default`（必填） | `type`：`text`、`number`、`boolean`、`enum`、`resource`。`default` **一律是字符串**，且必须是合法值：`number` 能解析成有限数；`boolean` 是 `"true"`/`"false"`；`enum` 是某个选项的 `value`；`resource` 必须是 `""` |
| `options` | 只有 `enum` 有且必须非空：`[{ "value", "label" }]`；其他类型不得写 |
| `kinds` | 只有 `resource` 有且必须非空：自己的 kind 短名、别的插件 kind 全名，或 `@implements:<接口>`（该接口必须在自己的 `uses` 里）；其他类型不得写 |
| `hint` | 可选语言键 |

违反任一条：`badSetting`。代码用 `ctx.host.settings.get(name)` 读，得到字符串。

### 4.7 `menus`

`{ "new": ["memo"] }`：“新建”菜单里的条目，必须是自己的 kind（否则 `unknownKind`）。

### 4.8 `locales`、`languages`、`events`、`resultActions`

| 键 | 说明 |
|---|---|
| `locales` | `{ "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" }`。写了就必须有 `en-US`（`localeMissing`）；每个文件必须存在于包内且是 `{ "键": "文字" }` 的平面 JSON（`badLocale`）。见 §8 |
| `languages` | 语言包插件专用：`[{ "locale", "name", "shell": "shell/<locale>.json" }]`，翻译外壳自己的文字。最多 64 个；`locale` 是 BCP 47（字母数字和 `-`，≤ 35）；`name` 非空 ≤ 100 字；`shell` 是包内 `.json` 文件；不得重复。违反 `badLanguages`。参考 `org.onedesk.lang.zh-cn` |
| `events` | 订阅的事件，只能是 `resource.changed`、`run.ended`，不得重复（`badEvents`）。用 `host.events.on` 注册处理函数 |
| `resultActions` | 加到别的运行结果区的按钮：`{ id, label, icon?, outputTypes, action }`；`outputTypes` 非空不重复（`table`/`text`/`link`/`none`）；`action` 必须是自己的**不带 `kinds`** 的动作。违反 `badResultActions`。被点时动作的 `input.runId` 是那次运行，只有这次点击期间能 `runs.read` 它（D439） |

### 4.9 给外部 AI 客户端（MCP）的动作：`actions[].ai` 与 `aiTools`

```jsonc
"ai": { "readOnly": true, "description": "ai.runDesc",
        "params": [ { "name": "since", "type": "text", "required": true, "description": "ai.since" } ],
        "describe": "describeParams" }
```

- `readOnly` 必须为 `true`；带 `ai` 的动作不得有 `confirm`（违反 `badAiAction`）。
- `params` 最多 32 个；`name` 以字母或 `_` 开头、只含字母数字 `_`、≤ 64、不重复；`type` 是 `text`、`number`、`boolean`，或带非空 `options` 的 `enum`；可选 `required`、`description`、`options`、`default`（字符串）。
- `describe`：本插件另一个动作的 id（不能是自己，那个动作的 `ai` 也不能再有 `describe`），用来说明某个资源的参数。
- `contributes.aiTools[]`：`{ name, description, inputSchema, action, freeQuery? }`。`name` 小写字母开头、只含小写字母数字 `_`、≤ 40、不含 `__`、不重复；`inputSchema` 顶层必须是 `type: "object"`，只能用 `type`、`properties`、`items`、`required`、`additionalProperties`（布尔）、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`description`、`default`、`title`；`action` 必须是自己的、带 `ai`、不带 `kinds` 的动作。违反 `badAiTools`。
- 内核在 AI 运行里只允许读：写资源、写文件、改设置、`plugins.*`、`ui.*`、明文密钥、非 GET 请求、传输都被拒（`denied`，`reason: "aiRun"`）；只返回用户标记“AI 可见”的资源。详见 `docs/redesign/ai-interface.md`。

---

## 5. 入口与处理函数

### 5.1 `main.js`

```js
export default {
  activate(host) {
    // host 只用来注册处理函数；activate 里不能调用宿主方法（没有正在进行的调用，会被拒 callEnded）
    host.pages.handle("editor", { render, onEvent, save });
    host.actions.handle("count", async (ctx, input) => ({ output: { type: "text", text: "…" } }));
    host.commands.handle("duplicate", async (ctx, context) => [ /* 效果 */ ]);
    host.trees.handle("files", { children, path });
    host.kinds.handle("memo", { migrate, children, drop });
    host.events.on("resource.changed", async (ctx, event) => {});
  },
};
```

- 只能注册清单里声明过的名字；注册未声明的（页面、动作、命令、树、kind、事件，或没声明 `children`/`drop` 的 kind 的这两个处理函数）会让激活失败（`denied`）。
- 处理函数可以是 async；返回值必须能 JSON 序列化，内核严格校验（未知字段即 `pluginError/badOutput`）。

### 5.2 `ctx`

每次调用都有一个新的 `ctx`，**只在本次调用的异步链上有效**（存起来给别的调用用会被拒 `staleContext`；调用结束或超时后再用会被拒 `callEnded` / `timeout` / `cancelled`）。

| 字段 | 何时有 |
|---|---|
| `target` | 总有：`resource:<id>`、`new:<kind>`、`node:<树>/<key>`、`page:<插件>/<页>`、`run:<id>` 等 |
| `resource` | 资源页、绑定资源的动作：`{ id, kind, name, description, tags, body, parentId, … }`。**只读**（被冻结）；密钥字段只有 `{ secret: "<名字>" }` |
| `draft` | 页面：未保存的绑定值，`{ "body.text": "…" }`（键是 bind 路径；密钥字段被剔除） |
| `params` | 页面与动作：`param: true` 字段的当前值（字符串表） |
| `node` | provided 树节点页：`{ tree, key }` |
| `run` | 运行结果页的 `render`：那次运行（含 `input`、`params`）；这时表单应设为只读 |
| `row` | 表格行按钮触发的 `onEvent`：那一行的 `rowKeys` 值（否则行号） |
| `runId`、`envId` | 动作运行时 |
| `locale` | 界面语言，如 `zh-CN`（可能没有，按 `en-US` 处理） |
| `host` | 宿主接口（§7） |
| `t(key)` | 返回该键的 `Label`：字符串，或 `{ "en-US": "…", "zh-CN": "…" }` |
| `progress(fraction, message)` | 动作里报告进度（0–1，可省略；文字自己翻译）；不是宿主调用，取消后静默丢弃 |
| `cancelled()` | 同步返回本次运行是否已被取消；长循环里要检查 |

### 5.3 页面处理函数 `host.pages.handle(id, { render, onEvent?, save? })`

- `render(ctx)` → `{ view, values?, basis?, title?, icon?, breadcrumb?, readOnly? }`（只能有这些键，`RENDER_KEYS`）。`view` 是视图节点数组（§6）；`breadcrumb` 每项 `{ label, key? }`。
- `onEvent(ctx, event)` → `{ changes?, params?, message? }` 或 `undefined`。`changes`：bind 路径 → 新值，外壳写进草稿（仍未保存；只接受本页显示的、非受保护的字段）；`params`：新的页面参数（每个值是字符串）；`message`：提示（`Label`，可直接给 `ctx.t(...)`）。
- `save(ctx, changes, basis)`：只有**不编辑资源**的页面（`node:`、`page:` 目标）才会被调用，返回 `{ basis? }`。资源页的保存由内核做：表单字段 `bind: "body.x"` 经写入管线（权限 → 事务 → 修订 → 审计 → 事件）写进资源 body。

### 5.4 动作处理函数 `host.actions.handle(id, async (ctx, input) => …)`

`input` 是运行时的输入快照：页面的绑定值（`{ "body.text": "…" }`，**不含密钥字段**）；结果区动作还有 `input.runId`。取值顺序建议：`input` → `ctx.draft` → `ctx.resource.body`（见 §12 示例的 `textOf`）。

返回值只能有 `output`、`summary`、`failed`、`data`：

| 键 | 说明 |
|---|---|
| `output` | 必须有（除非给了 `failed`）。`type` 必须等于清单的 `output`：<br>`{ type: "text", text, format?: "plain"\|"markdown", lineTones?, appearance?: "plain"\|"terminal" }`<br>`{ type: "table", columns: [{ key, label, numeric? }], rows: [[…]], total?, truncated?, appearance?, toneColumn?, lineColumn? }`（行数上限 10 000，多的被截断并标 `truncated`）<br>`{ type: "link", label, target, params? }`（`label` 是纯文字，要自己翻译）<br>`{ type: "none" }` |
| `summary` | 可选 `{ rows?, message? }`（`message` 是纯文字，自己翻译） |
| `failed` | 可选 `{ message }`：标记运行失败但保留 `output`/`summary`（例如程序非零退出但有有用输出）；不给 `output` 时保留最后一次部分输出。`message` 最长 2000 字 |
| `data` | 可选，任意 JSON（≤ 1 MB），只交给 `actions.call` / `interfaces.call` 的调用方，不随运行保存（D441） |

动作输入、参数、输出各不超过 8 MB。抛出错误即运行失败（§10）。

### 5.5 命令 `host.commands.handle(id, async (ctx, context) => effects)`

`ctx` 只有 `target`、`locale`、`host`、`t`。`context`：`{ tree?, nodeKey?, target?, tabId?, args?, locale? }`。返回效果数组（或 `undefined` = 无）：

| 效果 | 字段 |
|---|---|
| `open` | `{ type: "open", target, params?, envId? }`（`target` 必须是合法目标） |
| `toast` | `{ type: "toast", message: Label, tone?: "success"\|"info"\|"warning"\|"danger" }` |
| `rename` / `reveal` | `{ type, tree, key }` |
| `close-target` | `{ type: "close-target", target }` |
| `confirm` | `{ type: "confirm", message, command, danger?, choices?, choiceArg?, irreversible? }`：确认后带 `args.confirmed = true` 再执行 `command`；`command` 只能是自己的命令全名；`choices` 1–8 个 `{ id, label?, danger? }` |
| `copy` | `{ type: "copy", text }` |
| `reload` | `{ type: "reload" }` |
| `openExternal` | `{ type: "openExternal", url }` |

命令不能返回 `pick-folder`（申请文件夹请用 `host.files.addRoot`）。命令执行后，本插件的 provided 树会被重新询问。

### 5.6 树 `host.trees.handle(id, { children, path })`（provided 树）

- `children(ctx, parentKey, offset)` → `{ nodes, next? }`。`parentKey` 为 `null` 是顶层；`next` 是下一批的 offset，不给表示没有了。每个节点只能有 `key`、`label`、`icon`、`expandable`、`target?`、`badge?`、`menu?`（自己的命令 id 或 `node.*`）、`draggable?`、`accepts?`（`TREE_NODE_KEYS`）。
- `path(ctx, key)` → 从顶层到该节点的 key 数组（用于定位）。

### 5.7 kind 处理函数 `host.kinds.handle(kind, { migrate?, children?, drop?, embed? })`

- `migrate(body, fromVersion, ctx)`：升级接管旧版本资源时调用（§9），返回新 body 或 `null`（不变）。这是纯计算：只能读（`resources.get/list`、`files` 读、`params`、`storage.get/keys/readFrom`、`settings.get`、`process.ready`），写会被拒 `pureCall`。
- `children(ctx, node, own)`：清单 `children: true` 才可注册，补充子节点；参考 `org.onedesk.collection`。
- `drop(ctx, event)`：清单 `drop: true` 才可注册；只能 `resources.update`（随 drop 一起写入），其他写被拒 `inDrop`；参考 `org.onedesk.composite`。
- `place(ctx, { node, before })`（D487）：清单 `place: true` 才可注册。`ctx.resource` 是父资源，`node` 是 `{ id, kind, name }`（新建时 `id` 为 `null`），`before` 是用户想放在它前面的兄弟（`null` = 最后）。返回 `{ before }`（放在哪个兄弟前面，`null` = 最后）或 `{ refuse: Label }`（拒绝，提示用户）。纯计算（只能读，可以 `resources.tree`、`interfaces.call`），1 秒内不返回或返回不对，就按用户拖的位置放。只对用户的操作生效；插件自己 `resources.create/move` 不经过它。参考 `org.onedesk.book` 的 `book.js`。
- `embed(ctx, { section, args })`（D481；`args` 是 D487）：清单 `embed: true` 才可注册。`args` 是调用方给的参数（`sequence` 的项、`host.resources.embed`），原样交来，最多 4 KB。别的资源写了 `![[名称]]`（`section` 为 `null`）或 `![[名称#标题]]` 时调用，返回 `{ view, sectionMissing? }`：`view` 只能有 `text`、`table`、`link`、`image`、`sequence` 节点（只读，序列化后最多 512 KB），`ctx.resource` 是被嵌入的资源，`ctx.envId` 是显示它的标签页的环境（`{{名字}}` 照常用 `host.params.get` 取值）；找不到那一节时返回 `{ view: [], sectionMissing: true }`。Markdown 正文的插件按标题取节，参考 `org.onedesk.note` 的 `sectionOf`。

### 5.8 事件 `host.events.on(name, async (ctx, event) => …)`

只能订阅 `contributes.events` 里的。事件处理函数不能联网、不能运行程序、不能改文件（`notInRun`）；它写的资源不会再触发本插件的事件。

---

## 6. 视图树（`render` 返回的 `view`）

内核严格校验每个节点：未知节点类型或字段 → `pluginError/badOutput`。只有四种节点。测试里用 `checkView(view)`（`plugins/_testing/view-check.ts`）检查，空数组 = 合法。

### 6.1 `form`

| 字段 | 必填 | 说明 |
|---|---|---|
| `type: "form"`、`id` | 是 | `id` 在视图内唯一 |
| `layout` | 是 | `"strip"`（一行）或 `"stack"`（竖排） |
| `label` | 否 | `Label` |
| `fields` | 是 | `ViewField[]` |

`ViewField`（只能有这些键）：

| 字段 | 说明 |
|---|---|
| `name`（必填） | 字段名 |
| `label`（必填） | `Label`（直接给 `ctx.t("…")`） |
| `kind`（必填） | `text`、`longtext`、`code`、`number`、`boolean`、`date`、`datetime`、`enum`、`secret`、`time`（`HH:MM[:SS]`，UTC）、`ref`（值是资源 id）、`multi`（从 `options` 里选多个，值是选中项的 `value` 按 `options` 的顺序用 `,` 连起来，所以 `value` 里不能有逗号；D477） |
| `bind` | 编辑的页面值：资源页是 `name`、`description`、`tags`、`body.<键>`；其他页面是 `values` 里的名字。外壳负责未保存标记、⌘S、关闭前询问 |
| `param` | `true`：运行参数，只在标签页状态里，不保存 |
| `options` | `[{ value, label }]`（`enum`、`ref`、`multi`） |
| `presets` | 日期/时间字段的快捷值 `[{ value, label }]` |
| `fill` | `code`/`longtext` 占满剩余高度 |
| `language` | `code` 字段的着色语言 |
| `hint`、`placeholder` | `Label` |
| `envValue`、`envSource` | 来自环境的值和来源名（只显示） |
| `readOnly`、`required`、`maxLength` | 只读；必填（外壳检查，内核不查）；最多字符数 |
| `kinds` | `ref` 字段可指向的 kind（全名，或本插件短名） |

### 6.2 `text`

| 字段 | 说明 |
|---|---|
| `type: "text"`、`id`、`text`（必填） | `text` 是字符串 |
| `mono`、`language` | 等宽；代码着色语言 |
| `tone` | `default`、`muted`、`danger` |
| `format` | `plain`（默认）或 `markdown`（CommonMark，无 HTML；链接只认 http/https/mailto；支持 `[[名字]]` 引用） |
| `lineTones` | 每行一个：`default`、`muted`、`success`、`warning`、`danger`、`stderr` 或 `null` |
| `appearance` | `plain` 或 `terminal`（终端外观） |

### 6.3 `table`

| 字段 | 说明 |
|---|---|
| `type: "table"`、`id`、`columns`、`rows`（必填） | `columns: [{ key, label, numeric? }]`（`label` 是纯字符串）；`rows` 是值的数组的数组 |
| `rowTargets` | 与 `rows` 等长，点行打开的目标；`null` = 不打开 |
| `rowKeys` | 与 `rows` 等长的字符串（≤ 1000 字），作为 `ctx.row` 交回 |
| `rowActions` | 每行的按钮，最多 4 个 `{ id, label, icon? }`；点击发送名为 `id` 的页面事件 |
| `selectParam` | 让用户在表格里**选一行**（D474）：一个视图状态参数名 `view.<名字>`（必须同时有 `rowKeys`）。点一行（或用方向键移到行上按空格/回车）就把它设为那一行的 `rowKeys` 值，那一行显示为选中；`render` 和 `onEvent` 的 `ctx.params` 里都能读到。操作栏的按钮作用于“选中的那一行”时用它，不要另放一个选择框（§0.5） |

### 6.4 `link`

`{ type: "link", id, label: Label, target }`，`target` 是 `resource:<id>` 等目标。

### 6.4b `image`（D484）

`{ type: "image", id, blob, alt?, width? }`：显示一张存在工作区里的图片。`blob` 是文件号（附件字段值里的 `blob`），内核检查它确实存在；界面只为“用到它的资源”读取它，所以插件只能显示自己资源（或正在嵌入的资源）的图片。`width` 是 `small`、`medium`（默认）、`large`、`original`。

**附件字段**（`fields.<键>.type: "attachment"`）：值是 `{ blob, name?, type, size, width?, height? }` 或 `null`。在 `render` 里把它写成 `kind: "attachment"` 的表单字段，外壳会画成放图片的区域：拖入、粘贴，或者用系统对话框选择文件。插件不能上传文件，也读不到文件内容。声明了 `refs: true` 的文本字段里，`![说明](blob:文件号)` 是正文里的图片，粘贴截图时外壳会自动写进去。参考 `org.onedesk.image`。

### 6.4c `sequence`（D487）

`{ type: "sequence", id, items, toc?, mode?, start?, positionEvent? }`：一串条目一个接一个地读（一本书或其中一章）。
- `items[]`：`{ key, title, level, resource?, args?, book? }`。`key` 不重复（≤ 1000 字）；`title` ≤ 500 字；`level` 1–9（标题大小、目录栏缩进）；有 `resource` 的项，外壳在标题下面显示它的嵌入视图（`resource.embed`，带 `args`，≤ 4 KB），嵌入里的 Markdown 标题下移到这一项之下；`book: true` 表示这一项是一本子书的开头。资源已不在的项只显示标题。最多 20 000 项。
- `toc`：左边显示目录栏，点了跳过去，当前位置高亮。`mode`：`scroll`（默认，连续，只加载看得见的部分）或 `pages`（一屏一项，“上一页/下一页”和左右键）。`start`：先显示的项。
- `positionEvent`：读者在某一项停下 1 秒后，外壳发这个页面事件，`ctx.row` 是那一项的 `key`（不能以 `view.` 开头）。
- 可以出现在嵌入视图里；嵌套最多 3 层，更深的只列标题。参考 `org.onedesk.book` 的 `toc.js`。

### 6.4a `conversation`（D479）

`{ type: "conversation", id, turns, input?, targetTab? }`：一段对话，外壳画成一轮一轮的发言，最下面是输入框。
- `turns[]`：`{ role: "user" | "assistant", text, caption?, actions?, steps? }`。`steps` 是回答前查过的东西（最多 20 个）`{ label, detail?, failed? }`，外壳画成可展开的小字行。`text` 是 Markdown（用户的话按原样显示）；`caption` 是下面一行灰色小字（模型、token）；`actions` 最多 4 个按钮 `{ id, label, icon? }`，点了发送以 `id` 为名的页面事件，`ctx.row` 是这一轮的序号（和表格的 `rowActions` 一样）。
- `input`：`{ name, send, placeholder? }`。输入框里的文字是运行参数 `name`（不能以 `view.` 开头），回车运行页面上 `id` 为 `send` 的操作，Shift+回车换行；新的一轮出现时输入框清空。
- `targetTab`：从这个页面开始的运行带上那个标签页的当前值（`input["target.draft"]`，不含密钥）和信息面板里写的说明（`input["target.description"]`）；标签页没开着时不带。
- 同一页面上的表格不再撑满页面，按行数显示。

### 6.5 界面状态

**页面的视图状态（D467）**：不由字段显示、只属于这个标签页的状态（例如笔记的“阅读/编辑”），用名为 `view.<名字>` 的页面参数保存。页面事件可以在返回的 `params` 里设置它（不需要对应的字段），之后 `render` 和 `onEvent` 的 `ctx.params` 里都有它；它**不会**交给运行。值是字符串，最长 1000 个字符。操作栏的切换按钮就用它，页面里不要再放同作用的控件（§0.5）。

插件自己负责用这四种节点表达**空状态、错误状态、加载/未就绪状态**：例如没有数据时给一条 `tone: "muted"` 的 `text` 说明下一步；出错时给 `tone: "danger"` 的 `text`；需要用户先授权文件夹或配置连接时说明并提供按钮（页面 `event`/`command`）。颜色、间距、明暗主题由外壳和设计 token 负责，插件不管。

---

## 7. 宿主接口 `ctx.host` 与权限 `requires`

### 7.1 权限一览

不声明就不允许。安装或升级时用户看到权限列表；列表变了要重新确认（指纹按权限原子计算）。

| 声明 | 允许 | 权限原子 |
|---|---|---|
| `"files": true` | `host.files.*`，且**只在用户为本插件授权的文件夹里**（路径规范化、解析符号链接，`..` 和相似前缀被拒；数据目录内一律拒绝） | `files` |
| `"network": { "hosts": ["api.example.com"], "fromResources": true }` | `host.network.request` 和 `transfer.download/upload` 访问这些主机，和/或本插件资源里 `grants: "network"` 字段写的主机。主机写法：`host`、`host:port`、`*.domain`、IPv4；只能小写字母数字 `-` `.`（否则 `badHost`）。本机/链路本地地址默认拒绝，除非资源明确写出该主机和端口（D308）。工作区和环境可以用 `network.allow` 再收窄 | `network:<主机>`、`network:@resources` |
| `"secrets": { "names": ["token"], "plaintext": false }` | 可用的密钥**名字**，以 `{{secret:名字}}` 占位符写在网址、请求头、请求体和程序环境变量里，由宿主代入，插件拿不到原值。名字 `[A-Za-z0-9._-]{1,128}`（否则 `badSecretName`）。`plaintext: true` 是另一项更强的权限：可以 `host.secrets.get` 读原值（官方插件不应申请） | `secrets:<名字>`、`secrets.plaintext` |
| `"programs": [{ "name": "psql", "source": "system", "searchPaths": ["/opt/homebrew/bin"] }]` | `host.process.run` / `transfer.capture` 运行这些程序（按名字）。`name` `[A-Za-z0-9._-]{1,64}` 不重复；`source: "system"` 在固定系统目录（`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`、`/usr/local/bin`、`/opt/homebrew/bin`）加 `searchPaths`（绝对路径或 `~/…`，≤ 8 个，无 `.`/`..`，最多一个 `*`）里找，不能写 `path`；`source: "plugin"` 必须写 `path`（包内相对路径）。违反 `badPrograms`。`process.allow` 可按工作区/环境收窄 | `programs:<名字>` |
| `"resources": true` | `host.resources.search` 读**所有**资源的基本信息（名字、类型、位置，不含 body）；`host.resources.tree` 读一个资源下面的整棵子树（D487） | `resourcesAll` |
| `"contents": true` | `host.resources.embed` 读别的资源被嵌入时显示的内容（D487）；`files.writeBlob` 可以写任何资源用到的图片 | `contents` |
| `"plugins": { "install": true }` | `host.plugins.list`、请用户安装其他插件。只允许 `install` 一个键（否则 `badPlugins`） | `plugins` |
| `uses: [...]`（顶层） | 调用这些接口 | `uses:<接口>` |
| 动作 `kinds` 里写别的插件的 kind | 读那种资源、给它加动作（需对方 `exports`） | `resources:<全名>` |
| kind 借用别的插件的页面 | 那个插件的代码能读这种资源 | `pages:<全名>` |

读写**自己的** kind 的资源不需要声明。读别的插件的 kind 需要对方 `exports` 且自己 `depends`。插件自己的数据文件夹 `plugin-data/<id>/`（相对路径）不需要 `files` 权限。

### 7.2 方法参考

所有方法都返回 Promise。失败时抛出 `Error`，带 `code`（`conflict`、`denied`、`invalid`、`notFound`、`invalidParams`、`unknownMethod`、`pluginError` …）和 `params`（如 `params.reason`）。“仅运行中”= 只能在动作的执行里调用，其他地方被拒 `denied/notInRun`。

**resources**（自己的 kind 无需权限）

| 方法 | 参数 → 返回 | 说明 |
|---|---|---|
| `get(id)` | → 资源或 `null` | 别的插件的资源：对方导出可读时返回（无密钥字段），否则 `denied/foreignKind` |
| `list({ kind?, parent? })` | → 资源数组 | 不给 `kind` = 自己所有 kind；`parent: null` = 顶层 |
| `create({ kind, name?, description?, tags?, body?, parent? })` | → 新资源 | `kind` 必须是自己的；`body` 不给则用 `defaults`，`name` 不给则用 `newName` |
| `update(id, changes, basis?)` | → `{ rev }` | `changes` 是 bind 路径 → 值（`{ "body.text": "…", "name": "…" }`）；给 `basis`（rev）时有冲突抛 `conflict`；受保护字段不能写 |
| `upsertByKey(kind, items, { othersMissing? })` | → 报告 | 按外部键批量新建/更新，`items` 每项只能有 `key`、`name`、`description`、`body`、`parent`；≤ 5000 项；键 1–1024 字、不重复（`badKey`/`duplicateKey`）；`othersMissing: true` 把没出现的标为“来源已不在” |
| `move(id, { parent? } \| { before })` | → `null` | |
| `remove(id)` | → `null` | 进回收站 |
| `search(opts)` | → 结果 | 需 `requires.resources`；`{ query, kinds?, limit? }` 按相关度返回 `[{ id, kind, name, snippet, score }]`；或基本搜索 `{ text, kinds, tags, … }` |
| `tree(id, { offset?, limit? })` | → `{ nodes: [{ id, name, kind, icon, depth, parent, rev }], next }` | D487：需 `requires.resources`；按树的顺序（先父后子）列出 `id` 下面的全部节点，`depth` 从 1 开始；每次最多 2000 个，`next` 接着读；不含正文 |
| `embed(id, { section?, args? })` | → 和外壳的 `resource.embed` 一样（`view`、`name`、`refs`…） | D487：需 `requires.contents`；按调用所在标签页的环境 |
| `kinds()` | → `[{ kind, label, icon }]` | 需 `requires.resources`；资源树里能有的所有类型（已启用的插件，`kind` 是全名，`label` 是 Label），供“按类型”的条件让用户勾选，不要让用户手写类型全名（D477） |

插件拿到的资源还带 `externalKey` 和 `missing`。

**files**（需 `requires.files`，或相对路径 = 自己的 `plugin-data/<id>/`）

| 方法 | 说明 |
|---|---|
| `roots()` | 已授权的文件夹 |
| `list(path, opts?)`、`stat(path)`、`readText(path)`、`find(path, query, opts?)` | 读 |
| `writeText(path, text, { basis?, executable?, conflict? })` | 写；返回 `{ basis, path, skipped }` |
| `mkdir(path, { recursive? })`、`copy(from, to, opts)`、`move(from, to, opts)`、`trash(path)`、`remove(path)` | 改；事件处理函数里不能用 |
| `open(path)`、`reveal(path)` | 用系统打开/在访达中显示；只限授权文件夹 |
| `writeBlob(blob, path)` | D487：把工作区里存着的一个文件（图片）写到授权文件夹 → `{ path }`。文件号必须被本插件自己的资源用到（有 `requires.contents` 时任何资源都可以）；不覆盖已有文件（`conflict/exists`）；`path` 没有扩展名时按图片类型补上（`.png`、`.jpg`、`.gif`、`.webp`）；事件处理函数里不能用 |
| `addRoot()`、`replaceRoot(path)`、`removeRoot(path)` | 请用户选择/替换文件夹（系统对话框，用户的选择即同意）；结果稍后以插件事件和树刷新到达 |

**network**（需 `requires.network`）

`request({ url, method?, headers?, body?, timeoutMs?, stream?, onChunk?, idleTimeoutMs?, maxBytes? })` → `{ status, headers, body, truncated }`。

- 方法：`GET`（默认）、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS`；只认 http/https。
- 不能设置 `host`、`content-length`、`transfer-encoding`、`connection` 请求头（`invalid/forbiddenHeader`）。
- 网址、请求头、请求体里的 `{{secret:名字}}` 由宿主代入；回答里出现的密钥值被替换成 `***`。跳到别的主机时凭据和代入的密钥不会带过去。最多 5 次跳转。
- 时限：默认 30 秒；非运行中最长 60 秒；运行中最长 10 分钟。响应体最多 8 MB。
- 流式（仅运行中）：`stream: true` + `onChunk(text)`，按块交回文字（自己解析 SSE/NDJSON），两块之间默认最长 120 秒无数据即超时（`idleTimeoutMs` ≤ 600 000）；总量默认 8 MB、最多 64 MB（`maxBytes`）。用 `runs.partial({ type: "text", text })` 把已生成的文字推给界面。
- 事件处理函数里不能联网（`notInRun`）。拒绝原因：`notRequested`、`hostNotAllowed`、`blockedByPolicy`、`localAddress`、`secretNotAllowed`、`badUrl`、`badMethod`、`timeout`。

**process**（需 `requires.programs`）

- `ready(name)` → `{ ready: true }` 或 `{ ready: false, reason }`。任何地方可用。
- `run({ program, args?, env?, cwd?, stdin?, timeoutMs?, lines?, maxLines?, onOutput? })` → `{ code, signal, stdout, stderr, truncated, … }`。参数 ≤ 256 个、总长 ≤ 256 KB；环境变量不得是 `DYLD_*`/`LD_*`；stdin ≤ 8 MB；输出各 ≤ 8 MB；默认时限 60 秒，最长 2 小时；同时最多 4 个。`onOutput(chunk)` 逐块交回输出。等待程序的时间不计入动作的时间预算。

**transfer**（仅运行中）

- `download({ url, to, overwrite?, timeoutMs?, onProgress? })`：网址 → 文件（需 network；`to` 是相对路径 = 自己的数据文件夹，或授权文件夹里的绝对路径，后者需 `files`）。
- `upload({ from, url, method?: "POST"\|"PUT"\|"PATCH", … })`：文件 → 网址。
- `capture({ program, args?, to, … })`：把程序输出写进文件（需 programs）。
- 默认时限 10 分钟，最长 2 小时；等待时间不计入动作预算。

**secrets**：没有读取方法（只用占位符）。`get(name)` 仅在声明 `plaintext: true` 时可用，否则 `denied/plaintextUndeclared`。

**settings**：`get(name)` → 字符串（未设置时是 `default`）。只能读自己声明的（`denied/undeclaredSetting`）。

**params**：`get(name)` → `{ found, value, sourceName }`，从当前环境链按名字取值；`config(name)` → 同样形状，从工作区配置取。占位符语法由插件自己定义，核心只按名字取值。

**storage**（插件自己的键值存储，按版本分开）：`get(key)`、`set(key, value)`（JSON 值；`null` = 删除）、`remove(key)`、`keys()`；`readFrom(version, key)` 只能在 `migrate` 里用（读旧版本的值）。键 1–200 字；单个值 ≤ 256 KB；每个版本最多 1000 个键、共 16 MB。

**runs**

| 方法 | 说明 |
|---|---|
| `partial(output)` | 仅运行中：推送部分输出（与最终输出同形） |
| `read(runId)` | 仅结果区动作里、只能读被点的那次运行 → `{ output, meta }` |
| `saveArtifact(runId, { name, kind, data })` | 在运行旁保存东西（≤ 1 MB，密钥被替换）；只在结果区动作里，或页面事件里给已有自己附件的运行 |
| `listArtifacts(runId)`、`getArtifact(id)`、`deleteArtifact(id)` | 只看得到自己的 |

**actions**：`call("<插件 id>:<动作>", input, { resource? })` → 对方动作的返回值（含 `data`）。仅运行中；对方必须在自己的 `depends` 范围内且 `exports.actions` 里有它（否则 `denied/notExported`）；对方动作绑定 kind 时必须给该 kind 的资源（`wrongKind`）；调用深度 ≤ 4 且不得成环（`callDepth`）。对方失败时抛 `pluginError`，`params.reason = "calleeFailed"`，`message`/`detail` 是对方错误文字的第一行（密钥已替换）。

**interfaces**（需在 `uses` 里，否则 `denied/notUsed`）

| 方法 | 说明 |
|---|---|
| `list(接口)` | → `[{ plugin, kind, label }]`，已启用的实现者 |
| `resources(接口)` | → 实现者锚点资源 `[{ id, name, kind, fields }]`（不含密钥） |
| `call(接口, 动作, input, { resource?, plugin? })` | 接口有锚点 kind 时给资源 id（按资源的类型找实现者，`kind` 和 `kinds` 都算）；`plugin`（D487）直接指定实现者。没有实现者 `invalid/noImplementation`；资源不是该接口的 `invalid/wrongInterface`。**不在运行中**（页面、嵌入、`place` 里，D487）也能调用：对方以纯计算方式执行（只能读，写被拒 `pureCall`），5 秒内返回，结果是 `{ data }` |

**events**：`on(name, handler)`，只在 `activate` 里注册（§5.8）。

**plugins**（需 `requires.plugins.install`）：`list()`；`requestInstall({ folder })` 只在页面事件或运行中（`notInteractive`），文件夹必须在本插件可读的范围内；被拒后 30 秒内再请求 `conflict/cooldown`。

**ui**

| 方法 | 说明 |
|---|---|
| `open(target)` | 打开目标（`invalid/badTarget`） |
| `notify(message, tone?)` | 提示，`message` 是 `Label` |
| `copy(text)` | 复制到剪贴板 |
| `openExternal(url)` | 用系统打开 http/https/mailto（≤ 2048 字）；只在运行中或页面事件里（`notInteractive`），每次调用最多 5 次（`tooMany`） |

**util**：`sleep(ms)`（≤ 10 000；沙箱里没有计时器，等待用它）。

### 7.3 密钥的正确用法

1. kind 里声明一个 `type: "secret"` 字段（如 `apiKey`），页面上用 `kind: "secret"` 的表单字段绑定它。用户输入后由框架写进钥匙串，资源里只存 `{ secret: "<名字>" }`。
2. 发请求时写占位符：`headers: { "x-api-key": "{{secret:<名字>}}" }`，名字从 `ctx.resource.body.apiKey.secret` 取。可选编码：`{{secret:名字|base64}}`、`{{secret:名字|url}}`、`{{secret:名字|basic:<用户名>}}`（HTTP Basic）；其他写法 `invalid/badSecretFormat`。
3. 可用的名字 = `requires.secrets.names` 里声明的 + **本次调用所关于的资源**（`ctx.resource`，必须是自己的 kind）里保存的密钥名字。名字不在其中 `denied/secretNotAllowed`；钥匙串里没有 `denied/unknownSecret`。
4. 永远不要把密钥写进 `storage`、资源 body 的普通字段、输出、`summary`、错误文字或日志。

---

## 8. 多语言

- 文字放 `locales/<locale>.json`：平面 `{ "键": "文字" }`，值都是字符串。
- `en-US` 必需，是兜底；官方插件还必须有 `zh-CN`；内置插件（`plugins/`）还必须有 `ja-JP`。
- **所有语言文件的键完全相同**，每个键的 `{占位}` 也相同。清单里用到的每个键都必须在 `en-US` 里。
- 代码里用 `ctx.t(key)` 取 `Label`。要拼成纯文字（`summary.message`、`output.label`、`throw new Error(...)`、资源名）时用这个小工具（各官方插件同款）：

```js
export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}
```

- 能直接给 `Label` 的地方（视图字段的 `label`、`hint`、`placeholder`，`onEvent` 的 `message`，`ui.notify`）直接给 `ctx.t(key)`，外壳按语言显示。
- 内核不含界面文字；内核错误由外壳按 `code` 配文字。

---

## 9. 版本、升级与 `upgradesFrom`

- `version` 用 semver。改了行为就升版本：修复升 patch，加功能升 minor，不兼容（字段改名、body 结构变化）升 major 或在 0.x 里升 minor。
- 同一 id 的多个版本可以同时安装。每个资源绑定创建它的版本，由那个版本的代码处理。
- **激活版本**：新安装的、已确认权限的更高版本会自动成为激活版本（除非用户把插件固定在某个版本）。权限比已确认的多时要用户重新确认，确认前不会切换。
- **接管数据**：切换激活版本时，新版本接管旧版本资源的条件是旧版本号满足新版本的 `upgradesFrom` 范围**且**低于新版本（`Plugin::upgrades_from`）。不写 `upgradesFrom` = 不接管任何旧资源，旧资源留在旧版本上。
- 接管时对每个资源调用新版本的 `host.kinds.handle(kind, { migrate(body, fromVersion, ctx) })`：返回新 body，或 `null`/不注册 = body 不变。`migrate` 是纯计算（只读）；可以用 `storage.readFrom(旧版本, key)` 读旧版本的存储。**任何一个资源迁移失败（抛错、返回非对象），整批都不接管**（`pluginError/migrateFailed`）。迁移不能改受保护字段（`denied/grantField`）；`secrets` 文字字段可以改，但其中的密钥名字集合不能变。
- 接管是一批，可以撤销（插件页“撤销升级”）。手动切回旧版本会把插件固定在那个版本。
- 删除的版本移到数据目录 `plugins/.removed/<id>/<version>-<毫秒>`，不会真删。
- 推荐写法：每次发布都写 `"upgradesFrom": ">=<最早能接管的版本> <<本版本>"`，例如 0.3.0 能接管 0.1 与 0.2 的数据就写 `">=0.1.0 <0.3.0"`，并为变化的 body 写 `migrate` 和测试。

---

## 10. 错误

内核返回 `{ code, params }`，不含文字；外壳按 code 配文字（D219）。插件这一侧的规则：

- `throw new Error(text)`，**不带 `code`**：界面显示 `text` 的第一行。所以 `text` 必须是翻译过的文字（`tr(ctx, "error.x")`），且不得含密钥、令牌、密码。
- 让宿主错误原样冒出去（带 `code` 为 `conflict`、`denied`、`invalid`、`notFound`、`invalidParams`）：外壳显示自己按 code 配的文字，**你的文字不会出现**。想显示自己的说明，就捕获后抛不带 `code` 的 `Error`。
- `actions.call` / `interfaces.call` 的对方失败：见 §7.2 `actions`。不要依赖对方的 `params`。
- 运行失败时，运行记录保存的是替换过密钥的文字。
- 想保留输出又标记失败：返回 `{ output, failed: { message } }`。
- AI 服务商类接口的错误习惯（`onedesk.ai.chat/1`）：返回 `data: { error: { code, message } }` 而不是抛错，调用方按 `code` 处理。

---

## 11. AI 辅助（AI 对话，D479）

AI 辅助由**外壳和 AI 工作台统一提供**（`docs/redesign/ai-chat.md`）。插件**不写任何 AI 代码**：

1. 每个内容页的操作栏自动有 **“AI 对话”**：打开（第一次时新建，放在这个资源旁边）关于这个页面的对话。说明是长期背景，对话框里每次说的是这次的要求；AI 的回答里有对页面的修改时，“应用到”把它放进页面，成为**未保存的修改**，照常保存或撤销。字段旁不再有 ✨。
2. AI 能改的是页面上可编辑的 `text` / `longtext` / `code` 字段（有 `bind`、不是运行参数、不只读）。插件可以在 `render` 返回的字段上加 `assist`，三个属性都可选：
   ```js
   { type: "form", id: "main", layout: "stack", fields: [
     { name: "sql", label: ctx.t("field.sql"), kind: "code", language: "sql", bind: "body.sql",
       assist: { hint: ctx.t("assist.sql"), format: "code:sql" } },     // 告诉 AI 这里写什么、什么格式
     { name: "code", label: ctx.t("field.code"), kind: "text", bind: "body.code",
       assist: { off: true } },                                          // AI 不能改的字段
   ] }
   ```
   `hint` 是给 AI 的说明（用 `ctx.t` 取本地化文字）；`format` 是 `text`、`markdown`、`json` 或 `code:<语言>`，省略时按字段类型推断；`off: true` 时 AI 看得到这个字段（作为背景），但不能修改它。
3. 用户在信息面板里允许“AI 可见”的资源，才会作为资料发给 AI；点“AI 对话”本身就是允许这个页面。资料是拖到对话上的任意资源（内容和在当前环境下最近一次运行的结果）。AI 回答前还可以自己去查（D480）：用的就是外部 AI 客户端经 MCP 用的工具，所以插件想让 AI 能查到什么，就照 §4.9 在动作上写 `ai: { readOnly: true }` 或贡献 `aiTools`，不需要为对话另做什么。
4. 插件**不得**：直接调用 AI 服务商插件或 `uses: ["onedesk.ai.chat/1"]`；自己画 AI 按钮、预览、发送或模型选择；把数据行塞进字段供 AI 读取。
5. 旧接口 `onedesk.ai.generate/1`（只支持 `kind: "sql"`）仍可用，供 SQL 插件这类已有实现；**新插件不要再用**。

**实现 AI 对话的插件**（只有 AI 工作台，规则 10）：实现接口 `onedesk.assist/2`（不带 `kind`），贡献命令 `openChat`（外壳的按钮以页面为上下文运行它：`target`、`tabId`、`args.envId`、`args.name`）。只有它可以：在页面事件结果里返回 `apply: { target, tabId?, label?, values }`（内核只留下目标页面可编辑的文本字段）；调用 `host.tools.list()` / `host.tools.call(name, arguments)`（和 MCP 相同的只读工具，在调用它的标签页的环境里）；调用 `host.pages.fields(target, envId?)`（页面的字段和值，不含密钥；资源须“AI 可见”）和 `host.runs.latest(resourceId, envId?)`（最近一次成功运行的结果）；在 `host.resources.search` 的结果里看到 `aiVisible`。

## 12. 沙箱限制

| 限制 | 值 |
|---|---|
| 内存 | 每个插件版本 32 MB |
| 栈 | 512 KB |
| 一段同步 JS | 1 秒（死循环看门狗） |
| 激活（模块求值 + `activate`） | 10 秒 |
| 每次处理函数调用（render、onEvent、命令、树、迁移…） | 15 秒，含宿主调用 |
| 每次动作运行 | 60 秒；等待 `process.run`、`transfer.*`、长网络请求和用户确认的时间不计入（最多暂停 1 小时） |
| 可用的内置对象 | 只有语言内置：`Date`、`RegExp`、`JSON`、`Map`/`Set`、TypedArray、`Promise`、`eval` |
| 模块 | 只能 `import "./x.js"`（包内 `.js` 文件），不能 `..`、不能绝对路径、不能 node 模块 |

超时或内存超限时该运行时被丢弃，下次使用时重建（重新 `activate`），所以不要依赖模块级变量保存状态；要持久的东西放 `storage` 或资源里。处理函数里没 await 的宿主调用在处理函数结束时被一起结束。

---

## 13. 命名规则汇总

| 东西 | 规则 |
|---|---|
| 插件 id | 小写反向域名，`[a-z0-9._-]`，≤ 128；官方 `org.onedesk.<名>` |
| 插件文件夹 | 等于 id |
| 包文件 | `<id>-<version>.odplugin` |
| kind/page/tree/command/action/setting | 短名 `[A-Za-z0-9._-]{1,64}`，惯用 camelCase 或小写单词 |
| 语言键 | 点分：`plugin.name`、`plugin.description`、`kind.<kind>`、`kind.<kind>.new`、`action.<id>`、`field.<name>`、`error.<what>`、`summary.<what>`、`message.<what>`、`setting.<name>` |
| 文件 | kebab-case；入口 `main.js`；测试 `<源文件>.test.ts` 同目录 |
| 接口 | `<名字>/<主版本>` |
| 提交 | `plugin/<短名>: <做了什么>` + 空行 + 为什么 |

---

## 14. 完整示例：`org.example.wordcount`

一个类型（`memo`），一个页面（`editor`），一个动作（`count`）。这四个文件放在 `plugins-external/org.example.wordcount/` 里能通过测试和清单校验（已在仓库环境下跑过测试）。

`manifest.json`：

```json
{
  "id": "org.example.wordcount",
  "version": "0.1.0",
  "apiVersion": "2",
  "name": "plugin.name",
  "description": "plugin.description",
  "icon": "file-text",
  "main": "main.js",
  "author": "Example",
  "license": "MIT",
  "contributes": {
    "kinds": [
      {
        "id": "memo",
        "label": "kind.memo",
        "icon": "file-text",
        "tree": "resources",
        "page": "editor",
        "newName": "kind.memo.new",
        "defaults": { "text": "" },
        "fields": { "text": { "type": "longtext" } },
        "draggable": true,
        "accepts": []
      }
    ],
    "actions": [
      { "id": "count", "label": "action.count", "icon": "hash", "kinds": ["memo"], "output": "text", "saveFirst": false }
    ],
    "pages": [
      {
        "id": "editor",
        "actions": [
          { "id": "count", "role": "run", "action": "count", "label": "action.count", "icon": "hash", "primary": true, "shortcut": ["Mod", "Enter"] },
          { "id": "save", "role": "save", "label": "action.save", "icon": "save", "shortcut": ["Mod", "S"] }
        ]
      }
    ],
    "menus": { "new": ["memo"] },
    "locales": { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" }
  }
}
```

`locales/en-US.json`：

```json
{
  "plugin.name": "Word count",
  "plugin.description": "Write a memo and count its words.",
  "kind.memo": "Memo",
  "kind.memo.new": "Untitled memo",
  "action.count": "Count",
  "action.save": "Save",
  "field.text": "Text",
  "field.text.placeholder": "Type here…",
  "error.empty": "The memo is empty.",
  "summary.counted": "{words} words, {chars} characters"
}
```

`locales/zh-CN.json`：

```json
{
  "plugin.name": "字数统计",
  "plugin.description": "写一段备忘，统计它的字数。",
  "kind.memo": "备忘",
  "kind.memo.new": "未命名备忘",
  "action.count": "统计",
  "action.save": "保存",
  "field.text": "正文",
  "field.text.placeholder": "在这里输入…",
  "error.empty": "备忘是空的。",
  "summary.counted": "{words} 个词，{chars} 个字符"
}
```

`main.js`：

```js
// Word count plugin: one kind ("memo"), one page ("editor"), one action ("count").
// Runs in the sandbox: no console, timers or fetch; everything outside goes through ctx.host.

// ctx.t(key) gives a Label (a string, or { locale: text }); this turns it into text with {var} filled in.
export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

export function countWords(text) {
  const s = String(text || "").trim();
  return s ? s.split(/\s+/).length : 0;
}

// The text as the person sees it: the run's input, then the unsaved draft, then the saved body.
function textOf(ctx, input) {
  if (input && typeof input["body.text"] === "string") return input["body.text"];
  if (ctx.draft && typeof ctx.draft["body.text"] === "string") return ctx.draft["body.text"];
  const b = ctx.resource && ctx.resource.body;
  return b && typeof b.text === "string" ? b.text : "";
}

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const ro = ctx.run ? { readOnly: true } : {};
        return {
          view: [
            {
              type: "form",
              id: "content",
              layout: "stack",
              fields: [
                { name: "text", label: ctx.t("field.text"), kind: "longtext", bind: "body.text", fill: true, placeholder: ctx.t("field.text.placeholder"), ...ro },
              ],
            },
          ],
        };
      },
    });

    host.actions.handle("count", async (ctx, input) => {
      const text = textOf(ctx, input);
      if (!text.trim()) throw new Error(tr(ctx, "error.empty"));
      const message = tr(ctx, "summary.counted", { words: countWords(text), chars: text.length });
      return { output: { type: "text", text: message }, summary: { message } };
    });
  },
};
```

`main.test.ts`（在 `plugins-external/<id>/` 里，测试辅助的路径是 `../../plugins/_testing/view-check`；在 `plugins/<id>/` 里是 `../_testing/view-check`）：

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { countWords } from "./main.js";
import { RENDER_KEYS, checkActionResult, checkView, onlyKeys, registry, t } from "../../plugins/_testing/view-check";

const ctxOf = (extra: Record<string, unknown> = {}) => ({ target: "resource:r1", locale: "en-US", host: {}, t, resource: { id: "r1", body: { text: "" } }, ...extra });
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("./locales/en-US.json", import.meta.url), "utf8"));
const zh = JSON.parse(readFileSync(new URL("./locales/zh-CN.json", import.meta.url), "utf8"));

describe("word count plugin", () => {
  it("registers exactly what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(manifest.contributes.pages.map((p: any) => p.id));
    expect(Object.keys(r.actions)).toEqual(manifest.contributes.actions.map((a: any) => a.id));
  });

  it("render: a valid view with the text bound to the body", async () => {
    const out = await registry(plugin).pages.editor.render(ctxOf());
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0].fields[0]).toMatchObject({ name: "text", kind: "longtext", bind: "body.text" });
  });

  it("render: a run's page is read only", async () => {
    const out = await registry(plugin).pages.editor.render(ctxOf({ run: { id: "x" } }));
    expect(out.view[0].fields.every((f: any) => f.readOnly)).toBe(true);
  });

  it("count: success, from the run input before the saved body", async () => {
    const res = await registry(plugin).actions.count(ctxOf({ resource: { id: "r1", body: { text: "old" } } }), { "body.text": "one two  three" });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "text", text: "summary.counted" });
    expect(res.summary.message).toBe("summary.counted");
  });

  it("count: fills {words} and {chars} in the run's language", async () => {
    const texts: Record<string, Record<string, string>> = { "summary.counted": { "en-US": "{words} words, {chars} characters", "zh-CN": "{words} 个词，{chars} 个字符" } };
    const ctx = ctxOf({ locale: "zh-CN", t: (k: string) => texts[k] ?? { "en-US": k } });
    const res = await registry(plugin).actions.count(ctx, { "body.text": "a b" });
    expect(res.output.text).toBe("2 个词，3 个字符");
  });

  it("count: an empty memo fails with the plugin's own text", async () => {
    await expect(registry(plugin).actions.count(ctxOf(), { "body.text": "   " })).rejects.toThrow("error.empty");
  });

  it("countWords", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  a\nb\tc ")).toBe(3);
  });

  it("locales: en-US and zh-CN have the same keys and {holes}", () => {
    const holes = (s: string) => (s.match(/\{[a-zA-Z_]+\}/g) ?? []).sort().join();
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) expect(holes(zh[k]), k).toBe(holes(en[k]));
  });
});
```

说明：测试里的 `t` 是 `view-check.ts` 的替身，返回 `{ "en-US": key, "zh-CN": "zh:" + key }`，所以 `tr` 在 en-US 下得到键本身——断言写键名即可。

更多写法可读这些真实插件：`org.onedesk.link`（最小）、`org.onedesk.note`（页面事件、命令、页面参数）、`org.onedesk.prompt`（`param` 字段、实时预览）、`org.onedesk.datasource`（程序、密钥、进度、长运行）、`org.onedesk.ai.anthropic`（`fromResources` 网络、流式、接口实现）、`org.onedesk.catalog`（文件、provided 树、导出）、`org.onedesk.table`（`aiTools`）、`org.onedesk.lang.zh-cn`（语言包）。
