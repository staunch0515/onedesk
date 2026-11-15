# round4 / kernel（分支 `claude/week1-kernel-9a967c`）：安装、版本与升级、密钥、网络

先合并了 `claude/week1-slice-3b4ae5`（31ef6d3，无冲突）。`round4-plan.md` §3–§7 的内核与工作进程部分全部做了，没有砍：撤销升级、明文密钥、审计合并计数也都做了。

## 完成了什么

| 部分 | 文件 | 内容 |
|---|---|---|
| 注册表 | `manifest.rs` | 每个插件的所有已安装版本并存，运行中可重读（`plugin.rescan`）；活动版本按工作区状态选；清单新增 `requires.network/secrets/programs/resources/plugins`、`upgradesFrom`、`kinds[].fields`，严格校验 |
| 迁移 0006 | `migrations/0006_versions_secrets_counts.sql` | `upgrade_batches`、`upgrade_items`、`secret_names`、`audit_counts` |
| 版本 | `versions.rs` | `plugin.inspect`、`plugin.rescan`（审计 `plugin.install`/`plugin.remove`）、`plugin.confirmPermissions`、`plugin.activateVersion`（接管：事务外逐条 `migrate`，一个事务写入并记为一批，任何一条失败全部不动）、`plugin.setPinned`、`plugin.undoUpgrade`；第一次见到的插件；自动切换（D303）；恢复删除时按版本接管或 `needsVersion` |
| 按版本处理 | `kernel.rs`、`pages.rs`、`runs.rs` | 每个版本一个沙箱（`id@version`）；资源的图标、页面、事件、动作由它绑定的版本处理；树、命令、“新建”、设置、命令面板只取活动版本；绑定的版本不在 → `missing-plugin`，原因 `<id>@<版本>`，页面只读为空 |
| 沙箱 | `sandbox.rs`、`host.rs` | `host.kinds.handle(kind, {migrate})`；纯计算调用（`migrate` 期间写入类宿主调用被拒，`pureCall`）；`storage.readFrom` 只在 `migrate` 里可用 |
| 密钥 | `secrets.rs` | `SecretStore` 接口，钥匙串实现（`keyring`，服务名 `onedesk` / 调试构建 `onedesk-dev`，账户 `<工作区id>/<名字>`）与内存实现；`secrets.list/set/delete`；`{{secret:名字}}` 代入与响应抹除；`host.secrets.get`（明文，须声明）与运行输出、进度、摘要的抹除；表单密钥字段；永久删除连带删除 `<资源id>.*`；`params.set` 的 `secret` 类型存名字（须已存在） |
| 网络 | `network.rs` | `host.network.request`；两种白名单；`network.allow` 逐层取交集（配置节点 + 调用所在环境的父链，空名单 = 该层全禁）；重定向手动跟随 ≤ 5 次并逐跳复查；解析到回环/链路本地地址的主机须明确写出；连接固定到检查过的地址；正文 ≤ 8 MB（`truncated`）；超时默认 30 秒、最长 60 秒；取消即断开；审计按主机、同一运行内合并计数；`network.grant` 审计；环境页 `restricted` |
| 协议（只增） | `crates/protocol/src/lib.rs` | `PluginVersion.confirmed?`、`PluginVersion.resourceCount?`、`PluginDetail.lastUpgrade?`（新类型 `UpgradeBatchInfo`）、`PluginDetail.unconfirmed`、`AuditRow.count?`、`AuditRow.lastAt?`；已 `pnpm gen:types` |

## 测试与检查结果

```bash
cargo test -p onedesk-kernel -p onedesk-worker                                  # 113 个，全部通过
cargo clippy -p onedesk-kernel -p onedesk-worker --all-targets -- -D warnings   # 0 警告
sh scripts/gen-types.sh --check                                                 # 协议类型是最新的
```

全部用内存密钥库（`SecretStoreHandle::memory()`；工作进程测试设 `ONEDESK_SECRET_STORE=memory`）和本机测试服务器（`127.0.0.1` 上的临时端口），不碰钥匙串、不访问外网。

