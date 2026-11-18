# 第十二轮验收记录（第四个协调会话，2026-11-18，草稿：修复后复验再定稿）

协调分支 `claude/onedesk-coord-4-3ac9ba`。做法同前（`onedesk-devhost`，`ONEDESK_SECRET_STORE=memory`，数据目录在会话的 scratchpad；先协议后界面；HTTP 用本机临时 Python 回显服务器，`network.allow` 只放它的端口）。截图：`docs/screenshots/round12-accept/`。

## 第一遍（合并 e647527 之后）

| 项 | 结果 | 怎么验证的 |
|---|---|---|
| 拖资源到综合上：加入引用、资源不动 | 通过（协议） | `tree.move inside` 到综合 → `handled:true`、“已加入 1 项”（中文，带了 `locale`）；笔记的父节点仍为顶层；再拖同一条 →“已加入 0 项”不重复 |
| 综合嵌套综合 | 通过（协议） | 拖综合二到综合一 → 普通移动（返回 `{}`），成为真子节点 |
| 展开综合 | 通过（协议） | 第一批是真子节点（综合二），`next` 续出引用节点：名称、图标、`target: resource:<id>` |
| 页面上移除、上移 | 协议通过；**界面不通过** | `page.event` 带 `context.row` 时上移、移除都对，移除不删资源；界面上点行按钮发出的 `page.event` 没有 `row`，什么都不变（外壳缺陷，已派） |
| 被删后失效 | 通过 | 删掉笔记后展开显示“（已不存在）”、`unlink` 图标、没有 `target`；表格那一行 `rowTargets` 为 null |
| 综合/集合页的表格 | **不通过** | “类型”列显示 `[object Object]`、“图标”列显示图标名文字（截图 01、03；D396，已派插件） |
| 集合：按条件列出、资源变了再展开是新结果 | 通过 | 文字 `zeta` → 1 条；新建正文含 zeta 的笔记后再展开 → 2 条；按类型 `org.onedesk.link:link` → 只有网址；页面“共 2 条” |
| HTTP：方法、查询参数、状态码、耗时、大小、响应头、JSON 排版 | 通过 | POST 带查询参数 → 服务器收到 `/echo?page=2&name=a%20b` 与正文；HEAD “0 bytes”；404 显示“404 Not Found · … ms · … bytes”；界面（截图 02）正文 JSON 排版，“响应头”页签列出全部头 |
| 权限 `resourcesAll` | 部分 | 插件页权限表里有，且“必需”；中文界面里显示的是英语（缺 `kernel.permission.resourcesAll` 中、日译文，已派）。安装确认对话框我没亲手打开（界面检查 `round12.spec.ts` 用 `app.inspectPlugin` 覆盖） |

## 第十一轮抽查（r11-tests 与外壳修改合并后）

- 欢迎页：英语/中文界面下打开欢迎页，状态栏切到日语（不刷新）→ 标签“ようこそ”、标题与介绍文字变为日语（截图 `round11-accept/spot-ja-welcome-after-switch.jpg`）。通过。
- 日语界面的活动栏、树标题：资源、环境、工作区配置、收藏、已删除、插件、运行记录、设置都是日语；但 `Files`、`Plugin market`、`Sample` 仍是英语——这三个内置插件没有 `ja-JP.json`（已派测试会话补）。`Demo resources`、`Data sources` 是假数据部分的演示文字，不算。
- 地址里带 `lang=` 时语言被它固定，状态栏切换不生效（开发参数，不算缺陷）。
