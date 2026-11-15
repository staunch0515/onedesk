# 第四轮：安装插件、版本与升级、密钥、网络，一个真正的 HTTP 请求插件（协调会话定）

依据：`dev-plan.md` 阶段 3 的剩余部分；`kernel-design.md` §2.1、§6.3、§7.1、§7.5（安装、网络、密钥）、§7.6、§13。沿用前三轮的全部约定和共同规则。决定 D298–D309 见 `docs/decisions.md`。
类型以 `crates/protocol/src/lib.rs` 末尾“round 4”一段为准（已生成 TS）。

## 1. 做完是什么样

- 在插件树的工具栏点“安装插件…”，选一个文件夹：弹出确认框，列出插件名称、版本和它要的全部权限；确认后它出现在插件树里并可启用。清单有错的包被拒绝并说明原因。
- 装上示例插件的 0.2.0（放在 `e2e/fixtures/` 的一个包）：因为没有固定版本，自动切到新版本，已有的示例查询被新版本接管并改写（新版本的 `migrate` 给 body 加一个字段），之后绑定 0.2.0；插件页的版本表列出两个版本，能切回 0.1.0（已升级的资源仍由 0.2.0 处理），能“撤销升级”。新版本多要一项权限时，升级前重新确认。移除一个仍有资源绑定的版本要先确认，之后那些资源显示“缺少插件”。
- 设置里的“密钥”页：新增、改值、删除密钥；值只能写，看不到。
- 新建一条“HTTP 请求”（新的内置插件）：方法、地址、请求头、请求体；“发送”后结果区显示状态码、耗时和响应正文；请求头里写 `{{secret:名字}}`，发出时由宿主换成真值，插件和运行记录里都没有真值；地址的主机在这条资源保存时即被授权，访问别的主机被拒绝；工作区配置或环境的 `network.allow` 可以再收紧。

## 2. 范围

**做**：安装与移除（主进程复制文件，`app.*`）；权限确认；多版本并存、资源绑定版本、升级接管与失败回退、切回旧版本、撤销升级（§7.6）；密钥（钥匙串、代入、表单的密钥字段、明文须单独声明）；宿主能力 `network`（两种白名单来源、重定向逐跳复查、每次调用进审计并合并计数）、`secrets`；策略 `network.allow`（§6.3 的“允许名单取交集”）；HTTP 请求插件；界面对应部分。

**不做（下一轮）**：宿主能力 `process`、`transfer`、`events`、`plugins`（插件请求安装）、依赖与导出（§7.3）、本地插件市场；其余策略参数；参数声明、引用；导出导入；第一版旧库升级；清单缓存 `plugins/.index`；空闲回收；结果导出 CSV。

## 3. 方法

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `app.inspectPlugin` | `PluginFolderRef` → `InstallPreview` | 主进程处理：把文件夹路径转给工作进程的 `plugin.inspect`（工作进程只读取、校验，不复制） |
| `app.installPlugin` | `PluginFolderRef` → `PluginVersionParams` | 主进程处理：再次 `plugin.inspect`（必须 `valid`）→ 复制到 `<数据目录>/plugins/<id>/<version>/`（先复制到同目录下的临时文件夹再改名；目标已存在则拒绝）→ 调工作进程 `plugin.rescan`。界面只有在用户确认了 `InstallPreview` 之后才调它 |
| `app.removePlugin` | `PluginVersionParams` → `null` | 主进程处理：把该版本的文件夹移到废纸篓外的 `<数据目录>/plugins/.removed/<id>-<version>-<时间>`（不直接删），再 `plugin.rescan`。内置插件的当前版本也可以移除（下次启动不自动装回同一版本：主进程记在 `<数据目录>/plugins/.removed/` 里有它） |
| `plugin.inspect` | `PluginFolderRef` → `InstallPreview` | 工作进程：读清单、严格校验、对比已安装版本和已确认的权限 |
| `plugin.rescan` | — → `null` | 工作进程：重读插件文件夹；新出现的版本记审计 `plugin.install`，消失的记 `plugin.remove`；按 §5 的规则自动切换版本；发 `plugins` |
| `plugin.activateVersion` | `PluginVersionParams` → `UpgradeResult` | 切换“用于新建”的版本并接管（§5） |
| `plugin.setPinned` | `PluginPinParams` → `null` | 固定后不自动切换 |
| `plugin.undoUpgrade` | `UndoUpgradeParams` → `UndoUpgradeResult` | 按批撤销（§5） |
| `plugin.confirmPermissions` | `PluginVersionParams` → `null` | 用户确认了这个版本的权限；未确认的版本不能启用、不能成为活动版本 |
| `secrets.list` | — → `SecretInfo[]` | 只有名字 |
| `secrets.set` / `secrets.delete` | `SecretSetParams` / `SecretNameParams` → `null` | 值进钥匙串；`secret_names` 表记名字；审计只记名字 |