| 必须有的测试 | 位置 |
|---|---|
| 清单新增部分的每种拒绝 | `manifest::tests::manifest_rejects_each_kind_of_error`（新增 11 条） |
| `inspect` 对各种坏包 | `tests/round4.rs::inspect_reports_bad_packages_and_permissions`（不是文件夹、清单错、已安装；好包的权限和新增权限；检查不改任何东西） |
| 安装/移除的审计；未确认的版本不能启用；两个版本各管各的资源且命令、设置只有一份；升级接管后绑定新版本；切回旧版本；撤销升级（未改的退回、改过的列出）；移除后缺少插件、装回恢复；`migrate` 里发起写入被拒；`storage.readFrom` | `versions_install_confirm_take_over_switch_back_undo_and_remove` |
| 一条 `migrate` 失败则全部不动；权限是子集不需再确认；不能接管的留在旧版本；固定后不自动切换；从历史恢复升级前的值 | `failed_migrate_changes_nothing_subset_needs_no_confirmation_and_old_ranges_stay` |
| 密钥：不在名单、别的插件的、不存在、未声明明文被拒；代入后插件和运行记录里没有真值；表单密钥字段的值不进库（直接读库文件和 WAL）；永久删除连带删除密钥；`secret` 参数须是已有名字 | `secrets_are_substituted_scoped_and_never_stored_in_the_database` |
| 网络：未授权主机、重定向到未授权主机、`network.allow` 收紧、空名单、回环地址、超时、正文截断、合并计数、`network.grant`、`restricted`、未声明网络 | `network_allow_lists_redirects_loopback_limits_and_counting` |
| 网络：取消 | `network_request_ends_when_the_run_is_cancelled` |
| 迁移升级 | `workspace::tests::migration_0006_adds_round4_tables_and_keeps_data` |

## 清单的新增部分（内核按此严格校验）

```json
{
  "upgradesFrom": ">=0.1.0",
  "requires": {
    "files": false,
    "network": { "hosts": ["api.example.com", "*.example.org", "localhost:8080"], "fromResources": true },
    "secrets": { "names": ["token"], "plaintext": false },
    "programs": [], "resources": false, "plugins": false
  },
  "contributes": {
    "kinds": [
      { "id": "request", "…": "…",
        "fields": {
          "url":   { "type": "text", "grants": "network" },
          "token": { "type": "secret" }
        } }
    ]
  }
}
```

- `upgradesFrom`：semver 范围（`semver` crate 语法）；不合法 → 拒绝（`badUpgradesFrom`）。新版本只接管 **低于自己** 且落在范围内的版本的资源。
- `requires.network.hosts`：`host`、`host:port`、`*.domain`（只匹配子域，不含 `domain` 本身）、IPv4；小写。不带端口 = 任何端口。不合法 → `badHost`。
- `requires.network.fromResources: true`：本插件自己类型的资源里，声明了 `"grants": "network"` 的字段的值是网址，它的主机（任何端口）即被授权。声明了 `grants` 而清单没有 `fromResources` → 拒绝（`grantsUndeclared`）；`grants` 只能是 `"network"`、只能用在 `"type": "text"` 上（`badGrants`）。
- `requires.secrets.names`：可用的密钥名字（字母、数字、`.`、`-`、`_`，≤128；否则 `badSecretName`）。`plaintext: true` 才能调 `ctx.host.secrets.get`（另一项权限 `secrets.plaintext`）。
- `kinds[].fields`：键是 body 的键（绑定路径 `body.<键>`），值 `{ "type": <FieldKind>, "grants"? }`。`"type": "secret"` 的字段是表单的密钥字段（D306）。
- `programs`、`resources`、`plugins` 本轮只用于在安装确认时列出，没有对应的能力。

## 插件代码一侧

```js
host.kinds.handle("request", {
  // D301：纯计算。body 是旧 body，fromVersion 是旧版本号，ctx 在最后（可以不要）。
  // 返回新 body（对象）；返回 null/undefined = 原样。期间写入类宿主调用被拒绝（denied/pureCall）。
  migrate(body, fromVersion, ctx) { return { ...body, note: "" }; },
});
// 只在 migrate 里可用：读旧版本的存储
await ctx.host.storage.readFrom("0.1.0", "key");
// 网络
const r = await ctx.host.network.request({ method: "GET", url, headers: { Authorization: "Bearer {{secret:token}}" }, body, timeoutMs });
// r = { status, headers: { 名: 值 }, body: "文字", truncated }
// 明文（须 requires.secrets.plaintext）
const v = await ctx.host.secrets.get("token");
```

- `{{secret:名字}}` 可以写在 `url`、请求头的值、`body` 里；名字不在本插件可用的名单里或不存在 → 整个调用 `denied`（`secretNotAllowed` / `unknownSecret`）。响应里出现该值的地方被换成 `***`。
- 本插件可用的密钥 = 清单 `requires.secrets.names` + 本插件类型的资源里 `secret` 字段指向的名字。
- 表单密钥字段：界面 `page.save` 时把用户填的值放在 `body.<键>`；内核写钥匙串，资源里存 `{ "secret": "<名字>" }`（默认名 `<资源id>.<键>`）；空字符串 = 不改。`page.resolve` 的 `values["body.<键>"]` 是 `true`（已保存）或 `false`。`ctx.resource.body.<键>` 是 `{ "secret": "<名字>" }`，插件拿不到值，要用时写 `{{secret:<名字>}}`。界面的 `draft`、运行的 `input` 里的密钥字段在交给插件前被去掉。

