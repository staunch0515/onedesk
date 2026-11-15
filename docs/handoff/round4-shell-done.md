# 第四轮外壳（claude/week1-shell-74b52c）：安装、版本、密钥

已合并 `claude/week1-slice-3b4ae5`（31ef6d3）。

## 主进程（`crates/host`）
- `app.inspectPlugin`：转给工作进程的 `plugin.inspect`，不复制。
- `app.installPlugin`：先检查文件夹（`install::check_package`）：必须是绝对路径、是真文件夹、读得到 `manifest.json`、包内没有指向包外的符号链接、没有指向文件夹的链接、总大小 ≤ 200 MB（`MAX_PACKAGE_BYTES`）；再 `plugin.inspect`，`valid` 必须为 true；目标 `plugins/<id>/<version>` 已存在就拒绝（`invalid`/`alreadyInstalled`）；先复制到同目录下的 `.<version>.tmp-<pid>` 再改名；最后 `plugin.rescan`。包内指向包内文件的链接按文件复制。安装与移除用一把锁串行。
- `app.removePlugin`：把版本挪到 `plugins/.removed/<id>-<version>-<毫秒>`（不删），再 `plugin.rescan`。启动时复制内置插件会跳过“被用户移除过且现在不存在”的版本（用户之后自己又装回的不受影响）。
- 拒绝原因都是 `invalid` 带 `reason`：`notAbsolute`、`notFolder`、`noManifest`、`symlinkOutside`、`symlinkFolder`、`tooBig`、`notValid`（详情里是 `problem`）、`alreadyInstalled`、`badTarget`；没装过的版本移除是 `notFound`（`what: plugin`）。
- 桌面版用已有的系统选择文件夹命令；浏览器模式用输入路径的对话框。
- 测试（假工作进程新增 `plugin.inspect`/`plugin.rescan` 应答，rescan 在工作区里留一行记录）：`cargo test -p onedesk-host` 8 + 15 通过（复制并 rescan、临时目录不残留、目标已存在拒绝、无效清单不复制、不是文件夹/相对路径/无清单/包外链接/文件夹链接/超大包各拒绝、移除后 rescan、重复移除、不安全的名字、下次启动不装回），clippy 无警告。

## 界面
- 协议客户端：`app.*`、`secrets.*`、`plugin.activateVersion/setPinned/undoUpgrade/confirmPermissions`（真客户端与混合客户端；演示模式没有 `app`/`secrets`，相关入口不出现）。
- 安装：插件树工具栏“安装插件…”（只在有真内核时），命令面板里也有；桌面用系统对话框，浏览器先问路径；确认框列出名称、`id@版本`、描述、全部权限（`InstallPreview.addedPermissions` 里的标“新增”）、已装版本；清单有错时显示原因并不能确认；点“安装”= 用户确认：先 `app.installPlugin` 再 `plugin.confirmPermissions`。
- 插件页（真插件）：版本表有 活动/固定/未确认 标记、绑定资源数、“激活”“固定”“移除”；激活未确认的版本先弹权限确认；移除仍有资源绑定的版本先写明数量；卸载 = 逐个移除全部版本（先确认）；升级后提示“N 个已升级、M 个留在旧版本”；有最近一次升级时显示“撤销升级”，撤销后若有升级后改过的资源，列出让用户勾选再撤销。没声明 `files` 的插件不显示“授权文件夹…”；对真插件“检查更新”隐藏（上一轮已做）。
- 缺少插件的资源页：沿用通用提示（`state.missingPluginHint`）和内核给的原因。
- 密钥页（`shell:secrets`，命令面板“密钥”、声明了 `secrets` 权限的插件页上的“密钥”动作进入）：列出名字、写入时间、使用者；新增、改值（对话框）、删除（确认）；值框是密码框，提交后立即清空，页面里不出现值。
- 表单的密钥字段（真页面）：密码框，永不回显已存的值，只在占位符里写“已保存——输入新值可替换”；留空等于不改。演示页保持原样。
- 环境页的“被上层限制”标记沿用已有的 `EnvParam.restricted`（文字取内核给的 `Label`）。
- 文字：安装、版本、密钥、权限名（`network`、`secrets`、`secrets.plaintext`、`programs`、`plugins`）、审计操作（`plugin.install/remove/confirm`、`network.request/grant`、`secrets.set/delete`）、错误原因（上面的 reason、`needsVersion`）；文字齐全性测试已加入这些。

