# 第七轮：插件请求安装、本地插件市场、依赖与导出点（协调会话定，2026-11-16）

依据：`dev-plan.md` 阶段 3、5；`kernel-design.md` §7.2、§7.3、§7.5（“安装插件”一段）、§7.6、§13。沿用前六轮的全部约定和共同规则（`round4-plan.md`–`round6-plan.md`、`coordinator-handover.md` §3–§5）。决定 D342–D348 见 `docs/decisions.md`。
本文件里的名字**定死**；协议类型由内核会话按这里的名字“只增”加进 `crates/protocol`（并 `pnpm gen:types`），外壳先按可选字段写。

## 1. 做完是什么样

- 插件树里有内置的“插件市场”（本地）：在它的页面上授权一个放着插件包的文件夹，列出里面每个包的名称、版本、说明、是否已安装；点“安装”后弹出的是**框架的**安装确认框（与手动安装同一个，标题写明“‘插件市场’请求安装…”），列出权限；确认后装上，列表里变成“已安装”；取消则什么都不发生。没声明这项能力的插件请求安装被拒。
- 一个依赖笔记插件的示例插件（`e2e/fixtures/plugins/com.example.note-tools`）：装上后，笔记的操作区多出它提供的动作“统计字数”，结果区显示字数；它能读笔记、不能改笔记。笔记插件停用时它显示“依赖未满足”并且不工作；想停用、移除或切换笔记插件到不满足范围的版本时，被拒并列出依赖它的插件。

## 2. 范围

**做**：宿主能力 `plugins`（`requestInstall`、`list`）；安装请求从内核到界面再回到插件的一来一回；内置插件 `org.onedesk.market`；清单 `depends`、`exports`；依赖是否满足的判断与对切换/停用/移除的限制；导出点里的两种：**给被依赖方的类型加动作**、**读被依赖方的类型的资源**。

**不做（之后）**：导出点的另两种（把自己的类型放进别人的树、用别人的页面和输出类型）；`transfer`；服务器上的市场；`param_decls`；清单缓存；空闲回收；第一版旧库升级；`ai.policy`；D339 的收紧。

## 3. 清单（D342）

```jsonc
"requires": { "plugins": { "install": true } },            // 请求安装别的插件；权限项 id 仍是 plugins
"depends":  [ { "id": "org.onedesk.note", "version": ">=0.1.0" } ],   // 顶层；semver 范围，逗号分隔（D319）
"exports":  { "kinds": [ { "id": "note", "actions": true, "read": true } ] }   // 顶层；只列允许依赖方用的
```

- `depends`：id 不能是自己、不能重复；范围不合法 → `badDepends`。不做传递依赖的自动安装：缺的只提示。循环依赖（A→B→A）两个都算“依赖未满足”。
- `exports.kinds[].id` 必须是本插件自己的类型；`actions: true` = 依赖方可以给它加动作；`read: true` = 依赖方可以读它的资源。未知字段、不是自己的类型 → `badExports`。
- 依赖方的动作声明里 `kinds` 可以写 `"<被依赖插件id>:<kind>"`（全名）；只有该类型被导出且 `actions: true`、并且依赖已满足时才生效，否则这个动作不出现（不报错，插件页的状态原因里写明）。
- 权限：`depends` 不是权限（不用确认）；但依赖方因 `read` 而能读到的类型列在安装确认框的权限里：`PluginPermission.id = "resources"`，`detail` 是 `<插件id>:<kind>` 列表——这算权限，进指纹。

## 4. 依赖（D343–D344，§7.3）

- 满足的条件：被依赖的插件已安装、在本工作区启用、**活动版本**在范围内且已确认。按活动版本判断。
- 不满足时：依赖方状态 `disabled`，原因 `dependsUnmet`（`params.plugin`、`params.range`）；它的代码不激活，它的类型的资源照“插件停用”显示；满足后自动恢复。
- 会让某个**已启用的**依赖方不再满足的操作被拒：切换被依赖方的活动版本（含自动切换——自动切换时不切并记 `switchFailure`，原因 `dependents`）、停用、移除该版本 → `conflict`，`reason: dependents`，`params.plugins` = 逗号分隔的依赖方 id。用户先停用依赖方再来。
- 依赖方加的动作：出现在被依赖类型的页面操作区和右键项里，排在该类型自己的动作之后；运行时操作者是**依赖方**插件，`ctx` 里的资源只读；输出、历史、审计与普通运行相同。动作的 `ctx.host.resources` 对被依赖类型只有读（`get`、`list`），写 → `denied/foreignKind`（已有的原因码）。依赖方不能通过导出点拿到被依赖方的密钥、授权地址、存储。
- `PluginDetail` 只增：`depends: PluginDependency[]`（`{ id, range, satisfied, activeVersion? }`）、`dependents: string[]`（启用着的、依赖本插件的插件 id）。外壳在插件页显示“依赖”和“被依赖”。

## 5. 请求安装（D345–D347，§7.5）