## 给外壳会话

- 主进程 `app.installPlugin` 成功后，若用户在确认框里确认了，请调用 `plugin.confirmPermissions(plugin, version)`：安装本身不等于确认（D299）；不需要任何权限、或权限是已确认版本子集的版本自动视为已确认。
- 工作区第一次见到某个插件时，文件夹里已有的版本都视为已确认（内置插件随应用发布；也包括第四轮之前就装着的）。

## 我做的决定

1. **注册表的插件对象常驻**：每个（插件、版本、清单内容）读一次就常驻在进程里（重读时相同的复用），这样插件对象可以跨异步等待使用；只有新装或清单变了的版本才多占一份（几 KB）。
2. **活动版本**：存在插件状态节点的参数 `active`；它不在（未安装或未确认）时取已确认的最新版本。第一次见到一个插件时记下 `seen`、把当时已有的全部版本记为已确认、`active` 设为最新的那个（D299 “内置插件首次复制时视为已确认”，也覆盖第四轮之前就装着的插件）。之后由 `rescan` 发现的版本不自动确认。
3. **确认的记法**：`confirmed.<版本>` = 该版本权限原子的列表（每行一个：`files`、`network:<主机>`、`network:@resources`、`secrets:<名字>`、`secrets.plaintext`、`programs:<名字>`、`resources`、`plugins`）。一个版本若不要任何权限，或它的原子集合是某个已确认版本的子集，就视为已确认。`addedPermissions` 是不在任何已确认集合里的原子所属的权限 id。
4. **没有已确认版本的插件**视为停用（`plugin_enabled` 为假），它的资源灰显、运行被拒。
5. **接管**只向上：新版本只接管版本号比自己低、且落在 `upgradesFrom` 里的资源；切回旧版本时已绑定新版本的不动。`kept` = 该插件不归新版本、也没被接管的资源数。接管写入时核对每条的 `rev` 与算新 body 时一致，不一致 → 整批 `conflict`（`changedDuringUpgrade`）。
6. **`migrate` 的写法**是 `migrate(body, fromVersion, ctx)`（与计划里的 `migrate(body, fromVersion)` 兼容，`ctx` 放在最后）；返回对象即新 body，返回 `null`/`undefined` 或没有 `migrate` = 原样。
7. **撤销升级**：退回到升级前那一修订的快照里的 body，并绑定回旧版本；活动版本改回这批来自的（最低的）版本。之后又改过的列在 `modified`，`also` 里列出的照样退回。
8. **固定**：`setPinned(true)` 同时把那个版本设为活动版本（必要时接管）；取消固定后立刻按 D303 看要不要切换。
9. **恢复删除**：批里有绑定到已不在的版本的资源时，活动版本能接管就恢复并接管（`migrate`），不能就整批拒绝（`invalid/needsVersion`）。按字段的历史恢复不改绑定。
10. **表单密钥字段**：资源里存 `{ "secret": "<名字>" }`，默认名 `<资源id>.<字段>`，已有名字则沿用；空值不改；`new:` 页面先建资源再写密钥（两条命令）。`page.resolve` 的 `values` 里该路径是 `true`/`false`。`draft`、运行的 `input` 和输入快照里该路径被去掉。
11. **插件可用的密钥**：清单名单 + 自己类型资源里 secret 字段指向的名字（因此表单里保存的密钥，该插件可以在代入里用 `{{secret:<资源id>.<字段>}}`）。
12. **抹除**：代入用过的值从响应里抹成 `***`；明文取到的值记在这次运行上，结束时从输出、错误、摘要里抹掉，进度消息同样。少于 3 个字符的值不抹（避免把正文抹花）。
13. **主机匹配**：白名单项不带端口 = 任何端口；`*.x` 只匹配子域。“明确写出”= 非通配的项。解析出的地址里只要有一个回环/链路本地/未指定地址，而主机不是明确写出的，就拒绝；连接固定到检查过的第一个地址，不再二次解析。
14. **`network.allow`**：值按换行或逗号分隔；所有定义了它的配置节点 + 调用所在环境（标签页的环境）父链上定义了它的每一层都要包含该主机。环境页 `EnvParam.restricted` 在本层名单里有上层不允许的项时给出（文字键 `restrictedByUpperLayer`）。
15. **重定向**：303，或 301/302 对 POST，改为 GET 且不带正文；超过 5 次 → `invalid/tooManyRedirects`。
16. **审计**：`network.request` 的对象是最终的主机，摘要 `{method, pathLength, status}`；同一运行、同一主机只写一行，次数和末次时间在 `audit_counts`，`audit.list` 给出 `count`、`lastAt`（次数 > 1 时）。没有运行的调用（页面渲染等）每次一行。被拒的网络调用照常写一行失败审计（对象是主机）。
17. **`network.grant`**：资源保存后它的授权字段多出的主机各记一行（操作者是保存者，摘要带资源 id 和类型）。
18. **工作进程启动时**若发现比活动版本新、已确认、未固定的版本，在后台自动切换（不阻塞打开）。
19. **钥匙串服务名**按构建：调试构建 `onedesk-dev`，发布构建 `onedesk`；`ONEDESK_SECRET_STORE=memory` 用内存（工作进程测试用）。

