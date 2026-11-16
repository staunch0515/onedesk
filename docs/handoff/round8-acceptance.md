# 第八轮验收记录（协调会话，2026-11-16）

协调分支 `claude/onedesk-coord-3-f0c048`。做法同前（`onedesk-devhost`，`ONEDESK_SECRET_STORE=memory`，数据目录和授权文件夹都在会话的 scratchpad；本机临时 HTTP 服务 `e2e/fixtures/transfer-server.mjs`；先用协议核对语义，再在界面上操作）。夹具：`e2e/fixtures/plugins/com.example.transfer`、`com.example.board`、`com.example.board-extra`、`e2e/fixtures/market/`。截图：`docs/screenshots/round8-accept/`。

## 逐条结果（`round8-plan.md` §1）

| 项 | 结果 | 怎么验证的 |
|---|---|---|
| 下载到授权文件夹，内容不经过插件 | 通过 | 协议：下载 60 MB，磁盘上的文件与服务端内容 SHA-256 相同 |
| 上传、外部程序输出存成文件 | 通过 | 协议：上传返回 200；`capture`（`cat`）得到的 `.copy` 文件 SHA-256 相同；审计有 `transfer.capture`（字节数、退出码、耗时、路径） |
| 取消后不留半截文件 | 通过 | 协议：慢速下载 1.5 秒后取消，运行状态 `cancelled`，目录里没有目标文件和 `.part-` 文件 |
| 各种拒绝 | 通过 | 协议：目标已存在 `conflict/exists`；路径在授权外 `denied/outsideGrant`（磁盘上没有文件）；主机没授权 `denied/hostNotAllowed`；404 不写文件。`network.allow`、程序未声明、`process.allow` 由界面检查覆盖，我没亲手试 |
| 任务面板里看得到进度 | 通过（界面上我没亲手看） | 协议：运行中 `progress.message` 是字节数；界面由外壳会话走查和界面检查覆盖 |
| 依赖方的类型出现在别人的树里，用别人的页面 | 通过 | 界面（截图 01）：“便签甲”在“看板”树里，页面是看板的页面，操作区“保存 / 转为大写 / 大声说”；协议：`upper` 事件返回大写、结果区没有 `view` 页签 |
| 依赖方自己的动作在操作区并能运行 | 通过 | 界面（截图 02）：“大声说”的结果显示在结果区 |
| 没导出的树：类型不能新建，插件页写明 | 通过 | 协议：`denied/notExported`，`params.export = com.example.board:hidden`；`plugin.get` 的 `unmetExports`。插件页的文字由外壳会话走查，我没亲手看 |
| 安装确认框列出权限 `pages` | 通过 | 协议：`app.inspectPlugin` 的权限 `pages = com.example.board:card`；确认框的样子由外壳会话走查 |
| 停用被依赖方被拒 | 通过 | 协议：`conflict/dependents` |
| 市场页选包后不显示“未保存” | 通过 | 界面（截图 03） |
| 指纹是 SHA-256 | 通过 | 协议：指纹 64 个十六进制字符，三次安装的确认都有效 |
| 运行错误里写明程序、主机 | 通过（我没亲手看修改后的） | 内核后补了主机名（`34a9126`），界面检查对应用例通过 |

## 独立审查与验收中发现的

`round8-review.md`：8 条（2 条必须修：历史运行页把依赖方的内容交给页面所有者；预算可被重叠调用无限暂停），内核修了 #1、#2、#3、#5、#6 并补了测试缺口，外壳修了 #5 的界面一半；#4、#8 记入 D362，#7 记 `todo.md`。新增 D361、D362。外壳对齐时发现网络被拒的错误没带主机名，内核已补。验收中我发现一条：被取消的下载在审计里没有 `transfer.download` 那一行（记 `todo.md`，没修）。

## 检查结果

`E2E_PORT=1432 pnpm check` 第二遍从头到尾通过（exit 0）：单元测试 339；Rust 测试、clippy 通过；界面检查 140 通过、1 跳过（原有的截图审阅用例）；`round8.spec.ts` 没有 `test.fixme`。

第一遍没过：8 个连真内核的用例在启动处失败——`src-tauri/build.rs` 留下的空占位文件被 Tauri 的构建复制成 `target/debug/onedesk-worker`，盖掉了真的工作进程（`todo.md` 里“变成 0 字节”的老问题，原因现在查明；新工作树里没跑过 `scripts/prepare-bundle.sh` 就会这样）。跑了 `sh scripts/prepare-bundle.sh` 之后第二遍通过。另有假数据模式的拖动用例第一遍失败一次，单独重跑 3 次都过，第二遍也过（负载下不稳定）。

## 没做到 / 没验证

- 桌面窗口里的画面和操作、打包出的 `.app`、真钥匙串、https（搬运只用本机 http 验过）。
- “用别人的输出类型”（按 D352 推后）；D339 的收紧、清单缓存、空闲回收、第一版旧库升级没做。
- 搬运的进度、插件页的 `unmetExports`、确认框里的 `pages`、被拒文字里的名字：界面上我没亲手看，依据是外壳会话的走查和界面检查。
- 没有总量的下载进度显示“(0%)”（外壳会话发现，记 `todo.md`）。

## 新增的决定

D352–D360（范围内）、D361（暂停预算累计最多 1 小时）、D362（`http-body`、`bytes` 列为直接依赖；指纹不需要升级旧数据）。
