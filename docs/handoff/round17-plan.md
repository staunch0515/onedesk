# 第十七轮：阶段 6 第三部分——服务器命令、本机脚本、备份、界面剩余项、硬盘文件、API 连接

依据：`round15-plan.md` 的 D412 分轮、`sqlpool-parity.md` I、J、L 组、`requirements.md` I.10b、I.10b-2、I.10h，完成版规划 `docs/redesign/v1-plan.md`（D425、D426）。协调分支 `claude/onedesk-coord-6`（第十六轮还在收尾，只差两条旧 e2e 的测试写法；本轮从它切出）。

## 1. 做完是什么样

- **服务器命令**（I1–I7）：保存的命令可分组、编辑，带 `:name` 参数；参数值按 shell 规则加引号，不能借此注入；选一台服务器（ssh 别名）运行，用系统的 `ssh` 和 `~/.ssh/config`，不问密码；输出是“流（stdout/stderr）、行”两列的表格，可导出、保留、看历史；终端样式显示（深色底、stderr 另一种颜色）；输出里名字像密码的变量值打码。
- **本机脚本**（I8–I9）：bash 脚本保存、参数、超时、行数上限；把全部脚本导出到文件夹里的 `.sh`。
- **备份**（J1–J4）：数据源的“备份到本机”动作：服务器上 `pg_dump` → 下载到应用的备份文件夹 → 拷进本机容器 → 新建库 → `pg_restore` → 新建一个直连数据源。多步运行，带进度。名字只接受安全字符，已有的库绝不动。`docker` 按固定位置查找。
- **界面剩余项**（L 组）：逐条核对 L1–L10；缺的补上，重点是 L7 搜索（3 个字符以上走索引，更短的走模糊匹配，多词同时满足，⌘K 聚焦）和 L2 折叠状态记住。
- **硬盘文件**（I.10b、I.10b-2）：多个授权文件夹的列表管理（增、查、改、移除；移除不删资源和文件）；导入文件夹登记为 `disk-file` 资源（重复导入只更新，文件没了标失效）；文件树与列表；新建文件夹和文件、重命名、移动、复制（同名时选覆盖、跳过或保留两份）、删除（默认进废纸篓，永久删除二次确认）、打开、在 Finder 中显示、按文件名搜索。所有操作只在授权文件夹内，结果在结果区。
- **API 连接**（I.10h）：一个“API 连接”资源类型：地址（自动成为该连接唯一可访问的主机）、认证方式（无、Bearer、Basic、自定义请求头、查询参数里的密钥）、密钥只进钥匙串；可分组、搜索、按环境覆盖；导出 `request` 动作给别的插件用；每次调用进审计；HTTP 请求插件可以选一条连接作为基址和认证。
- 内核源码里不出现 `ssh`、`docker`、`bash`、`pg_dump`、`pg_restore`、`disk-file`、`connection` 这类插件专有的词（并入 `pnpm lint` 的禁用词）。

## 2. 内核要补的（名字由内核会话第一次提交后写进 `round17-protocol.md`，其他会话照它写）

| 编号 | 内容 |
|---|---|
| X10 | 文字节点按行标色：每行可带一个语气（如 `stderr`、`muted`、`success`、`danger`），外壳按 token 上色；“终端样式”是文字节点的一个外观选项 |
| X17 | 外部程序的输出按行交回并标明来自 stdout 还是 stderr，可边运行边把已有的行作为运行的部分输出推给外壳；超时、行数上限、取消时立即结束进程 |
| X18 | 文件宿主接口补齐：新建文件夹、移到废纸篓、在 Finder 中显示、复制和移动时的同名处理（覆盖、跳过、保留两份）；多个授权文件夹的增、查、改、移除（移除授权进审计，不删资源和文件） |
| X6（搜索部分） | L7：3 个字符以上走全文索引，更短的走模糊匹配，多词同时满足。“任一词命中、按相关度排序”留到 AI 那一轮 |

## 3. 分工

| 会话 | 模型 | 做什么 | 允许修改 |
|---|---|---|---|
| `r17-kernel` | Opus | §2 全部；先核对已有的（`files.*` 已有 list、stat、读写、copy、move、remove、open；X1 系统程序已有），只补缺的；Rust 测试 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS |
| `r17-shell` | Sonnet | 文字节点按行标色与终端样式（只用 token，深色底也是 token）；运行中逐行显示部分输出；文件树与列表、同名冲突的选择对话框、永久删除的二次确认；L1–L10 逐条核对并补缺（⌘K 聚焦搜索、折叠状态记住等）；新文字只加英语 | `crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`vite.config.ts`、`package.json` |
| `r17-ops` | Opus | 新插件 `org.onedesk.command`（服务器命令，I1–I7）、`org.onedesk.script`（本机脚本，I8–I9）；数据源插件的“备份到本机”（J1–J4）。各带 `locales/`（英中日）与假 host 的 vitest | `plugins/org.onedesk.command/**`、`plugins/org.onedesk.script/**`、`plugins/org.onedesk.datasource/**` |
| `r17-files` | Sonnet | 扩展 `org.onedesk.files`（I.10b、I.10b-2）；新插件 `org.onedesk.connection`（API 连接，I.10h）；HTTP 请求插件可选一条连接。各带 `locales/` 与 vitest | `plugins/org.onedesk.files/**`、`plugins/org.onedesk.connection/**`、`plugins/org.onedesk.http/**` |
| `r17-tests` | Sonnet | 第一阶段：测试夹具——临时目录里的假 `ssh`、假 `docker`（记录收到的参数、按脚本给输出），让 e2e 不碰真服务器和真容器；`scripts/check-arch.mjs` 加本轮的内核禁用词。第二阶段（合并后由协调会话通知）：`e2e/round17.spec.ts` 按 I、J、L 与硬盘文件、API 连接逐行；外壳新键的中日译文 | `e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`plugins/org.onedesk.lang.*/**`、`plugins/_testing/**`、`docs/screenshots/` |

规则同前几轮：一个文件同一时间只有一个写入者；会话之间只通过 `docs/handoff/` 交流；范围外的问题写进各自的 `round17-<块>-done.md` 的“范围外”一节，不改 `todo.md`；协议新增字段以 `round17-protocol.md` 为准。磁盘只剩约 24G：只有内核会话在自己工作树里建 `target/`，其他会话需要 Rust 构建时用 `CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target`。

## 4. 完成标准

- 完整 `pnpm check` 通过；`round17.spec.ts` 没有 `test.fixme`；I、J、L 每一行与硬盘文件、API 连接的每条需求，在交接文件里写明“通过/不通过/按新需求改了”和怎么验证的。
- 测试绝不连真服务器、真容器：只用假 `ssh`、假 `docker`、临时 PostgreSQL、临时目录。删除文件的测试只在临时目录里做，“移到废纸篓”用可替换的废纸篓目录测。
- 新依赖按规则 9 先写进交接文件（用途、替代、许可证，含子依赖）。
- 之后由协调会话：合并 → 对齐 → 独立审查（`round17-review.md`）→ 第二阶段 e2e → 亲自验收 → 完整检查 → `round17-acceptance.md` → 经用户同意合并 main。
