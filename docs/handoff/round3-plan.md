# 第三轮：运行、插件状态与设置、命令面板，一个示例插件走通全程（协调会话定）

依据：`dev-plan.md` 阶段 3；`kernel-design.md` §6.1、§7.2、§7.4–7.6、§8、§9。沿用 `week1-protocol.md`、`round2-plan.md` 的全部约定和共同规则。决定 D284–D292 见 `docs/decisions.md`。
类型以 `crates/protocol/src/lib.rs` 末尾“round 3”一段为准（已生成 TS）。

## 1. 做完是什么样

打开应用：资源树里能新建一条“示例查询”（示例插件的类型），页面上有参数条、占满高度的编辑区、“运行 / 保存 / 保存并运行 / 整理”几个动作；在编辑区写 `:name` 停一下，参数条多一项；点运行，结果区先出进度再出表格，状态栏和任务面板有这次运行；能取消一个慢的运行；失败的运行把原因留在结果区；“历史”页签列出这条资源的运行，点一条在新标签页打开那次运行（当时的内容只读）；运行记录树里有全部运行。插件树和插件页是真的：三个插件都列出，能停用（它的资源立即变灰、页面提示已停用、运行被拒绝）再启用，能改设置项，能看到并移除授权的文件夹。命令面板（⌘⇧P）列出内核和插件的命令。

## 2. 范围

**做**：运行（§8，不含定时）；动作与页面事件、内容变化后重算（§9.3）；宿主能力 `params`、`storage`、`settings`、`runs`（进度）；插件状态节点：启用/停用、设置（§6.1、§7.1）；内核自带的插件树、运行记录树；`run:<id>` 页面；命令面板；示例插件；界面对应部分接真协议。

**不做（下一轮）**：安装插件与权限确认、清单缓存、多版本并存与升级/撤销（§7.6）、依赖与导出（§7.3）、宿主能力 `network`、`secrets`、`process`、`transfer`、`events`、`plugins`；策略与保护参数（§6.3）；参数声明 `param_decls`、引用；导出导入；旧库升级；结果的 CSV 导出与 `blobs/`；空闲回收。插件页上的“版本”一栏只列出当前这一个版本。

## 3. 方法（新增，全部要实现）

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `run.start` | `RunStartParams` → `string`（运行 id） | 立即返回；执行在后台。任何失败（未知动作、插件停用、输入不合法、插件出错、输出不符）都是一条 `error` 状态的运行，不是协议错误 |
| `run.get` | `RunIdParams` → `Run \| null` | 带 `output` |
| `run.cancel` | `RunIdParams` → `null` | 结果作废；此后这次调用再发的宿主调用被拒绝（§7.4） |
| `run.listFor` | `ResourceIdParams` → `Run[]` | 该资源的运行，新的在前，不带 `output` |
| `run.tasks` | — → `Run[]` | 进行中的和结束后还没清除的 |
| `run.clearFinished` | — → `null` | |
| `run.setKept` | `RunSetKeptParams` → `null` | 保留的运行不受 200 次限制 |
| `run.render` | `RunRenderParams` → `ViewNode[]` | 页面声明的 `view` 类型结果页签，由插件对这次运行渲染 |
| `page.event` | `PageEventParams` → `PageEventResult` | 带当前未保存的内容调用插件页面的 `onEvent` |
| `plugin.get` | `PluginParams` → `PluginDetail \| null` | |
| `plugin.setEnabled` | `PluginSetEnabledParams` → `null` | 写该插件的状态节点；停用时取消它的运行、丢弃它的运行环境。发 `plugins` 和它涉及的每棵树 |
| `plugin.setSetting` | `PluginSetSettingParams` → `null` | 只接受清单 `settings` 里声明过的名字，按类型校验 |
| `plugin.reload` | `PluginParams` → `null` | 重读清单并丢弃运行环境（开发时用） |
| `command.palette` | — → `PaletteCommand[]` | 内核命令（不需要节点上下文的那些）+ 各启用插件清单里的命令和“新建”项 |

事件：`runs`（任何运行开始、进度、结束）、`run:<id>`。进度事件要节流（同一运行每 100 ms 至多一条）。

`tree.list` 增加内核自带的 `plugins`（每个插件一个节点，目标 `plugin:<id>`，停用的状态为 `disabled`，清单有错的为 `broken` 并带原因）和 `runs`（最近 200 次运行，新的在前，目标 `run:<id>`）。`page.resolve`：`plugin:<id>` → `page: "plugin"`；`run:<id>` → 该运行所属资源的页面，`values` 是这次运行的输入快照，`readOnly: true`，`runId` 有值，面包屑末尾是运行编号；运行所属的资源已不在时仍能打开（用快照）。

内核命令新增：`plugin.enable` / `plugin.disable`、`run.cancel`、`run.keep` / `run.unkeep`、`run.openResource`、`run.reuse`（效果 `open`，带上那次运行的参数——见 §6 的协议补充）。

## 4. 清单的新增部分（D284）