`plugin.get` 的 `versions` 列出全部已安装版本（`active`、`pinned`、每个版本绑定的资源数由内核按“只增”加字段）；`PluginDetail` 增加“最近一次升级的批 id 与数量”“是否有未确认的版本”等内核认为界面需要的字段。插件树节点的徽标显示活动版本；有未确认的新版本时状态原因写明。

## 4. 安装与权限确认（D298–D300）

- 安装只有“请安装这个文件夹里的插件包”一个入口；检查清单 → 列出全部权限 → 用户确认 → 主进程复制 → 审计（§7.5）。本轮提出请求的只有用户。
- 权限确认记在该插件的状态节点里（参数 `confirmed.<version>` = 该版本权限清单的指纹）。内置插件由主进程首次复制时视为已确认（它们随应用发布）。
- 新版本要的权限是已确认版本的子集：不必再确认。多了：`InstallPreview.addedPermissions` 列出，界面在确认框里标出；确认前该版本只是“已安装、未确认”，不参与自动切换。
- 权限项（`PluginPermission.id`）：`files`、`network`（detail：主机列表，或“由连接资源决定”）、`secrets`（detail：名字列表；另有 `secrets.plaintext`）、`programs`、`resources`、`plugins`。
- 工作进程对插件文件夹只读；复制、移除只由主进程做（§2.1）。主进程复制前拒绝：路径不是文件夹、清单读不到、包内有符号链接指向包外、包超过 200 MB。

## 5. 版本（D301–D304，§7.6 全文适用）

- 每个版本一个沙箱；资源由它绑定的版本处理（字段定义、图标、页面、动作、右键项、结果页签、`validate` 等）；树、命令、菜单、“新建”、设置只取活动版本。`plugin_storage` 已按版本隔离；升级接管时新版本可读旧版本的存储：`ctx.host.storage.readFrom(version, key)`（只读，只在 `migrate` 的上下文里可用）。
- 清单新增 `upgradesFrom`（semver 范围）。插件代码新增 `host.kinds.handle(kind, { migrate(body, fromVersion) → body })`，纯计算：执行期间任何会写入的宿主调用都被拒绝。
- 切换活动版本（手动，或 `rescan` 发现更新的、已确认的、没有被固定的版本时自动）：对旧版本绑定的、且新版本 `upgradesFrom` 覆盖的资源，先在事务外逐条算出新 body（没有 `migrate` 处理函数则原样），再在一个事务里写入并改绑定，记为一批（批 id、每条的旧修订号）。任何一条算不出来或写不进去：全部不动，活动版本不变，返回错误并写审计。不能接管的资源留在旧版本。
- 切回旧版本：之后新建的用旧版本；已绑定新版本的不动。
- 撤销升级：对那一批里升级后没再改过的资源，退回升级前的快照并重新绑定旧版本；改过的列在 `modified` 里，由用户选择（`also`）。活动版本同时切回旧版本。
- 移除版本后仍绑定它的资源：状态 `missing-plugin`，原因带“插件 id@版本”，页面只读为空；装回即恢复。
- 从历史恢复、恢复删除时按 §7.6“其他情形”：绑定的版本还在就绑定回去；不在但活动版本能接管就升级；都不行则拒绝（`invalid`，`reason: needsVersion`）。

## 6. 密钥（D305–D306）

- 钥匙串：服务名 `onedesk`（开发构建 `onedesk-dev`），账户 `<工作区id>/<名字>`。内核通过一个 `SecretStore` 接口访问；测试用内存实现，绝不碰真钥匙串。运行期间读过的值缓存在内存里。
- 插件能用哪些密钥：清单 `requires.secrets.names` 里的，加上它自己类型的资源里“密钥引用”字段指到的（类型字段声明 `{ "type": "secret" }`）。
- 默认是代入：插件在 `network.request` 的请求头、请求体、地址的查询参数里写 `{{secret:名字}}`，宿主发出时替换。没有权限用这个名字、或名字不存在：这次调用 `denied`。响应里出现密钥原值的地方在交给插件之前抹成 `***`（补救措施，不是保证）。
- 表单的密钥字段（`FieldKind::Secret`，`bind` 到一个声明为 `secret` 的字段）：用户填的值随 `page.save` 送到内核，内核直接写钥匙串，资源里只存 `{ "secret": "<名字>" }`；名字默认是 `<资源id>.<字段>`。值不经过插件、不进历史、不进审计、不进搜索。`page.resolve` 给界面的 `values` 里只有“已保存”与否。
- 要明文：清单 `requires.secrets.plaintext: true`（安装时单独一项权限），才能调 `ctx.host.secrets.get(name)`；内核把它拿到过的值从运行输出、进度、摘要里抹掉。本轮的插件都不用它，但要有测试。
- `params.set` 重新允许 `secret` 类型：值必须是一个已存在的密钥名字（存的是名字，不是值）。
- 永久删除资源时，它名下的密钥（`<资源id>.*`）一并从钥匙串删除。