## 新依赖

`crates/kernel/Cargo.toml` 直接写：

- `reqwest = { version = "0.12", default-features = false, features = ["native-tls"] }`：HTTP 客户端，TLS 走系统（Security.framework），不带 `rustls`/`ring`。
- `keyring = { version = "3", default-features = false, features = ["apple-native"] }`：钥匙串。

`Cargo.lock` 新增、在 macOS 上实际编译进内核的包：

| 包 | 版本 | 许可证 |
|---|---|---|
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| hyper-tls | 0.6.0 | MIT/Apache-2.0 |
| keyring | 3.6.3 | MIT OR Apache-2.0 |
| native-tls | 0.2.18 | MIT OR Apache-2.0 |
| reqwest | 0.12.28 | MIT OR Apache-2.0 |
| rustls-pki-types | 1.16.0 | MIT OR Apache-2.0 |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 |
| security-framework | 3.7.0 | MIT OR Apache-2.0 |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 |
| serde_urlencoded | 0.7.1 | MIT/Apache-2.0 |
| tokio-native-tls | 0.3.1 | MIT |
| zeroize | 1.9.1 | Apache-2.0 OR MIT |

另外 `Cargo.lock` 里新增的 `openssl`、`openssl-sys`、`openssl-macros`、`openssl-probe`、`foreign-types(-shared)`、`schannel`、`security-framework 2.11.1`、`core-foundation 0.9.4` 只在其他平台（Linux 的 `native-tls` 后端、Windows）或旧版本链上出现，macOS 上不编译；许可证也都是 MIT / Apache-2.0。`rustls-pki-types` 只是证书类型的定义（`native-tls` 用），没有引入 `rustls` 或 `ring`。内核在 macOS 上的全部 161 个依赖都在允许清单内（`cargo tree -p onedesk-kernel -e normal -f '{p}|{l}'` 核对）。

## 协议变更（只增）

见上面“完成了什么”的最后一行。另外外壳需要知道：

- `plugin.get` 的 `versions` 列出全部已安装版本（新的在前），每项有 `active`、`pinned`、`confirmed`、`resourceCount`、`installedAt`（版本文件夹的修改时间）。
- 插件树节点：`badge` 是活动版本；有未确认的版本时 `stateReason` 是文字键 `unconfirmedVersion`。

## 内核写的审计操作名（本轮新增）

成功：`plugin.install`、`plugin.remove`（对象 `<id>@<版本>`）、`plugin.upgrade`（对象插件 id；手动切换、自动切换、固定、恢复删除时的接管都记这一个，摘要 `{to, count, batch?}`）、`plugin.undoUpgrade`、`plugin.state`（确认权限、活动版本、固定、启用、设置）、`secrets.set`、`secrets.delete`（对象是名字；表单密钥字段写入的值不单独记）、`network.request`（合并计数）、`network.grant`；接管写入的资源修订 op 是 `upgrade` / `undoUpgrade`。

失败或被拒：`plugin.upgrade`（`migrate` 失败、版本未确认之外的失败）、`plugin.undoUpgrade`，以及被拒的宿主调用（操作名就是宿主方法名）：新增 `network.request`、`secrets.get`，和在 `migrate` 里被拒的写入类方法（`resources.create` 等、`storage.set`、`storage.remove`、`files.writeText`、`ui.*`），以及在 `migrate` 之外调 `storage.readFrom`。前几轮的操作名不变（见 `round3-kernel-done.md`）。

## 本轮新增的错误原因（`params.reason`）与文字键