```json
"contributes": {
  "kinds": [{ "id": "query", "…": "…", "page": "editor" }],
  "actions": [
    { "id": "run", "label": "action.run", "icon": "play", "kinds": ["query"], "output": "table",
      "shortcut": ["Mod", "Enter"], "saveFirst": false, "confirm": null }
  ],
  "pages": [
    { "id": "editor", "recompute": true, "usesEnv": true,
      "actions": [
        { "id": "run", "role": "run", "action": "run", "label": "action.run", "icon": "play", "primary": true, "shortcut": ["Mod", "Enter"] },
        { "id": "save", "role": "save", "label": "action.save", "icon": "save" },
        { "id": "save-run", "role": "save-run", "action": "run", "label": "action.saveRun", "icon": "play" },
        { "id": "tidy", "role": "event", "label": "action.tidy", "icon": "align-left" }
      ],
      "resultTabs": [
        { "id": "result", "type": "output", "label": "tab.result", "icon": "table" },
        { "id": "final", "type": "view", "label": "tab.final", "icon": "code" },
        { "id": "history", "type": "history", "label": "tab.history", "icon": "history" }
      ] }
  ],
  "settings": [
    { "name": "rowLimit", "label": "setting.rowLimit", "type": "number", "default": "200", "hint": "setting.rowLimit.hint" },
    { "name": "style", "label": "setting.style", "type": "enum", "default": "upper", "options": [{ "value": "upper", "label": "setting.style.upper" }] }
  ]
},
"author": "…", "license": "MIT", "homepage": "…"
```

- `actions[].output`：`table`、`text`、`link`、`none`。`kinds` 是这个动作适用的类型（短名）；省略表示不绑定资源。`confirm` 是一个文字键：有值时内核对 `run.start` 不做确认——确认由界面在调用前弹出（界面从 `ActionDecl` 得到；见 §6）。
- 页面的 `actions[]`：`role` 为 `run`/`save-run` 时必须有 `action`（指向 `contributes.actions` 的 id）；`event` 的事件名就是这一项的 `id`。没有 `resultTabs` 的页面没有结果区。
- `settings[].type`：`text`、`number`、`boolean`、`enum`。值存在插件状态节点的参数 `settings.<name>` 里；没设过用 `default`。
- 清单仍然严格校验；引用了不存在的动作、类型、页面：不加载。

## 5. 插件代码一侧（D285–D287）

```js
host.actions.handle("run", async (ctx, input) => {
  // ctx: { resource?, target, envId, params, locale, host, t, progress(fraction, message), cancelled() }
  // input: 这次运行的输入快照（按绑定路径，如 input["body.text"]）
  return { output: { type: "table", columns: [{ key, label, numeric? }], rows: [[…]], total }, summary: { rows, message } };
});
host.pages.handle("editor", {
  async render(ctx) { … },                      // ctx.draft：未保存的内容（重算时有）；ctx.run：run:<id> 页面和结果页签渲染时有
  async onEvent(ctx, event) { return { changes: { "body.text": "…" }, message: ctx.t("…") }; },
  async renderResultTab(ctx, tabId) { return [ /* ViewNode */ ]; }     // 对 ctx.run 渲染 `view` 类型的结果页签
});
```

| `ctx.host.` | 方法 | 限制 |
|---|---|---|
| `params` | `get(name)` → `{found, value, sourceName}` | 从这次调用所在标签页的环境沿父链取值；没有环境：`found:false`。`secret` 类型不会出现（本轮内核拒绝存它） |
| `storage` | `get(key)`、`set(key, value)`、`remove(key)`、`keys()` | 按插件、按版本隔离（`plugin_storage`）；单个值上限 256 KB；键最长 200 |
| `settings` | `get(name)` → 文字或 `null` | 只能读自己清单里声明过的 |
| `runs` | —（进度经 `ctx.progress`） | |

- 动作的总时限 60 秒（页面渲染、事件仍是 15 秒）；同步片段看门狗不变。`ctx.progress` 不是宿主调用，被取消后静默丢弃。
- 表格输出：内核只保留前 1000 行（`total` 是插件报的总行数，超出则 `truncated: true`）；单次输出序列化后上限 8 MB，超出是 `badOutput`。
- 取消：`ctx.cancelled()` 返回是否已取消，供插件在循环里自查；宿主调用在取消后被拒绝（错误码 `denied`，`reason: cancelled`）。
- 插件里没有定时器。为了让动作能“慢”，内核提供 `ctx.host.util.sleep(ms)`（上限 10 秒一次；这是设计 §7.4 说的“定时器由内核提供”的最小一步，D287）。
- 运行期间插件被停用或工作进程重启：运行记为 `error`，原因 `pluginDisabled` / `interrupted`。

## 6. 协议补充（外壳与内核都要知道）

