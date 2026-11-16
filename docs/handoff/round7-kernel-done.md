# 第七轮——内核：完成记录

分支 `claude/r7-kernel-5806ec`（从协调分支切出，未推送、未合并）。提交：`35698d2`（协议与生成的 TS）、`37c779e`（内核与测试）、本文件一个提交。

## 完成了什么

- 清单：顶层 `depends`、顶层 `exports`、`requires.plugins.install`（`crates/kernel/src/manifest.rs`）。
- 依赖：是否满足按被依赖方的**活动版本**即时判断；不满足 → 依赖方不工作（代码不激活、运行与页面事件被拒、它的类型的资源照“插件停用”显示），满足后**自动恢复**（不存状态，每次现算）；循环依赖两边都不满足（`crates/kernel/src/deps.rs`）。
- 限制：切换（`plugin.activateVersion`、`plugin.setPinned` 引起的切换）、自动切换、停用、移除——会让某个**已启用**的插件不再工作时被拒，`conflict`，`reason: dependents`，`params.plugins` = 逗号分隔的插件 id（按字母序，含间接依赖方）。自动切换被拒时不切，记 `switchFailure.reason = "dependents"`。拒绝都记审计。
- 导出点两种：依赖方给被依赖类型加动作（页面操作区，排在该类型自己的动作之后）；依赖方读被依赖类型的资源（`ctx.host.resources.get` / `list`）。
- 权限：依赖方因导出能读到的类型 → `PluginPermission.id = "resources"`，`detail` 为 `<插件id>:<kind>` 列表（逗号加空格连接，同其他权限），进指纹。`depends` 本身不是权限。
- 宿主能力 `ctx.host.plugins`（`requestInstall`、`list`）；方法 `plugin.installRequests`、`plugin.answerInstallRequest`（外加 `plugin.checkRemove`，见“决定”）；主题 `install-requests`；审计 `plugin.installRequest`、`plugin.installAnswer`。
- `PluginDetail.depends`、`dependents`。

## 测试结果（本会话实际运行）

- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过（内核单元 42、round7 11、其余各轮集成测试、worker 5、protocol 测试均 ok）。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：通过。
- `sh scripts/gen-types.sh --check`：协议类型是最新的。
- `pnpm lint`：架构检查、界面规范检查通过。
- `pnpm typecheck`：通过（新字段在 TS 里可选，外壳假数据无需同时改）。
- 没跑：`pnpm test`（vitest）、e2e、host 的测试——不在本会话范围，也没改它们的文件。

`round7-plan.md` §8 的内核测试与对应位置：

| 要求 | 测试 |
|---|---|
| 清单 `depends`、`exports`、`requires.plugins` 的每种拒绝；动作 `kinds` 写非依赖插件的全名被拒 | `manifest::tests::round7_depends_exports_and_requires_plugins` |
| 依赖满足；不满足的每种原因（没装、停用、版本不在范围、未确认、循环） | `tests/round7.rs`：`a_met_dependency_lists_both_ways`、`each_unmet_reason_turns_the_dependent_off`、`a_disabled_dependency_turns_off_and_coming_back_restores` |
| 满足后自动恢复（停用后再启用；确认权限后） | 同上两条 |
| 切换、自动切换、停用、移除因依赖方被拒并列出；依赖方停用后放行；拒绝进审计 | `switching_disabling_and_removing_a_dependency_are_refused_while_dependents_are_on` |
| 依赖方动作只在导出且满足时出现；运行时操作者是依赖方、资源只读、写被拒（`foreignKind`）；读不到未导出类型；拿不到被依赖方的密钥字段与存储 | `a_dependent_adds_a_read_only_action_to_an_exported_kind`、`nothing_crosses_without_an_export` |
| `read` 进权限与指纹（`depends` 不进） | `a_met_dependency_lists_both_ways`、manifest 单元测试 |
| `requestInstall`：未声明被拒、文件夹范围、登记与主题、三种答复、过期、同时一个、请求方停用后作废、渲染等上下文被拒；`answerInstallRequest` 不能由插件调用；`list`；审计 | `install_requests_are_recorded_answered_and_audited`、`request_folders_stay_inside_what_the_plugin_can_read`、`requests_need_the_declaration_and_a_user_action`、`unanswered_requests_expire_and_die_with_their_plugin` |
| 等用户的时间不计入调用时限 | `waiting_for_the_user_does_not_count_against_the_time_budget` |