| 错误码 | `reason` |
|---|---|
| `denied` | `notConfirmed`（激活未确认的版本）、`pureCall`、`notInMigrate`、`secretNotAllowed`、`unknownSecret`（代入或明文取值时名字不存在）、`plaintextUndeclared`、`hostNotAllowed`、`blockedByPolicy`、`localAddress`、`notRequested`（未声明网络） |
| `invalid` | `needsVersion`、`alreadyUndone`、`unknownSecret`（`params.set` 的 `secret` 参数）、`badSecretName`、`badScheme`、`badUrl`、`badMethod`、`tooManyRedirects`、`timeout`（网络请求超时） |
| `conflict` | `changedDuringUpgrade` |
| `pluginError` | `migrateFailed`（另带 `resource`：哪一条） |
| `notFound` | `what`：`batch`、`secret`、`host`（主机解析不到） |

`plugin.inspect` 的 `problem`：`invalid`，`reason` 是 `notFolder`、`alreadyInstalled`，或清单拒绝原因；清单拒绝原因新增 `badUpgradesFrom`、`badHost`、`badSecretName`、`grantsUndeclared`、`badGrants`。

内核给出的文字键（`Label::Text`，外壳配文字）：`unconfirmedVersion`（插件树节点）、`restrictedByUpperLayer`（环境页）。缺少插件时的 `stateReason` 是 `<插件id>@<版本>`（不是键，原样显示或嵌进外壳的句子里）。

## 还缺什么 / 没验证的

- **真钥匙串**（`KeychainStore`）没有测试：按要求测试只用内存实现。第一次在应用里使用时 macOS 可能弹出钥匙串访问确认。
- **https** 没有测（本机测试服务器只有 http）；`native-tls` 的证书校验走系统默认。
- **8 MB 正文与 32 MB 的沙箱内存**：正文作为字符串进入插件后，插件再复制几份（拼接、`JSON.stringify`）就可能超内存（测试里把上限调到 96 MB 才能把 8 MB 正文原样回传）。真实插件只取摘要时没问题；如果要原样显示大正文，建议以后用 §7.4 的 `transfer`（宿主直接写文件）。
- **启动时的自动切换**在后台进行，没有专门的测试（`rescan` 路径有测试）；切换完成前的请求看到的是旧的活动版本。
- **`plugin.reload`** 仍只丢弃运行环境；要让改过的清单生效用 `plugin.rescan`（同一版本号、清单内容不同会重新读入）。
- `secrets.list` 的 `usedBy` 里“引用它的资源”是对 body 文本的近似匹配。
- 审计的合并计数只用于 `network.request`；“反复被拒的同一种调用”的合并没有做。
- 重定向逐跳的审计只记最终主机。

## 审查后的修改（`docs/handoff/round4-review.md` 中标给内核的各条）

先合并了 `claude/week1-slice-3b4ae5`（de1cbc9）。协议补充（D312）按审查文件里的名字加进 `crates/protocol`（只增）并已 `pnpm gen:types`：`InstallPreview.fingerprint`、`AppInstallParams { folder, id, version, fingerprint }`、`PluginConfirmParams { plugin, version, fingerprint }`、`PluginVersion.permissions`、`PluginVersion.fingerprint`、`PluginRescanParams { builtin }`；工作进程命令行加可重复的 `--builtin <id>@<version>`。新迁移 `0007_upgrade_prev_active.sql`（升级批记下升级前的活动版本），带升级测试。