## 7. 网络（D307–D309）

- `ctx.host.network.request({ method, url, headers?, body?, timeoutMs? })` → `{ status, headers, body, truncated }`。只有 http、https；正文按文字返回，上限 8 MB；默认超时 30 秒，最长 60 秒；可被运行的取消打断。
- 白名单：清单 `requires.network.hosts`（主机名，可带端口，`*.example.com` 这种前缀通配）；或 `requires.network.fromResources: true` 且类型字段声明 `{ "type": "text", "grants": "network" }`——这个插件自己类型的资源里该字段的地址的主机即被授权（I.10h）。保存这样一条资源时审计记为权限变更 `network.grant`。
- 再与 `network.allow` 取交集：工作区配置和（有环境时）环境父链上每一层定义了的名单都要包含这个主机；任何一层的名单是空的 = 这一层禁止一切网络。没有任何一层定义 = 不额外限制。环境页对被上层限制的值给出 `EnvParam.restricted`。
- 重定向不自动跟随超过 5 次，每一跳的主机都重新检查；跳到白名单外：`denied`。
- 拒绝解析到回环、链路本地地址的主机，除非白名单里明确写的就是 `localhost` 或那个 IP（防止借 DNS 打内网；界面检查要连本机的测试服务器，所以明确写出的允许）。
- 每次调用写审计（操作 `network.request`，对象是主机，摘要含方法、路径的长度而非内容、状态码）；同一次运行里对同一主机的重复调用合并成一行，记次数和首末时间（§4.3 的合并计数现在做：新增一张计数表，不改 `audit`）。
- 依赖：HTTP 客户端用 `reqwest`，TLS 走系统的（`native-tls`），不引入 `ring`/`rustls`；钥匙串用 `keyring`（apple-native）。各自的许可证与连带依赖由内核会话核对并写进交接文件，不在允许清单内的写阻塞说明。

## 8. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | §3–§7 的内核与工作进程部分 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改） |
| 外壳（Sonnet） | 主进程 `app.*`（复制、移除、路径检查，`crates/host`）；界面：安装确认框、插件页的版本表（切换、固定、移除、撤销升级、确认权限）、缺少插件的提示、设置里的密钥页、表单的密钥字段、`network.allow` 的“被上层限制”标记；新增 id 的文字 | 同前 |
| 插件与测试（Sonnet） | 第一阶段：`plugins/org.onedesk.http/`（类型 `request`：方法、地址〔授权地址〕、请求头〔多行 `名: 值`〕、请求体；动作“发送”，输出文字，摘要含状态码与耗时；结果页签“响应头”；地址和请求头里可写 `:name` 参数与 `{{secret:名字}}`）；`e2e/fixtures/plugins/org.onedesk.sample/0.2.0/`（示例插件的新版本：`upgradesFrom: ">=0.1.0"`，`migrate` 给 body 加 `note` 字段，多要一项 `network` 权限）和一个清单有错的包；vitest。第二阶段（合并后）：`e2e/round4.spec.ts`（起一个本机 HTTP 测试服务器） | 同前，另加 `e2e/fixtures/**` |

内核不许出现任何具体插件的名字或逻辑。界面外观不得走样：纯假数据模式（`e2e/workbench.spec.ts`）继续全过。

## 9. 完成标准

- 内核必须有的测试：清单新增部分的每种拒绝；`inspect` 对各种坏包；安装/移除的审计；未确认的版本不能启用；权限增加需重新确认、子集不需要；两个版本同时各管各的资源且命令、设置只有一份；升级接管后绑定新版本；一条 `migrate` 失败则全部不动；`migrate` 里发起写入被拒；不能接管的留在旧版本；切回旧版本；撤销升级（未改的退回、改过的列出）；移除后显示缺少插件、装回恢复；从历史恢复旧版本的快照；密钥：不在名单的名字被拒、别的插件的密钥被拒、未声明明文却取值被拒、代入后插件和运行记录里没有真值、表单密钥字段的值不进库（直接读数据库文件验证）、永久删除连带删除密钥；网络：未授权主机、重定向到未授权主机、`network.allow` 收紧、空名单、回环地址、超时、取消、正文截断、合并计数。全部用本机测试服务器和内存密钥库。
- 外壳：`crates/host` 的测试含复制、目标已存在、包外符号链接、超大包、移除后不自动装回；其余同前。
- 交接文件：`docs/handoff/round4-kernel-done.md`、`round4-shell-done.md`、`round4-tests-done.md`。
