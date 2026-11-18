# 第十三轮验收记录（第四个协调会话，2026-11-18）

范围：多工作区与多窗口（`round13-plan.md`；旧库升级按 D403 取消）。做法同前：`onedesk-devhost`，`ONEDESK_SECRET_STORE=memory`，数据目录在会话 scratchpad；先协议后界面。截图：`docs/screenshots/round13-accept/`。协调分支 `9af3798` 之后。

| 项 | 结果 | 怎么验证的 |
|---|---|---|
| 新建：复制配置与插件启用状态、不复制数据 | 通过 | 默认工作区设 `ui.density=compact`、停用网址插件、建一条笔记后 `app.createWorkspace {name:"第二"}`；用 `?workspace=<id>` 连新工作区：资源为空、`ui.density` 是 compact、网址插件 `enabled:false`；界面（截图 01）紧凑密度、树为空 |
| `app.workspacesChanged` 推给其它连接 | 通过 | 新建后另一连接收到 1 条 |
| 两个连接各连一个工作区互不影响；`current` 按连接 | 通过 | A 在 Default、B 在 第二，`app.workspaces` 各自标 current |
| 占用中删除被拒 | 通过 | B 连着 第二 时删除 → `conflict/inUse` |
| 改名 | 通过 | `app.renameWorkspace` → null，列表名称更新 |
| 一个连接切换不带走别的（D406） | 通过 | B 切到 第三 后，A 仍在 Default、资源仍是它的；之后新开的未指定连接默认到 第三（D406 允许） |
| 最后一个连接关闭后工作进程停 | 通过 | B 关闭 3.5 秒后删除 第二 成功；剩 2 个工作进程 |
| 删除移到 trash、不真删 | 通过 | `trash/workspaces/` 下有该文件夹，库文件都在 |
| 界面：工作区菜单、管理对话框、切换 | 通过 | 菜单列出工作区与“新建/在新窗口打开/管理”（截图 02）；管理表（截图 03）；菜单点 Default → 整页重载，标题栏 Default、树里是它的笔记 |
| 浏览器“新窗口” | 我没亲手点 | 界面检查覆盖（`openWindow` 开带 `?workspace=` 的标签页） |

小问题：工作区菜单里打勾的一项与没打勾的一项文字不对齐（“Default”没有为勾留位置），记 `todo.md`。管理表里被别的连接占用的工作区，删除按钮仍可点（点了会得到 `inUse` 提示）。

## 检查结果

第一遍 `E2E_PORT=1434 pnpm check`（6ae7f40 合并后）：单元测试、Rust、clippy 通过；界面检查 171 通过、13 失败、45 没跑。单独跑 `round12.spec.ts` 也复现（9 失败）：运行被 `interrupted`、`workerGone: workspace is locked by another worker`——本轮主进程的回归（多工作区的连接绑定/工作进程启停），已派外壳会话修。不合并。
