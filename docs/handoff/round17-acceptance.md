# 第十七轮验收（2026-11-22，第六个协调会话）

范围：`sqlpool-parity.md` I（服务器命令与本机脚本）、J（备份）、L（界面剩余项）；`requirements.md` I.10b、I.10b-2（硬盘文件与文件管理）、I.10h（API 连接）。内核 X10、X17、X18、X6（搜索部分）；决定 D427–D436。集成分支 `claude/onedesk-r17`，验收时 `7b1a9e9`（含第十六轮全部内容）。

## 结论：通过

| 检查 | 结果 |
|---|---|
| `pnpm check:types`、`typecheck`、`lint`（含新增内核禁用词 bash、pg_dump、pg_restore、disk-file） | 通过 |
| `pnpm test`（vitest） | 999/999（含真 bash 注入测试 `plugins/_testing/shell-quote-bash.test.ts`） |
| `cargo test --workspace`、`pnpm clippy` | 620/0、无警告 |
| `pnpm e2e`（真内核 + PostgreSQL 17 + 假 ssh/scp/docker） | 329 通过、1 按条件跳过、0 失败；`round17.spec.ts` 44 条、无 `test.fixme` |

## 协调会话亲自验收（真内核 devhost，`ONEDESK_SECRET_STORE=memory`，数据目录与授权文件夹都在 scratchpad）

| 项 | 怎么验 | 结果 |
|---|---|---|
| I8 本机脚本、X10/X17 | 脚本 `echo` + stderr + 循环 + `exit 3`：输出按 stdout/stderr 分列、终端样式、stderr 另色（截图 `script-terminal.jpg`） | 通过；发现非零退出仍算成功 → D435 修正，复验 `exit 3` 为 error 且输出保留（运维插件会话在真内核上确认） |
| I.10b-2 树菜单与拖放（D430） | 节点带 move/copy/rename/delete/open 菜单、可拖 | 通过 |
| 同名冲突（D428） | 复制 `a.txt` 到已有同名的 `sub` → 三选一；keepBoth → `sub/a 2.txt` | 通过 |
| 只改大小写改名（审查 #2） | `Readme.md` → `README.md` 直接成功，不丢文件 | 通过 |
| 打开（D432） | 打开 `run.command` → `denied/unsafeOpen`；打开 `a.txt` 正常（真的用系统打开了） | 通过 |
| 移到废纸篓（D434） | 应用里把测试文件移到真废纸篓，文件离开原文件夹；用户另在主仓库跑了 `#[ignore]` 的系统废纸篓测试，通过 | 通过 |
| I.10h API 连接（D433） | 本机 HTTP 服务记录：Basic 收到 `base64("aladdin:open sesame")`；查询参数密钥 `p&q#r+s%t` 收到 `p%26q%23r%2Bs%25t`；资源里只有钥匙串引用，数据目录里搜不到密钥原值 | 通过 |
| L7 短词搜索 | 搜 “ac” 找到相关资源 | 通过 |

## 审查与修正

`round17-review.md` 18 条，其中必须修 5 条（插件借 `files.open` 执行任意程序、只改大小写改名删掉源文件、覆盖删掉授权根、命令参数注入、无换行输出无限占内存），全部修复并有“修之前失败”的测试。另有验收和 e2e 发现的：数据源必填字段挡住“测试连接”、部分输出节流不补发、废纸篓被 TCC 拦下、页面必填项拦住不相关的按钮（D436）等，均已修。

## 没验证的

- 数据源“备份到本机”只在 e2e 里用假 ssh/docker 走过，没碰真服务器和真容器。
- 按住 ⌥ 拖动复制只有 vitest；L2、L5、L6、L9、L10 只有外壳 vitest 与假数据界面检查，没有真内核 e2e。
- 桌面窗口里的画面、打包的 `.app`、真钥匙串。

## 留到以后

见 `todo.md` “第十七轮验收留下的”。