| # | 修改 | 测试（`tests/round4.rs`） |
|---|---|---|
| 1 必须 | D311：操作者是插件时，写入管线拒绝新建或修改类型声明的“授权地址”字段（`grants`）和“密钥”字段（`denied`，`reason: grantField`，另带 `field`）；`null` 与空字符串视为未设置。升级接管时这两类字段（新旧两个版本声明的都算）必须与旧值相同，否则整批失败（`denied/grantField`，另带 `resource`）。`page.event` 的修改里去掉这两类字段。用户经 `page.save`、界面命令照常可改 | `review1_plugins_cannot_grant_themselves_hosts_or_secrets`（`resources.create/update` 写地址、写密钥引用、页面事件、自动和手动接管各被拒一次；库里没有插件写的地址；`network.grant` 只有用户保存的那一条） |
| 2 必须 | `plugin.get` 的每个版本带它自己的 `permissions` 和 `fingerprint` | `review2_4_each_version_has_its_permissions_and_confirmation_checks_the_fingerprint` |
| 3 必须 | 在 `new:` 目标上运行时，按类型的字段声明去掉密钥字段：交给插件的输入和存下的输入快照都去掉（与已保存资源同一规则） | `review3_secret_fields_of_a_new_page_never_reach_the_run_or_the_database`（直接读 `workspace.db` 和 `-wal` 的字节） |
| 4 | `plugin.inspect` 给出 `fingerprint`；`plugin.confirmPermissions` 必须带回同一个指纹，否则 `invalid/fingerprintMismatch` | 同 #2 |
| 5 | D313：工作区第一次见到插件时只自动确认主进程给出的内置清单（`--builtin`、`plugin.rescan` 的 `builtin`）里的版本，以及不要任何权限的版本；其余“已安装、未确认”。已见过的插件，在 `rescan` 的 `builtin` 里出现的版本同样自动确认 | `review5_only_builtin_packages_are_confirmed_without_asking` |
| 6 | D314：升级批记下升级前的活动版本；撤销升级回到它并**固定**；手动切到较旧版本时也固定；版本比较一律用 semver | `review6_7_undo_stays_put_and_unconfirmed_code_never_runs`（撤销后 `rescan` 不会再自动升级） |
| 7 | D315：未确认版本的代码绝不激活（`call_version` 拒绝，`pluginError/unconfirmedVersion`）；绑定它的资源状态 `disabled`、原因文字键 `unconfirmedVersion`，页面为空 | 同 #6（同版本号换成多要权限的包） |
| 8 | D316：重定向到别的主机或端口时，丢掉含代入密钥的请求头和 `Authorization`、`Cookie`、`Proxy-Authorization` | `review8_11_redirects_drop_credentials_and_requests_are_limited` |
| 10 | 历史恢复（`body.*` 字段）按 §7.6：快照绑定的版本还在 → 绑定回去；不在但活动版本能接管 → 对恢复后的内容跑 `migrate` 并绑定活动版本；都不行 → `invalid/needsVersion`。授权地址因恢复、恢复删除、升级、撤销升级而出现新主机时同样记 `network.grant` | `review10_restore_follows_version_rules_and_audits_grants`；`failed_migrate_…` 的最后一段（快照的版本还在：绑定回去） |
| 11 | D316：`reqwest` 禁用环境代理（`no_proxy`）；名字解析计入同一个超时；方法只许 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS（否则 `invalid/badMethod`）；插件设置 `Host`、`Content-Length`、`Transfer-Encoding`、`Connection` → `invalid/forbiddenHeader`（另带 `header`） | 同 #8（方法与请求头；代理和解析超时没有专门测试） |
| 13 | 扫描插件文件夹时，`<id>/` 下以 `.` 开头的版本目录也跳过（`<plugins>/` 下的点目录本来就跳过） | （扫描逻辑的一行，已有的扫描测试覆盖其余） |
| 14 | 表单密钥字段：先把值从修改里取出、写库提交，提交成功之后再写钥匙串；写钥匙串失败则返回错误（该字段算未保存） | `review14_a_failed_save_does_not_touch_the_keychain` |

结果：`cargo test -p onedesk-kernel -p onedesk-worker` 共 122 个测试全部通过（新增 9 个）；clippy 无警告；`sh scripts/gen-types.sh --check` 协议类型是最新的。

**给外壳会话**：

- 主进程启动工作进程时为它自己复制的每个内置包加 `--builtin <id>@<version>`；安装或更新内置包后调 `plugin.rescan`，参数 `{ "builtin": [...] }` 列出这次复制的。用户安装的包：复制、重新检查一致之后调 `plugin.rescan`（`builtin` 为空），再用确认框里的 `fingerprint` 调 `plugin.confirmPermissions`。
- 测试与开发时，`crates/kernel/tests/common` 的做法可参考：把插件文件夹里已有的包都当作内置包传入。

### 内核实际写的审计操作名（完整，至第四轮审查后）

| 何时 | 操作名 |
|---|---|
| 资源 | `resource.create`、`resource.update`、`resource.move`、`resource.delete`、`resource.undelete`、`resource.purge`、`resource.restore` |
| 参数 | `params.set`、`params.unset`、`params.acknowledge` |
| 插件 | `plugin.state`（启用/停用、设置、确认权限、活动版本、固定）、`plugin.install`、`plugin.remove`（对象 `<id>@<版本>`）、`plugin.upgrade`、`plugin.undoUpgrade` |
| 运行 | `run.start`、`run.end`、`run.keep`、`run.unkeep` |
| 文件、网络、密钥 | `files.write`、`network.request`（同一运行同一主机合并计数）、`network.grant`、`secrets.set`、`secrets.delete` |
| 只在失败时出现 | `plugin.grant`（授权文件夹失败；成功时落在插件状态节点上，记 `resource.create`/`resource.update`）、`workspace.startup`；插件被拒绝的宿主调用以宿主方法名记：`resources.get/list/create/update/move/remove`、`files.roots/list/stat/readText/writeText`、`storage.get/set/remove/keys/readFrom`、`settings.get`、`params.get`、`ui.open/notify/copy`、`util.sleep`、`runs.progress`、`network.request`、`secrets.get`（被拒的原因在摘要的 `reason` 里） |
| 不写审计 | `ui.set`（界面状态）、收藏与最近使用、运行进度、清除任务面板、插件 `storage` 的写入 |