## 测试与检查
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（163）通过；新增：安装对话框（权限与“新增”、确认顺序、拒绝、桌面/浏览器路径）、插件页版本表（权限确认、移除前的绑定数、撤销升级与挑选、files 与卸载）、密钥页（只写不读、清空、改值、删除）、密钥表单字段；纯假数据 e2e 22 过 1 失败 1 跳过（失败的仍是之前就知道的“tree: drag onto a group”偶发项）。截图已还原。

## 我做的决定 / 假设（内核合并后对一下）
- `PluginVersion` 的“绑定资源数”“权限是否已确认”和 `PluginDetail` 的“最近一次升级”协议里还没有：界面先用可选字段 `PluginVersion.resources?: number`、`.confirmed?: boolean`、`PluginDetail.lastUpgrade?: {batch, count}`（`types.ts`）。**内核加了字段后以生成类型为准改这几个名字**；没有这些字段时界面只是不显示计数/标记、不出现撤销按钮。
- 权限确认框列的是 `plugin.get` 的 `permissions`（假定是待确认版本的清单）；如果内核按版本分开给，要改。
- 对着真内核没有实跑：内核的第四轮还在并行开发，工作进程还没有 `plugin.inspect`/`rescan`，主进程部分只用假工作进程测过；界面只用假客户端测过。
- 在已打开的“密钥”页里，`secrets.list` 在 `secrets`、`plugins` 事件上刷新——内核实际发的主题名未知，写入后页面也会主动重新读一次。

## 合并后的对齐（对着真内核跑过）
- 已合并 `claude/week1-slice-3b4ae5`（74d1445）。
- 类型：`PluginVersion` 直接用生成类型（`resourceCount?`、`confirmed`），`PluginDetail` 用生成类型加 `permissions` 的演示超集；`lastUpgrade` 是 `UpgradeBatchInfo`（`batch/from/to/count/at/undone`），已撤销的不再显示“撤销升级”；`PluginDetail.unconfirmed` 用来标“未确认”；假实现补 `unconfirmed: []`。审计行的 `count` 显示成“×N”。
- 文字：补齐内核第四轮的全部审计操作名（`plugin.upgrade/undoUpgrade`、`secrets.get`、`storage.*`、`ui.*` 被拒等）、全部错误原因、清单拒绝原因（`badUpgradesFrom` 等）、`unconfirmedVersion`、`restrictedByUpperLayer`；错误文字对清单拒绝原因也能查到（`InstallPreview.problem` 是原样的数据对象，也认了——之前显示成 `[object Object]`）；缺少插件时说明“需要 <id>@<版本>，没有安装”。
- 读了“我做的决定”：确认的新版本由内核在确认权限时自动切换——这一步失败（`migrateFailed`）不应让“安装”失败，所以主进程在文件装好后 `plugin.rescan` 出错也照样成功返回，并带 `warning`；界面里确认权限的调用出错同样降为警告，提示“已安装，但没有切换过去：原因”。（主进程测试 16 项，含这一条。）切回旧版本时内核的 `upgraded=0, kept=N` 提示改成“新建的内容改用 X，已有的 N 个资源仍用现在的版本”；版本表对真插件去掉“备注”列（内核不给），列宽改小，原来被截断。
- **钥匙串**：devhost 的工作进程继承环境变量，我在启动 devhost 前设了 `ONEDESK_SECRET_STORE=memory`（内核文档里的内存实现，`secrets.rs` 里写明“不碰钥匙串”），所以没有碰真钥匙串。注意 `e2e/kernel-host.ts` 的 `startHost` 不设这个变量，只是继承调用者的环境——`e2e/round4.spec.ts` 跑的时候如果环境里没有它，调试构建会用真钥匙串（服务名 `onedesk-dev`）。建议测试会话在 `startHost` 里固定设 `ONEDESK_SECRET_STORE=memory`。
- 对着真内核走的流程（devhost + 临时目录 + 临时 Playwright 脚本，已删除，没有提交）：
  - 安装 `org.onedesk.sample/0.2.0`：确认框列出“网络访问 · 新增 · example.com”，已装版本“0.1.0”；安装后示例查询被接管，页面显示“Note: migrated from 0.1.0”；版本表两行（0.2.0 活动 / 0.1.0，各自的绑定资源数）；切回 0.1.0（提示 0 个升级、1 个仍用旧版本，版本表活动版本变了）；“撤销升级”后资源退回 0.1.0、按钮消失。
  - 安装 `broken`：确认框写“插件包被拒绝：清单不符合格式”，“安装”不可点。
  - 安装 `0.3.0`（`migrate` 抛错）：安装成功但警告切换没有发生；手动“激活”0.3.0 得到错误“新版本没能接管某个资源。没有任何改动。”，活动版本仍是 0.1.0、绑定数不变。
  - 移除仍有 1 个资源绑定的 0.1.0：确认框写“1 个资源仍在用它…”；确认后资源节点灰显（`missing-plugin`），打开页面显示“需要 org.onedesk.sample@0.1.0，没有安装”；从内置包再装 0.1.0 后资源恢复、“运行”可用。
  - 密钥页（命令面板“密钥”）：新增 `api-token`，列表只有名字和时间，页面 DOM 里没有值。
  - HTTP 请求：新建、填本机测试服务器地址、请求头 `X-Plain: yes`、“保存并发送”：状态栏 `#1 · 200 · 7 ms · 22 bytes`，结果区显示正文，服务器收到了请求头；地址不保存就换成另一个主机（`localhost`）：被拒（`denied`），服务器没收到；在工作区配置里设 `network.allow=example.com`：保存过的主机也被拒；环境页 `params.env` 给出 `restricted: "restrictedByUpperLayer"`（环境页的“不生效”徽标在“状态”列，窄窗口下被挤到表格右边需要横向滚动，在 DOM 里有）。
