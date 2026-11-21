# 第十七轮独立审查（2026-11-21）

只读 Opus 子代理，范围 `git diff 42d219f..claude/onedesk-r17`（截至 `ed119b7`），不看 `*-done.md`。协调会话复核了 #1（`host.rs` files_scope 的 own_files 分支不要求 `requires.files`，`open` 直接走 Opener）。每条修完都要补测试。

| # | 级别 | 问题 | 位置 | 处理人 |
|---|---|---|---|---|
| 1 | 必须修 | 插件在自己目录 `writeText(…, {executable:true})` 再 `files.open` 即可让系统执行任意程序（`.command`、`.terminal`、`.app`），绕过 `requires.programs`；`open` 跟随最后一段链接可打开授权外。按 D432 改 | `host.rs:568,643`、`files.rs:716` | 内核 |
| 2 | 必须修 | 只改大小写的改名/复制（APFS 不分大小写）报冲突，选“覆盖”会删掉源文件本身。用 (dev,ino) 判断同一文件，同一文件直接 rename | `files.rs:612–628,648,660` | 内核（文件插件配合） |
| 3 | 必须修 | copy/move 选“覆盖”可删掉授权根或插件自己的目录（`resolve_entry` 的 root 标志被丢弃）；remove/trash 含嵌套授权根的文件夹会连根删 | `files.rs:650,665` | 内核 |
| 4 | 必须修 | 命令/脚本参数加引号可绕过（已在 bash 验证）：`"${a:-":x"}"` 中 `$()` 被执行；`<<EOF` 与 `\tEOF` 混淆；`$((1<<2))` 被当 heredoc | `command/main.js:55–61,97`；`script/main.js:94` | 运维插件 |
| 5 | 必须修 | `lines:true` 下无换行的输出无限占内存，且每块都从头扫描（平方） | `process.rs:500–502` | 内核 |
| 6 | 应修 | `searchPaths` 位置检查不看链接本身所在目录，执行的仍是链接路径（TOCTOU）；组可写放行待确认（定：组可写也拒，除非组是 root/wheel） | `process.rs:371–389` | 内核 |
| 7 | 待确认 | 取消/超时只杀本机 ssh，远端 `bash -s` 可能继续。改用 `ssh -tt` 或远端 `exec` 包一层随 stdin 关闭退出；至少写进提示 | `command/main.js:316` | 运维插件 |
| 8 | 应修 | 备份各步超时写死 10 分钟/1 小时，内核上限已是 2 小时 | `datasource/main.js:389–390` | 运维插件 |
| 9 | 应修 | “全部导出”静默覆盖磁盘上同名 `.sh`、没设可执行位；用 `conflict`（让用户选）与 `executable:true`。“用环境参数值”不在本轮 | `script/main.js:448` | 运维插件 |
| 10 | 应修 | 先查后做的竞争：rename/copy 会覆盖窗口内新出现的文件（用 `RENAME_EXCL`/`O_EXCL`）；新操作没像 writeText 那样钉住父目录 | `files.rs:564,667` | 内核 |
| 11 | 应修 | connection 原样转发调用方的 headers/query/body/path，别的插件可写 `{{secret:…}}` 把密钥放到任意位置；query 密钥不做百分号编码。拒绝调用方输入里的 `{{secret:`；按 D433 用 `|url` | `connection/main.js:117,122,133` | 文件插件（内核加 `|url`） |
| 12 | 应修 | `runs.partial` 每 300ms 发全部累计行，内核每次全量抹除，外壳整块重画最多 1 万行。插件只发尾部（最多 500 行）；外壳终端文字用虚拟列表 | `command/main.js:257`、`runs.rs:614`、`result-area.tsx` | 运维插件、外壳 |
| 13 | 建议修 | `ONEDESK_OPEN_LOG`、`ONEDESK_TRASH_DIR` 在正式工作进程也生效。只在 `ONEDESK_TEST_HOOKS=1` 时读 | `worker/src/main.rs:95–100` | 内核 |
| 14 | 应修 | 提供树菜单里的内置 `node.*` 多数不可用；`node.favorite` 不核对树，插件可让用户收藏任意资源。按 D432 只留 `node.open` | `kernel.rs` provided_menu_cmd | 内核 |
| 15 | 低 | `bash -s` 从标准输入读脚本，脚本里读 stdin 的命令会吃掉后续行。改成先写临时脚本文件再执行，或至少提示 | `command/main.js:316`、script | 运维插件 |
| 16 | 低 | 跨行密钥按行抹不掉；`tone_column`/`line_column` 不核对列；stdout/stderr 顺序近似（写进文档） | `process.rs`、`runs.rs` | 内核 |
| 17 | 低 | `badSecretFormat` 英文说法不准；replace 后吐司显示的文件夹不对；终端节点无障碍名用 id；TerminalText 默认 out/err 写死英文 | `en-US.ts`、`context.tsx`、`view-nodes.tsx` | 外壳 |
| 18 | 测试缺口 | 1–5、10 无测试；远端取消；备份超时与已有库竞争；导出 .sh 遇同名 | — | 各处理人补单元/Rust 测试；e2e 归测试会话 |

核对后没问题的：协议只增不改（D428–D430 的校验与上限）；内核与主进程无插件专有词；备份的库名/容器名/主机只收安全字符且不以 `-` 开头、不动已有库；ssh 主机名带 `--`、命令走 stdin；密钥 `|basic` 拒含 `:` 的用户名、编码值与原值都进抹除表、无头注入、资源里只有密钥名；授权不许含数据目录、不能写自己的 `bin/`；本机取消用 killpg；终端配色全是 token，新文字都走 i18n。