`audit.result`：`ok` 或 `failed:<ErrorCode>`。

### 内核发出的全部错误原因（`ProtocolError.params.reason`，至第四轮审查后）

| 错误码 | `reason` |
|---|---|
| `invalid` | `emptyName`、`unknownKind`、`parentNotFound`、`otherTree`、`notAccepted`、`notInTree`、`self`、`descendant`、`targetNotFound`、`noGroups`、`notParamNode`、`reservedField`、`duplicateName`（另带 `name`）、`unknownSecret`、`notDeleted`、`notRestorable`、`nothingBefore`、`needsVersion`、`notAbsolute`、`notFolder`、`notFile`、`tooLarge`、`notText`、`badTarget`、`badKey`、`tooManyKeys`、`unknownSetting`、`badValue`、`helloFirst`、`alreadyUndone`、`fingerprintMismatch`、`badSecretName`、`badScheme`、`badUrl`、`badMethod`、`forbiddenHeader`（另带 `header`）、`tooManyRedirects`、`timeout`（网络请求） |
| `denied` | `foreignKind`、`notRequested`、`outsideGrant`、`notAbsolute`、`undeclaredSetting`、`pluginDisabled`、`callEnded`、`cancelled`、`timeout`、`notConfirmed`、`pureCall`、`notInMigrate`、`grantField`（另带 `field`，接管时还带 `resource`）、`secretNotAllowed`、`unknownSecret`、`plaintextUndeclared`、`hostNotAllowed`、`blockedByPolicy`、`localAddress` |
| `conflict` | `changedOnDisk`、`changedDuringUpgrade`；资源与参数的字段冲突不带 `reason`，带 `field`、`rev` |
| `invalidParams` | `tooLarge`；其余不带 `reason`，只有 `detail` |
| `unsupported` | `providedTree` |
| `pluginError` | `threw`、`badOutput`（另带 `plugin`）、`outOfMemory`、`cancelled`、`engine`、`notLoaded`、`pluginDisabled`、`unconfirmedVersion`、`migrateFailed`（另带 `resource`） |
| `pluginTimeout` | `timeout` |
| `notFound` | 不带 `reason`，带 `what`：`resource`、`node`、`tree`、`kind`、`page`、`plugin`、`command`、`target`、`entry`、`run`、`tab`、`path`、`config`、`batch`、`secret`、`host` |
| `versionMismatch` / `unknownMethod` | 带 `expected`、`got` / `method` |

运行失败原因（`RunError.code`）：`unknownAction`、`invalidInput`、`pluginDisabled`、`badOutput`、`timeout`、`interrupted`、`pluginError`，以及透传的宿主错误码（`denied`、`invalid`、`conflict`、`notFound`、`invalidParams`、`internal`）。

清单拒绝原因（插件树 `stateReason`、`plugin.inspect` 的 `problem.params.reason`）：`noManifest`、`badJson`、`schema`、`apiVersion`、`badId`、`idMismatch`、`badVersion`、`versionMismatch`、`mainMissing`、`badName`、`duplicate`、`unknownPage`、`unknownTree`、`unknownCommand`、`unknownKind`、`missingAction`、`unknownAction`、`badSetting`、`localeMissing`、`badLocale`、`badUpgradesFrom`、`badHost`、`badSecretName`、`grantsUndeclared`、`badGrants`；`plugin.inspect` 另有 `notFolder`、`alreadyInstalled`。

### 内核给出的文字键（`Label::Text`，外壳配文字）

- `unconfirmedVersion`：插件树节点的 `stateReason`（有未确认的版本）；资源节点与页面的 `stateReason`（绑定的版本未确认，状态 `disabled`）。
- `restrictedByUpperLayer`：环境页 `EnvParam.restricted`。
- `deleted.purge.confirm`：`deleted.purge` 的确认效果的 `message`。
- `core`：命令面板里内核命令的组名。
- 内核命令、树、类型的 `label`/`title` 就是它们的 id（D262），如 `node.newGroup`、`resources`、`core:group`。
- 缺少插件时的 `stateReason` 是 `<插件id>@<版本>`（不是键）。

