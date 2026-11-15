# 第四轮收尾（外壳）完成报告

分支 `claude/r4-finish-shell-2806a3`。

## 改了什么
- `src/workbench/i18n/index.tsx`：`runError` 现在读 `RunError.reason`：内核自己的失败码照旧；宿主错误（`denied`/`invalid`/`conflict`/`invalidParams`）按 `code.reason` → `reason.xxx` 取字，再退回错误码的通用句，再退回消息/兜底句。导出 `buildI18n` 供测试。
- `kernel-texts.ts`：补 `invalid.timeout`、`invalidParams.tooLarge`、清单原因 `badSecretsField`（英中）；`hostNotAllowed`、`blockedByPolicy` 的字改成“主机和端口”，说明不写端口的条目只允许 80 和 443（D317）。其余 reason 之前已有字。
- `kernel-texts.test.ts`：新增用例，对 denied/invalid/conflict/invalidParams 下所有可能的 `reason`（取自 round4-kernel-done 的两节）逐个检查英中都有具体文字（不是只落到错误码的通用句）；`badSecretsField` 进清单原因表。
- 外壳其余部分没改：运行失败的结果区、状态栏、任务面板本来就走 `runError(run.error)`。

## 测试结果
`pnpm typecheck`、`pnpm lint`、`pnpm test`（196）通过；`cargo test -p onedesk-host`（9+19）通过；host clippy `-D warnings` 通过；`E2E_PORT=1433 playwright e2e/workbench.spec.ts` 23 通过、1 个（截图审阅用例）本来就是跳过；已 `git checkout -- docs/screenshots`。

## 真内核走查（`onedesk-devhost`，`ONEDESK_SECRET_STORE=memory`，数据目录在会话临时目录；浏览器面板，zh-CN）
- 安装：路径输入 → 确认框列出名称、版本、权限（0.2.0 显示“访问网络 新增 example.com”、已安装 0.1.0）；坏包被拒并显示“清单不符合格式”：**通过**。
- 装 0.2.0 自动切换与接管：先把“示例查询”建成资源（绑 0.1.0），再装 0.2.0 → 绑定变 0.2.0，body 多了 `note`：**通过**。注意：**夹具 0.2.0/0.3.0 的 `upgradesFrom: ">=0.1.0 <0.2.0"` 被内核拒绝**（`badUpgradesFrom`，Rust semver 需要逗号），所以我用改成 `>=0.1.0` 的临时拷贝；`e2e/fixtures/plugins/org.onedesk.sample/*/manifest.json` 需要测试会话修（写 `>=0.1.0, <0.2.0` 或 `>=0.1.0`）。
- 版本表：两个版本、资源数、使用中：**通过**。切回 0.1.0：资源仍在 0.2.0：**通过**。撤销升级：确认框、资源回到 0.1.0 且 body 回到原样：**通过**。
- 移除没有绑定的版本：确认框“没有资源在用它”：**通过**；移除有绑定的版本：确认框“仍有 1 个资源在用它”，之后资源页显示“缺少插件，需要 org.onedesk.sample@0.2.0”：**通过**；重新安装该版本后资源恢复：**通过**。
- 0.3.0（`migrate` 抛错）：手动“启用此版本”显示“新版本没能接管某个资源。没有任何改动。”：**通过**；装 0.3.0 时的自动切换失败**没有任何提示**，只是活动版本留在 0.2.0（见下“内核/设计问题”）。
- 密钥页（命令面板“密钥”）：新增、改值对话框、列表只显示名字和时间，页面文本里没有值：**通过**；“删除”按钮存在，没有点它：**没走**。
- HTTP 请求：“保存并发送” → 状态栏 `#4 · 200 · 8 毫秒 · 16 字节`，结果区显示正文，本机服务器收到请求头 `X-Plain: yes`：**通过**。地址改成同一主机别的端口（18082，未保存）：被拒，文字“这个主机和端口不在插件允许访问的名单里（…）”，服务器没收到：**通过**。工作区配置设 `network.allow=example.com` 后再发已保存地址：“工作区或环境的设置（network.allow）不允许访问这个主机和端口”：**通过**。
- `{{secret:名字}}` 请求头：**失败**——运行被拒，显示“插件不能使用这个密钥”（`denied/secretNotAllowed`）。原因见下，是插件清单，不是外壳。所以“密钥在请求头里被宿主换成真值”这一条在真内核下**没有走通**。

