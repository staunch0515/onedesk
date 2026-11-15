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