## 清单新增部分（D342）

```jsonc
"requires": { "plugins": { "install": true } },   // 只认 {"install": bool}；旧的 "plugins": true → badPlugins
"depends":  [ { "id": "org.onedesk.note", "version": ">=0.1.0, <0.3.0" } ],
"exports":  { "kinds": [ { "id": "note", "actions": true, "read": true } ] }
```

- `depends`：列表，每项只有 `id`、`version` 两个字段；id 合法、不是自己、不重复；`version` 是 semver 范围（逗号分隔）；最多 32 项。任一不符 → `badDepends`。
- `exports`：对象，只有 `kinds`；每项只有 `id`、`actions`、`read`（后两个是布尔，缺省 false）；`id` 必须是本插件自己的类型（短名）、不重复。任一不符 → `badExports`。
- 依赖方动作 `contributes.actions[].kinds` 可写 `"<被依赖插件id>:<kind>"`；插件 id 必须在本清单 `depends` 里，否则 `unknownKind`（写自己的全名也 `unknownKind`，自己的类型用短名）。

## 宿主接口的确切签名

```ts
ctx.host.plugins.requestInstall({ folder: string })
  → Promise<{ outcome: "installed", id: string, version: string }
          | { outcome: "declined" }
          | { outcome: "failed", reason: string | null }
          | { outcome: "expired" }>
ctx.host.plugins.list()
  → Promise<Array<{ id: string, name: Label, versions: string[], active: string | null }>>
```

- 两者都要求 `requires.plugins.install: true`，否则 `denied/notRequested`。
- `requestInstall` 只能在页面事件处理（`onEvent`）和动作运行里调用；渲染、`migrate`（`denied/pureCall`）、事件订阅处理、命令里 → `denied/notInteractive`。
- `folder`：绝对路径（否则 `invalid/notAbsolute`）；解开链接后必须在其包目录、`plugin-data/<id>/`、或（声明了 `files` 时）用户授权给它的文件夹之内，否则 `denied/outsideGrant`；不是文件夹 → `invalid/notFolder`。登记的是解开链接后的路径。
- 同一插件已有未答复的请求 → `conflict/pendingRequest`。
- 等待期间请求方被停用（或它的版本被移除）→ `{ outcome: "failed", reason: "requesterDisabled" }`。等待的调用自己结束了（被取消、超时）→ 请求撤回并发 `install-requests`。
- 5 分钟没人答复 → `{ outcome: "expired" }`。
- 依赖方读被依赖类型：`ctx.host.resources.get(id)`、`ctx.host.resources.list({ kind: "<owner>:<kind>", parent? })`，结果不含该类型声明为 `"type": "secret"` 的字段；`create`/`update`/`move`/`remove` 一律 `denied/foreignKind`。

## 协议上只增的类型与字段（`crates/protocol`）

- `PluginDetail.depends?: PluginDependency[]`、`PluginDetail.dependents?: string[]`（Rust 里是 `Option<Vec<…>>`；内核总是给出）。
- `PluginDependency { id, range, satisfied, activeVersion? }`。
- `InstallRequest { id, plugin, pluginName: Label, folder, at }`。
- `InstallAnswerOutcome = "installed" | "declined" | "failed"`。
- `InstallAnswerParams { id, outcome, plugin?, version?, reason? }`。
- 模块 `method7`、`topic7`（常量，见下）。

## 新方法与主题

| 名字 | 参数 → 结果 | 说明 |
|---|---|---|
| `plugin.installRequests` | `{}` → `InstallRequest[]` | 未答复的，按登记先后 |
| `plugin.answerInstallRequest` | `InstallAnswerParams` → `null` | 未知 id → `notFound`（`what: installRequest`）。操作者是用户 |
| `plugin.checkRemove` | `PluginVersionParams { plugin, version }` → `null` | **计划外新增**，见“决定 1”。被拒：`conflict/dependents` |
| 主题 `install-requests` | 无负载 | 有新请求、请求被答复、过期、撤回、作废时发 |

## 新增的错误原因码与状态码（列全）

