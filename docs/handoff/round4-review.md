# 第四轮合并前审查（独立审查，只看代码与设计）

审查对象：`git diff 31ef6d3 c83cbb6`。行号以该提交为准。协议补充的字段名在本文件里定死，内核会话按“只增不改”加进 `crates/protocol`，外壳按这里的名字写。

## 协议补充（D312）

- `InstallPreview.fingerprint: string`——这个包的权限清单指纹（内核算）。
- `app.installPlugin` 的参数改用新类型 `AppInstallParams { folder, id, version, fingerprint }`（界面把确认框里看到的三样带回来）。
- `plugin.confirmPermissions` 的参数改用新类型 `PluginConfirmParams { plugin, version, fingerprint }`。
- `PluginVersion.permissions: PluginPermission[]`、`PluginVersion.fingerprint: string`——每个版本自己的权限，不是活动版本的。
- `plugin.rescan` 的参数 `PluginRescanParams { builtin: string[] }`（`<id>@<version>` 列表，主进程给出它自己复制的内置插件）；工作进程命令行同时加可重复的 `--builtin <id>@<version>`。

## 发现

| # | 级别 | 位置 | 问题 | 处理 |
|---|---|---|---|---|
| 1 | 必须修 | `crates/kernel/src/host.rs:155-200`、`network.rs:86-105`、`secrets.rs:207-224`、`runs.rs:582-589` | 插件能自己给自己授权：用 `resources.create/update` 往自己类型的资源里写授权地址或密钥引用，主机就进了白名单（还算“明确写出”，回环也放行），密钥名也进了可用范围。`migrate` 返回的 body、`onEvent` 返回的修改是同类路径 | 内核（D311）：操作者是插件时，写入管线拒绝新建或修改“授权地址”字段和“密钥引用”字段（`denied`，`reason: grantField`）；升级接管时这两类字段必须与旧值相同，否则整批失败；`onEvent` 的修改里去掉这两类字段。只有用户（`page.save`、界面命令）能改 |
| 2 | 必须修 | `src/workbench/pages/plugin-page.tsx:193-199`、`runs.rs:713-714` | 确认权限的对话框列的是活动版本的权限，不是待确认版本的 | 内核：`PluginVersion.permissions`、`fingerprint`；外壳：确认框显示该版本自己的权限，并把 `fingerprint` 带回 |
| 3 | 必须修 | `runs.rs:263-266` | 在 `new:` 目标上直接运行时，草稿里填的密钥明文进了运行的输入快照 | 内核：按类型的字段声明过滤，与已保存资源同一条路径；加“直接读数据库文件找不到”的测试 |
| 4 | 应该修 | `install-dialogs.tsx:62-64`、`crates/host/src/lib.rs`、`install.rs:84-97` | 确认的包和实际复制的包可能不是同一个；复制时跟随链接、复制前不再检查 | D312：界面带回 `id/version/fingerprint`；主进程复制（不跟随链接，遇到链接即拒绝）后对**目标文件夹**重新 `plugin.inspect`，三样有一样不符就删掉目标并拒绝；一致才 `rescan`，并以这个指纹记为已确认 |
| 5 | 应该修 | `versions.rs:109-126` | 没见过的插件所有版本都被自动确认，比 D299 宽：别的工作区装的、手动拷进文件夹的都自动确认 | D313：只对主进程给出的内置清单（`--builtin`、`rescan.builtin`）自动确认；其余一律“已安装、未确认” |
| 6 | 应该修 | `pipeline.rs`（undo_upgrade）、`kernel.rs:136-145` | 撤销升级取“升级前版本”用字符串排序且取的不是升级前的活动版本；撤销或手动切回之后，下次启动或 `rescan` 又自动升回去 | D314：批里记下升级前的活动版本；撤销升级、手动切到较旧版本时把那个版本记为固定；版本比较一律用 semver |
| 7 | 应该修 | `kernel.rs`（kind_meta_v）、`runs.rs`（resolve_action） | 绑定到未确认版本的资源照样运行那个版本的代码（移除后装回同版本号但权限更多的包） | D315：未确认版本的代码绝不激活；绑定它的资源状态为 `disabled`，原因 `unconfirmedVersion` |
| 8 | 应该修 | `network.rs:205-228` | 重定向到别的主机时，代入了密钥的请求头照发 | D316：主机（含端口）变了就丢掉含代入密钥的头以及 `Authorization`、`Cookie`、`Proxy-Authorization` |
| 9 | 应该修 | `plugin-page.tsx:68,195` | 移除版本的对话框读错字段（`resources`，协议是 `resourceCount`），真内核下总说没有绑定的资源 | 外壳 |
| 10 | 应该修 | `round2.rs:350-368`、`kernel.rs:211-217` | 历史恢复、恢复删除没按 §7.6 的版本规则；恢复、升级带来的新授权主机没有 `network.grant` 审计 | 内核：快照绑定的版本还在就绑定回去；不在但活动版本能接管就 `migrate`；都不行 `invalid/needsVersion`。授权地址因恢复而变化同样记 `network.grant` |
| 11 | 应该修 | `network.rs:154` | 没有 `.no_proxy()`（环境里的代理会绕过地址固定和回环检查）；DNS 不受超时约束；方法不限、`Host` 头可伪造 | 内核：禁用环境代理；整个请求（含解析）在超时内；方法只许 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS；拒绝插件设置 `Host`、`Content-Length`、`Transfer-Encoding`、`Connection` |
| 12 | 顺手 | `runs.rs:832`、`round2.rs:179` | 内核给出的文字键 `unconfirmedVersion`、`restrictedByUpperLayer` 外壳没有文字 | 外壳补；内核在交接文件里列全 |
| 13 | 顺手 | `install.rs:121`、`manifest.rs:746` | “已移除”只比前缀，id 形如 `x-1.2.3` 的会撞；临时目录残留被当成损坏的插件 | 外壳：按 `<id>@<version>` 精确记；临时目录放在 `plugins/.tmp/`。内核：扫描时跳过以 `.` 开头的目录 |
| 14 | 顺手 | `secrets.rs:162` | 先写钥匙串后写库：`page.save` 冲突失败时钥匙串已被覆盖 | 内核：数据库提交成功之后再写钥匙串；写钥匙串失败则返回错误并把该字段标为未保存 |

已核对未发现问题：内核与主进程没有插件 id 或特判；界面没有绕过 token；`SecretSetParams` 的 Debug、密钥名不许 `/`、resolve/event/save 去掉密钥字段、响应头和正文抹掉代入过的值、删除与永久删除的清理、网络错误详情不进沙箱；白名单匹配（通配、用户信息、尾点、IDN 匹配不上就拒绝）、每跳复查、固定实际连接的地址、正文边读边截断、合并计数用单独的表；安装的路径段检查、id/版本与文件夹不符的拒绝；`migrate` 的只读限制、`readFrom`、升级单事务；只新增迁移；密钥输入框不回显、草稿只在内存、不进 URL；HTTP 插件只用宿主接口、`:name` 不误伤 `http://`、端口、`{{secret:x}}`。
