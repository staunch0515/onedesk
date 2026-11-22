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

## 待确认（手册里已写“待确认”，没有编造）

1. **分发形式**（dmg 还是 zip）、`.app` 名称——`r20-package`。
2. **较新 macOS 上“右键打开”后是否要去“隐私与安全性”点“仍要打开”**，以及从网上下载是否要 `xattr -dr com.apple.quarantine`——要在打出的 `.app` 上试。
3. **首次启动欢迎页**的内容（手册现在只描述现有的“欢迎”插件页）——`r20-package`。
4. **升级应用后钥匙串是否再次询问**（自签名换版本）。
5. **`onedesk-mcp` 在 `.app` 里的确切路径**（手册写了预期 `Contents/MacOS/onedesk-mcp`，以“AI 访问”页显示为准）——`r20-package` 的 `app.mcpInfo` 验证。
6. **只替换 `workspace.db` 的恢复步骤**（`-wal`/`-shm` 残留）没有专门测试过。
7. 在界面里加工作区配置参数/环境参数的**具体点法**、AI 工作台设置项在“插件”页里的位置、**切换界面语言的入口名称**：对照的是文字表，没在运行的应用里点过。
8. 真实 **Anthropic/Ollama**、真实 **Claude Desktop**、带密码数据源经 MCP、真服务器的“备份到本机”都没有真实环境验收（见 round17–19 验收记录）；手册是按协议与假服务验证过的行为写的。
9. 查询目录**映射文件的完整格式**：手册指向 `plugins/org.onedesk.catalog/README.md`，没重复。

## 待补截图（`.app` 打出后补）

安装右键“打开”、工作区菜单与管理对话框、数据源页（直连/ssh）、目录树与参数输入、新建 Anthropic 连接页、AI 预览页、AI 访问页、信息面板“对 AI 可见”开关。

## 发现的问题（范围外，没改）

- `plugins/README.md` 原来只有一节且是中文（与 D452 ④“保持英文”不符），已按英文重写；`docs/handoff/week1-protocol.md` §6 的清单示例是第一周子集，已落后于 `manifest.rs`（缺 `requires` 的 programs/network 等、`exports`、`implements` 等），README 以 `manifest.rs` 为准——如需可另行更新该交接文件。
- `plugins/org.onedesk.catalog/README.md` 开头写着“本机没有 sqlpool 源码”，与现状是否一致由 r20-parity 判断。
- “AI 工作台”没有“新建”菜单，设置只能在“插件”页的设置项里改；ai.policy 与 ai.connection 是环境参数，手册按“添加参数”写，但外壳的参数列表里是否自动列出它们没核实。