## 内核 / 插件缺陷（没改，需要对应会话处理）
1. **HTTP 插件（`plugins/org.onedesk.http/manifest.json`）在 D318 之后用不了密钥**：类型只声明了 `url`（`grants: network`）；请求头、请求体没有声明成 `{ "type": "longtext", "secrets": true }` 的字段，所以按资源的密钥范围里没有 `apitoken`。需要把 headers（和 body）声明成 `secrets: true` 的字段，并让页面绑定到它们（也许还要 `requires.secrets`）；改后应有测试：保存带 `{{secret:名字}}` 的请求头后发送，服务器收到真值。
2. 夹具 `upgradesFrom` 写法被内核拒绝（见上）。
3. 手动“启用此版本”会把该版本**固定**（0.1.0 显示“已固定”）；之后再启用 0.2.0，0.1.0 的“已固定”还留着，而 0.2.0 才是使用中，固定的含义变得含糊。内核行为，可能是有意的，请协调会话确认。
4. 自动切换（`rescan` 时）失败不留任何用户可见的提示，也不进界面通知（只有手动启用才报错）。建议内核给 `plugins` 事件或插件树节点带一个“升级失败”的状态，外壳再配字。
5. 真内核的工作区配置页只有 `ui.language`，没有 `network.allow` 的编辑入口（我用 `params.set` 协议调用设的）。如果要给用户入口，需要内核声明这个参数。

## 没验证的
- 密钥“删除”；环境页 `network.allow` 带端口的“不生效”徽标；桌面应用（Tauri 窗口）里系统文件夹选择框（只在浏览器的路径输入框里走了）；新版本多要一项权限时“升级前重新确认”的单独确认步骤（安装确认框里已经列出权限，没有出现第二次确认，是否符合设计请协调会话判断）；暗色主题和窄窗口下的对话框。

## 协调会话验收发现（`round4-accept-findings.md` A1–A8）的处理
先合并了 `claude/onedesk-coord-2-91a88b`（含 HTTP 插件清单把请求头/请求体声明为 `secrets: true`，cd7f32a）。上面“内核/插件缺陷”第 1 条因此已被协调分支解决：对着真内核重新走了一遍，请求头 `X-Auth: Bearer {{secret:apitoken}}` 发出后，本机服务器收到的是真值 `Bearer <值>`：**通过**。

- **A1 已修**：`mixed-client.ts` 把 `shell:` 目标算作内核页面。真内核下密钥页标题旁不再有“演示数据”徽标（状态栏的“部分为演示数据”是整个工作区的提示，没动）。
- **A2 已修（列宽部分）**：四列总宽 1008 → 700；实测表格宽度等于卡片宽度、不再超出。“使用者”仍显示资源 id（没做按名字显示，记入 `todo.md`）。注意：浏览器面板本身只有 800 宽，整页有横向滚动条，这与密钥页无关，我没动。
- **A3 已修**：连着内核时顶栏右上角的设置按钮变成菜单：“设置”（⌘,，原行为）和“密钥”。纯假数据模式仍是原来的单个按钮（保持 e2e 不变）。⌘, 快捷键不变。
- **A4**：见前文，真内核下 `denied` 现在显示具体原因（`secretNotAllowed`/`hostNotAllowed`/`blockedByPolicy`），已看到。
- **A5 已修（代码）**：安装确认框在“被拒”时把 `problem.detail` 作为次要的代码块文字显示在原因下面；`problem.params.reason` 的各值本来就有文字（清单原因表 + `notFolder`/`alreadyInstalled`）。**没有在界面里再看一遍**（只做了类型检查和全部测试）。
- **A6 已修**：欢迎页按钮和 ⌘N 的“默认新建”现在跳过 `node.`/`env.`/`config.` 开头的内核条目（分组等），取第一个插件类型；真内核下按钮文字用该条目自己的名字（空工作区实测点了得到“未命名请求”）。纯假数据模式文字和行为不变。
- **A7 外壳已支持，插件还要改一行**：条带表单里的字段原来都是固定宽度。外壳现在认 `fill: true`（`StripField` 新增 `fill`，占满剩余宽度，最窄为 `--strip-field-width-wide`）。HTTP 插件 `main.js` 里 `url` 那个字段需要加 `fill: true`（`plugins/**` 不是我能改的，请插件/测试会话加）。没有对着真内核看效果（因为插件还没加）。
- **A8 记入 `docs/handoff/todo.md`**，没改。

验证：`pnpm typecheck`、`pnpm lint`、`pnpm test`（197）通过；`e2e/workbench.spec.ts` 假数据模式 23 通过、1 跳过，截图已还原。host 的 Rust 部分这次没有改动，没有重跑。