- `ctx.host.plugins.requestInstall({ folder })` → `{ outcome: "installed" | "declined" | "failed" | "expired", id?, version?, reason? }`；`ctx.host.plugins.list()` → `[{ id, name, versions: string[], active }]`（只有基本信息）。两者都要求清单 `requires.plugins.install: true`，否则 `denied/notRequested`。
- `folder` 必须在请求方读得到的地方之内：用户授权给它的文件夹、它的包、它的 `plugin-data` 目录；别处 → `denied/outsideGrant`。可在页面事件处理和运行里调用；渲染、`migrate`、事件订阅处理里 → `denied`。
- 流程：内核只把请求**登记**下来并通知界面，自己不安装、不读包：
  - 方法 `plugin.installRequests` — → `InstallRequest[]`（`{ id, plugin, pluginName: Label, folder, at }`）；主题 `install-requests`（有新请求或请求结束时发）。
  - 界面收到后走与手动安装完全相同的路径：`app.inspectPlugin` → 确认框（标题带请求方的名字）→ `app.installPlugin`；然后调 `plugin.answerInstallRequest`（`{ id, outcome: "installed" | "declined" | "failed", plugin?, version?, reason? }`）把结果告诉内核，内核再交还给等待中的插件。
  - 同一个插件同时只能有一个未答复的请求（再请求 → `conflict/pendingRequest`）；5 分钟没人答复 → `expired`；请求方被停用时它的请求作废。没有界面连着时请求照样登记，等界面来取。
- 审计：`plugin.installRequest`（操作者是请求方插件，对象是文件夹）、答复时 `plugin.installAnswer`（操作者是用户，摘要是结果）；真正的安装仍记 `plugin.install`。
- 插件不能替用户确认：`plugin.answerInstallRequest`、`app.*` 只接受来自界面的调用（操作者是用户），沙箱里没有通到它们的路。

## 6. 本地插件市场（D348）

内置插件 `plugins/org.onedesk.market/`：`requires.files: true`、`requires.plugins.install: true`。提供树 `plugins` 里的一个入口页（或自己的页面，按现有“插件提供页面”的方式；不新增树）。页面：
- 没授权文件夹时：说明 + “选择文件夹…”（走已有的授权文件夹流程）。
- 有文件夹时：扫描 `<文件夹>/*/manifest.json` 和 `<文件夹>/*/*/manifest.json`（即 `<id>/<版本>/`），每个包一行：图标、名称（按语言）、版本、说明、状态（未安装 / 已安装 x.y.z / 可更新）；清单读不了的列为“不可用”并显示原因；“安装”按钮 → `requestInstall` → 按结果刷新并提示。上限 200 个包。
- 它只读清单的展示字段，不解释权限（权限由框架的确认框列）。

## 7. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3–§5 的内核部分 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改） |
| 外壳（Sonnet） | 订阅 `install-requests`，把请求接到现有的安装确认流程（标题带请求方）并回答；插件页“依赖 / 被依赖”两节与“依赖未满足”状态；被拒的切换/停用/移除（`conflict/dependents`）的提示，列出依赖方；依赖方加的动作在操作区的显示（应当不用改，核对）；新增原因码、审计操作名、权限 `resources` 明细的文字 | 同前几轮 |
| 插件与测试（Sonnet） | 第一阶段：`plugins/org.onedesk.market/`（§6，vitest 用假 host）；笔记插件清单加 `exports`（`note`：`actions`、`read`）；`e2e/fixtures/plugins/com.example.note-tools/0.1.0/`（依赖笔记，给笔记加动作“统计字数”，另有一个试图改笔记的动作用来验证被拒）；`e2e/fixtures/market/`（一个放着三个包的文件夹：一个正常的小插件、一个清单有错的、一个已随应用内置的）。第二阶段（合并后）：`e2e/round7.spec.ts` | 同前，另加 `e2e/fixtures/**` |

## 8. 完成标准

- 内核必须有的测试：清单 `depends`、`exports`、`requires.plugins` 的每种拒绝；依赖满足与不满足的每种原因（没装、停用、版本不在范围、未确认、循环）；满足后自动恢复；切换、自动切换、停用、移除因依赖方被拒且列出依赖方，依赖方停用后放行；依赖方的动作只在导出且满足时出现、运行时操作者与只读、写被拒、读不到未导出的类型、拿不到被依赖方的密钥与存储；`read` 进权限与指纹；`requestInstall`：未声明被拒、文件夹范围、登记与主题、三种答复、过期、同时一个、请求方停用后作废、渲染等上下文被拒；`answerInstallRequest` 不能由插件调用；`list`；审计。全部用临时目录。
- 外壳、测试：同前几轮（`pnpm typecheck`、`lint`、`test`、host 的测试与 clippy、假数据模式 `workbench.spec.ts` 全过且截图不变；`e2e/round7.spec.ts` 连真内核跑通）。
- 交接文件：`docs/handoff/round7-kernel-done.md`、`round7-shell-done.md`、`round7-tests-done.md`。内核的交接文件必须列全：新增的错误原因码、审计操作名、清单新增部分、宿主接口的确切签名、协议上“只增”加的类型与字段、新方法与主题。