- 清单拒绝原因：`badDepends`、`badExports`、`badPlugins`。
- `conflict`：`reason: dependents`（`params.plugins`）、`reason: pendingRequest`。
- `denied`：`notInteractive`（新）；`requestInstall` 上沿用的 `notRequested`、`outsideGrant`、`pureCall`；读写被依赖类型沿用 `foreignKind`。
- `invalid`：`notAbsolute`、`notFolder`（沿用已有码，用在 `requestInstall` 上）。
- `notFound`：`what: installRequest`。
- 插件状态：插件树节点 `stateReason: "dependsUnmet"`；`PluginDetail.load.message`：`"dependsUnmet"`（依赖未满足，`load.state = disabled`）或 `"notExported"`（启用着，但它在动作里写的某个被依赖类型没有导出）。具体是哪个依赖、什么范围见 `PluginDetail.depends`。
- `switchFailure.reason`：`dependents`。
- `requestInstall` 的结果原因：`requesterDisabled`。

## 审计操作名（列全）

- 新：`plugin.installRequest`（操作者 `plugin:<id>@<version>`，对象是文件夹，摘要 `{ request }`）；`plugin.installAnswer`（操作者 `user`，对象是文件夹，摘要 `{ outcome, id?, version?, reason?, requester, request }`）。
- 被拒的操作沿用已有操作名，结果 `failed:conflict`，摘要里 `reason: dependents`：切换/自动切换记 `plugin.upgrade`（对象插件 id），停用记 `plugin.state`（对象插件 id），移除检查记 `plugin.remove`（对象 `<id>@<version>`）。
- 真正的安装仍记 `plugin.install`（未改）。

## 我做的决定

1. **移除的检查放在新方法 `plugin.checkRemove`。** 移除由主进程（`crates/host` 的 `app.removePlugin`）做，文件挪走后内核已无从拒绝。主进程应在 `install::remove_version` 之前转发 `plugin.checkRemove`，出错就原样返回。这是外壳（host）的文件，本会话没改；已写进 `todo.md` 和共享笔记。只有移除**活动版本**才可能被拒（按 `refresh_active` 会选的下一个版本判断）。
2. **依赖方能读、能加动作的类型 = 它的动作 `kinds` 里写的被依赖类型全名。** 计划没说依赖方在哪里声明要读的类型；为了让权限 `resources` 只由自己的清单决定（指纹稳定，不随被依赖方变化），就用动作里写到的全名。运行时还要被依赖方的活动版本导出该类型（加动作要 `actions: true`，`host.resources.get/list` 要 `read: true`）且依赖已满足。
3. 依赖方的动作运行时，`ctx.resource` 在导出 `actions: true` 时就给（这是用户在其上点的那个资源），但去掉密钥字段；`host.resources` 读要 `read: true`。
4. `PluginDetail.enabled` 改为表示**用户的开关**；是否在工作看 `load.state`（`loaded`/`disabled`）。没有依赖的插件两者一致。插件树里的“启用/停用”菜单也跟用户开关走。
5. 被拒时列出的是**所有**会因此停下的已启用插件（含间接依赖方），按 id 排序。
6. 等用户答复的时间不计入调用时限（页面事件 15 s、运行 60 s）：答复后时限重新开始计。实现为 `CallInfo.hold`。
7. 安装请求只在内存里，工作进程重启就没了（等待的插件调用也随之结束）；不加迁移。
8. 内核不核对 `installed` 答复里的 `plugin`/`version` 是否真的装上（操作者是用户，界面走的是同一条安装路径）。
9. `requires.plugins` 旧的布尔写法改为拒绝（`badPlugins`）；仓库里没有清单用过它。权限项 id 仍是 `plugins`（无明细），指纹原子不变。
10. 撤销升级（`plugin.undoUpgrade`）**不**检查依赖方（计划只列了切换、自动切换、停用、移除）；撤销后若依赖方不满足，它照常显示 `dependsUnmet`。

## 没做 / 没验证的

- 依赖方的动作**没有**加进树节点的右键菜单：现在树节点菜单只有命令，没有任何动作（类型自己的动作也不在里面），命令执行也跑不了动作。页面操作区（及其“更多”）里有。若要进右键菜单，需要外壳/协议决定怎么从菜单发起运行。已记 `todo.md`。
- `plugin.checkRemove` 还没接到主进程（见决定 1）。
- 依赖方停用/恢复时只发了 `plugins` 和依赖方相关树的 `tree:` 主题；没有为被依赖方已打开的页面单独发 `plugin:<id>`，页面上的“依赖方动作”要等页面重新解析才更新。
- 没有在真应用里走（外壳和插件会话的事）。