- `ActionDecl` 新增可选字段 `action`（完整动作 id）、`confirm`（`Label`）；`PageDescriptor.resultTabs` 来自清单；`recompute`、`usesEnv` 来自清单。（内核会话加，属于“只增”。）
- `CommandEffect::Open` 新增可选的 `params`（`BTreeMap<String,String>`）和 `envId`：打开目标时带上的初始页面状态（§9.1“打开时可带初始页面状态”），`run.reuse` 用它。（内核会话加。）
- 运行参数：页面里 `param: true` 的字段，值在标签页的页面状态里（界面一侧），随 `run.start` 的 `params` 送来；内核把 `params` 原样交给动作（`ctx.params`）并记入运行。
- 重算：页面 `recompute: true` 时，界面在内容停止变化约 300 ms 后带 `context.draft` 调 `page.resolve`；插件的 `render` 据 `ctx.draft` 重新给出参数条。

## 7. 运行的存储与规则（D288–D290）

- 新增迁移建 `runs`（§8 的字段，另有 `seq`、`kept_name`、`in_task_panel`）；运行的开始和结束各写一行审计（经写入管线的同一个写线程，操作者是发起人，动作由插件执行的部分记 `plugin:<id>@<version>`）。
- 每个资源保留最近 200 次；没有资源的运行按动作保留 200 次；保留（kept）的不清理。清理在一次运行结束时做。
- 工作进程启动时把遗留的 `running` 改为 `error`（`interrupted`）。
- 永久删除一条资源时，它的运行记录一并清除（§3.4），并做同样的文件残留清理（D283）。
- 插件停用（D290）：状态节点的参数 `enabled` 为 `false`。停用的插件：它的类型的资源在树里状态为 `disabled`（灰），`page.resolve` 返回 `state: disabled` 且 `readOnly`、视图为空；它的提供树不出现在 `tree.list`；“新建”和命令面板里没有它的项；`run.start` 得到 `pluginDisabled`。数据不动，重新启用即恢复。

## 8. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3–§7 的内核部分 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改） |
| 外壳（Sonnet） | 混合客户端里 `run.*`、`page.event`、`plugin.get/setEnabled/setSetting/reload`、`command.palette` 改走内核；真资源的页面：参数条、动作区（`run`/`save-run`/`event` 角色、`confirm`）、结果区（输出、历史、`view` 页签）、重算；任务面板、状态栏的运行摘要、运行记录树、`run:<id>` 页面、插件树与插件页（版本一栏只读、设置、授权文件夹的列出与移除）、命令面板合并内核与外壳自己的命令；`open` 效果带初始参数；新增 id 的文字。假实现保留给纯假数据模式，有真内核时插件树、运行记录、任务面板、命令面板不再走它（数据源树与 SQL 等演示页面仍是演示） | 同前 |
| 插件与测试（Sonnet） | 第一阶段：示例插件 `plugins/org.onedesk.sample/`（类型 `query`，名称“示例查询 / Sample query”），照原型里 SQL 页的样子：参数条（从正文里的 `:name` 得出，按名字后缀猜类型：`_id`/`limit` 数字、`_time`/`_date` 日期时间，其余文字；环境里有同名参数时显示为占位值和来源）、占满高度的编辑区、动作 运行/保存/保存并运行/整理（事件：把关键字改大写）；运行是假执行：按正文和参数的散列生成固定的表格（行数受设置 `rowLimit` 限制），用 `ctx.progress` 报三四次进度、每步 `util.sleep` 几百毫秒；正文含 `!fail` 时抛错，含 `!slow` 时跑约 20 秒（可取消），含 `!text` 时输出文字；结果页签“最终文本”（把 `:name` 换成值）；用 `storage` 记下最近一次运行的摘要并显示在页面上。带 vitest（假 host）。第二阶段（合并后）：`e2e/round3.spec.ts` 连真内核检查 §1 的每一项并截图 | 同前 |

三个会话并行；内核不许出现示例插件的名字或逻辑。界面外观不得走样：纯假数据模式（`e2e/workbench.spec.ts`）必须继续全过。

## 9. 完成标准

- 内核：`cargo test -p onedesk-kernel -p onedesk-worker`、clippy、`pnpm check:types`。必须有的测试：运行成功/失败/取消各自的记录与事件；`run.start` 立即返回且执行期间内核照常应答；输入快照不受之后修改影响；输出与声明类型不符被拒绝；表格截断到 1000 行；取消后的宿主调用被拒绝；超时；重启后遗留的运行变为 `interrupted`；每资源只留 200 次、保留的不清理；永久删除连同运行一起清除且文件里无残留；停用插件的各项表现与重新启用；设置的校验与默认值；`storage` 的隔离（另一个插件、同插件另一个版本读不到）与大小上限；`params.get` 的继承与无环境；页面事件返回的修改；重算（带 `draft` 的 `render`）；命令面板不含停用插件的命令；清单新增部分的每种拒绝。
- 外壳：`cargo test -p onedesk-host`、clippy、`pnpm typecheck`、`pnpm lint`、`pnpm test`、纯假数据 e2e。
- 交接文件：`docs/handoff/round3-kernel-done.md`、`round3-shell-done.md`、`round3-tests-done.md`。