- **发现的内核/插件问题（没改它们的文件）**：
  1. 夹具 `e2e/fixtures/plugins/org.onedesk.sample/0.2.0/manifest.json` 的 `upgradesFrom: ">=0.1.0 <0.2.0"`（空格分隔）被内核拒绝（`badUpgradesFrom`，semver 要求逗号：`>=0.1.0, <0.2.0`）。我把它复制到临时目录改成逗号后才装得上。要么夹具改写法，要么内核接受 npm 式的空格范围。
  2. `{{secret:名字}}` 代入走不通：我建的密钥 `api-token` 在 HTTP 插件里用于请求头时被拒（`network.request` 审计 `denied/secretNotAllowed`）——插件清单没有声明 `requires.secrets.names`，HTTP 请求类型也没有“密钥引用”字段，用户在页面上无法授权某个密钥给这个插件。所以“请求头里写 `{{secret:名字}}` 被代入”没能验证。需要插件会话（声明名字或加字段）或协调会话定方案。
  3. 运行因宿主调用被拒而失败时，`Run.error` 只有 `{code:"denied", message:""}`，没有原因（`hostNotAllowed`/`blockedByPolicy`/`secretNotAllowed`…），界面只能写“denied — 不允许”，用户不知道为什么。建议内核把 `reason` 放进 `RunError.detail` 或 `hint`（审计里有，页面上没有）。
  4. 控制台有一条 `Select is changing from uncontrolled to controlled` 警告，出现在打开示例查询页（带环境选择）时；仍没有追查来源，不影响功能。
  5. 插件页顶部标题写成“Sample 0.2.0”（取自该版本清单里的名字），切回 0.1.0 后写“Sample”——名字随版本变是夹具的写法，没问题，只是看起来像版本号。
- 检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`（194）、`cargo test -p onedesk-host`（8+16）、clippy 通过；纯假数据 e2e 23 过 1 跳过；截图已还原。
