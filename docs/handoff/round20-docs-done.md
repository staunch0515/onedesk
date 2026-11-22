# 第二十轮 r20-docs 完成报告

范围：`round20-plan.md` §1 第 4 条。只改了 `docs/manual/**`、`plugins/README.md`、本文件。

## 交付

| 文件 | 内容 |
|---|---|
| `docs/manual/README.md` | 目录、读法、“待补截图/待确认”约定 |
| `01-install.md` | 安装、自签名与首次右键“打开”的原因、首次启动、升级、卸载 |
| `02-data-and-backup.md` | 数据目录与内容、自动备份（每天一份留 7 份、迁移前必留）、整目录备份、导出/导入工作区、恢复 |
| `03-workspaces.md` | 新建/打开/管理/删除、环境、工作区配置、插件开关、密钥 |
| `04-datasource.md` | 直连与 ssh（`docker exec psql`）两种方式、字段、导入连接串、只读规则、超时/行数、备份到本机、数据源查找顺序 |
| `05-queries.md` | 保存的 SQL（`:name` 参数、环境）、查询目录（YAML 头、映射） |
| `06-ai.md` | Anthropic/Ollama 连接、默认连接顺序、`ai.policy` 三档、预览与脱敏、数据发给谁、费用提醒 |
| `07-mcp.md` | AI 访问页、对 AI 可见、`mcp.*` 策略、Claude Desktop 配置与 `--print-config`、工具表、自由查询 |
| `08-faq.md` | 常见问题 |
| `en-summary.md` | 英文一页摘要 |
| `plugins/README.md` | 英文，重写补全：包结构、清单（含 requires/exports/implements/aiTools）、contributes、页面动作角色、权限、视图树、宿主接口表与沙箱限制、AI/MCP 声明、locales、错误（原有一节译成英文并保留）、测试、完整示例、规则清单 |

核对来源：各插件的 `manifest.json`/`main.js`/`locales`，`crates/kernel/src/manifest.rs`、`mcp.rs`、`workspace.rs`，`crates/host/src/{data_dir,workspaces}.rs`，`crates/mcp/src/main.rs`，`crates/protocol/src/lib.rs`（ViewNode），外壳中文文字表（`plugins/org.onedesk.lang.zh-cn/shell/zh-CN.json`），`ai-plugins.md`、`ai-interface.md`、D447–D452、第十八/十九轮验收记录。

## 第二轮修订（按协调会话 2026-11-23 的要求）

已按 `round20-package-done.md`（来自 `claude/onedesk-r20`，用 `git show` 只读核对，**本会话的合并被权限拦截，分支未合并进来**，文档改动与 r20 不冲突，合并由协调会话做）与代码落实并去掉标记：分发形式（以 `.app` 压缩包分发，未公证，首次右键打开 / `xattr -dr com.apple.quarantine` / “隐私与安全性”里“仍要打开”）、`onedesk-mcp` 在 `Contents/MacOS/`、欢迎页是 `org.onedesk.welcome`、语言切换入口（状态栏右侧“语言”菜单，`status-bar.tsx`）、全部“待补截图”（手册暂不带图，截图由协调会话手测后补）。`plugins/README.md` 的 `transfer` 补了 `download`/`upload`（`carry.rs`：只在 run 内，`to`/`from` 路径，需 network/files 或 programs 授权），`storage` 补了 `keys`（并写了 `readFrom`，见 `host.rs`）。

## 最终待确认清单（需要真机或真服务，手册里仍标“待确认”）

1. 升级应用后钥匙串是否再次询问（01）。
2. 只替换 `workspace.db` 的恢复，`-wal`/`-shm` 残留（02）。
3. 界面里加工作区配置参数的具体点法（03）。
4. AI 工作台设置项在“插件”页的位置（06）。
5. 真实 Anthropic / Ollama（06）、真实 Claude Desktop（07）、带密码数据源经 MCP 读钥匙串（07）、真服务器/容器的“备份到本机”（04）。
6. 右键“打开”在各 macOS 版本上的实际表现：r20-package 没在 Finder 里真实操作过，手册给的三条路径（右键打开 / 仍要打开 / xattr）未逐一试过。

## 发现的问题（范围外，没改）

- `plugins/README.md` 原来只有一节且是中文（与 D452 ④“保持英文”不符），已按英文重写；`docs/handoff/week1-protocol.md` §6 的清单示例是第一周子集，已落后于 `manifest.rs`（缺 `requires` 的 programs/network 等、`exports`、`implements` 等），README 以 `manifest.rs` 为准——如需可另行更新该交接文件。
- `plugins/org.onedesk.catalog/README.md` 开头写着“本机没有 sqlpool 源码”，与现状是否一致由 r20-parity 判断。
- “AI 工作台”没有“新建”菜单，设置只能在“插件”页的设置项里改；ai.policy 与 ai.connection 是环境参数，手册按“添加参数”写，但外壳的参数列表里是否自动列出它们没核实。