### 仍未验证

- 环境代理确实被绕开（`no_proxy`）和名字解析的超时，没有专门测试（测试进程不改环境变量）。
- 其余同上文“还缺什么 / 没验证的”。

## 验收后的修改（D317、D318）

先合并了 `claude/week1-slice-3b4ae5`（含 D317、D318）。

1. **D317 按“主机 + 端口”授权**：授权地址字段授予的是该地址的 `主机:端口`（没写端口取协议默认端口：http 80、https 443）；清单 `requires.network.hosts` 和 `network.allow` 的条目不带端口时只匹配 80 和 443，带端口精确匹配（通配 `*.x` 同理）；`network.grant` 审计的对象是 `主机:端口`；重定向逐跳按同样规则复查。测试 `tests/round4.rs::d317_a_granted_address_grants_its_port_only`（同一地址换端口被拒、重定向到别的端口被拒，运行的 `error.reason` 是 `hostNotAllowed`）；`network::tests` 加了端口规则的断言。
2. **D318 可含密钥引用的文字字段**：类型字段声明 `{ "type": "text" | "longtext" | "code", "secrets": true }`（与 `grants` 同时用、或用在别的类型上 → 清单拒绝 `badSecretsField`）。
   - 一次宿主调用可用的密钥名字 = 清单 `requires.secrets.names` + **这次调用所关于的资源**（运行的资源、渲染或事件的资源页）**已保存**的内容里：密钥字段指向的名字、`secrets: true` 字段里出现的 `{{secret:名字}}`。不关于某条资源的调用（命令、没有资源的运行）只有清单名单。**这是收紧**：第四轮原先是“本插件所有资源里出现过的名字”，现在按资源。
   - 运行输入快照（未保存的草稿）里新写、而已保存的资源里没有的名字不算授权：`denied/secretNotAllowed`。
   - 这类字段纳入 D311：插件不能写（`denied/grantField`）；升级接管时其中的**密钥名字集合**不得改变（文字本身可以变）；页面事件的修改里去掉它。
   - 测试 `d318_saved_secret_references_are_usable_draft_ones_and_plugin_writes_are_not`（保存后可用且值被抹、草稿里新写的名字被拒、插件写入被拒、不关于资源的调用不能用、库文件和 WAL 里没有值）；清单校验多三条。
3. **`RunError.reason`**（协议只增，已 `pnpm gen:types`）：运行因插件没接住的宿主错误而失败时，`code` 是宿主错误码（`denied`、`invalid`、`notFound`、`conflict`、`invalidParams`），`reason` 是它的原因码。可能出现的 `reason`（来自宿主调用）：
   - `denied`：`secretNotAllowed`、`unknownSecret`、`plaintextUndeclared`、`hostNotAllowed`（含重定向到未授权的主机或端口）、`blockedByPolicy`（被 `network.allow` 限制）、`localAddress`、`notRequested`（未声明网络或文件能力）、`outsideGrant`、`foreignKind`、`grantField`、`pureCall`、`notInMigrate`、`undeclaredSetting`、`callEnded`、`cancelled`、`timeout`；
   - `invalid`：`badScheme`、`badUrl`、`badMethod`、`forbiddenHeader`、`tooManyRedirects`、`timeout`（网络请求超时）、`tooLarge`、`notText`、`notFile`、`notFolder`、`badKey`、`tooManyKeys`、`badTarget`、`emptyName`、`unknownKind`、`notAccepted` 等（前几轮的 `invalid` 原因都可能透传）；
   - `notFound`：没有 `reason`（主机解析不到时 `params.what = host`，不进 `reason`）；`conflict`：`changedOnDisk`。
   - 内核自己判定的失败（`unknownAction`、`invalidInput`、`pluginDisabled`、`badOutput`、`timeout`、`interrupted`、`pluginError`）没有 `reason`。

已有测试按新规则调整：测试插件的白名单写明端口（`*.localhost:<端口>` 等）；`network.grant` 的对象带端口；表单密钥字段的密钥在“关于该资源的运行”里可用、在不关于资源的探测里被拒。

结果：`cargo test -p onedesk-kernel -p onedesk-worker` 共 124 个测试全部通过；clippy 无警告；`sh scripts/gen-types.sh --check` 协议类型是最新的。

**给插件会话**：HTTP 请求插件的请求头字段（以及地址、正文里若要写密钥引用的字段）声明 `"secrets": true`；运行时要用的密钥名字必须先由用户保存在这条资源里。清单 `requires.network.hosts` 若写了主机而要用非 80/443 端口，须写明端口。
