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
