# 任务：内核（分支 `week1/kernel`，Opus）

## 目标

写出真正的内核：`onedesk-kernel`（Rust 库，不依赖 Tauri）和 `onedesk-worker`（可执行文件），实现 `week1-protocol.md` §3 的全部方法、§4–§8 的全部约定。这是完整内核对应部分的开头，不是临时代码：结构按 `kernel-design.md` §3–§5、§7.4–7.5、§9、§12。

内核源码里不得出现任何具体插件的 id、类型名或逻辑（note、files、text、markdown、sql 等字样都不许有；测试用的插件放 `crates/kernel/tests/fixtures/`，用中性名字如 `test.alpha`）。内核不含界面文字。

## 允许修改

`crates/kernel/**`、`crates/worker/**`；`crates/protocol/**` 只增不改（规矩见 `week1-protocol.md` §9）；自己的交接文件；`docs/handoff/todo.md`（只追加）。

## 只读依赖

`crates/protocol/src/lib.rs`（协议）、`docs/handoff/week1-protocol.md`、`docs/redesign/kernel-design.md`、`docs/handoff/stage0-kernel-slice.md`（小样的结论和坑）、`spikes/kernel-slice/`（沙箱、传输、文件锁的做法可以照抄）。

## 要做的（按优先顺序；额度不够时从后面砍，并写明）

1. 工作区：文件夹、`workspace.json`、`workspace.db`（WAL）、迁移 `0001`、文件锁。
2. 写入管线（§4）：一个入口 `execute(调用上下文, 命令)`：操作者 → 权限 → 一个事务内（核对并发、写数据、写 `revisions` 整条快照、写 `audit`）→ 提交后发事件。按字段提交与并发规则；没有变化不记；批量命令（整批删除）全成或全不成。写入由一个专用线程串行，读取用只读连接。本周不做：搜索文本、引用、参数声明、git。
3. 资源与存储树：新建、改、移动（`pos`）、删除标记（分组连同后代一批）、`core:group`、`core:plugin-state`。
4. 协议服务：按行 JSON 的请求分发；`hello`；事件推送；`ui.get/set`（按客户端）。提供进程内入口（同一套“一行 JSON 进、一行 JSON 出”），同一组协议测试对进程内和经套接字各跑一遍。
5. 插件：读 `--plugins` 文件夹（`<id>/<version>/manifest.json`），清单严格校验；沙箱；惰性激活；`pages`/`trees`/`commands` 三种处理函数；`ctx.host` 的 `resources`、`files`、`ui`；`ctx.t`。
6. `page.resolve` / `page.save`（三种目标）、`command.newItems` / `command.execute`、`plugin.grants` / `grantFolder` / `revokeFolder`。
7. `onedesk-worker`：命令行、退出码、主进程连接断开后自行退出。

## 完成标准

- `cargo test -p onedesk-kernel -p onedesk-worker` 全过；`cargo clippy` 无警告；`pnpm check:types` 通过。
- 有这些测试（名字里写明在测什么）：管线的事务/历史/审计一致；按字段并发（不同字段都生效、同一字段冲突）；没有变化不记；整批删除；审计表不能改删；移动的各种非法情形；清单校验的每种拒绝；沙箱里没有 `require/process/fetch` 等、模块只能加载包内文件；死循环被打断且内核继续应答；超内存后运行环境被丢弃、下次能重新激活；视图校验拒绝未知字段；**`files` 的每种越权各一个被拒绝的测试**（授权文件夹之外、`..`、指向外面的符号链接、同名前缀、清单没声明 `files`）；`resources` 读写别的插件的类型被拒绝；给清单里没有的页面注册被拒绝；同一工作区第二个工作进程以退出码 3 结束；杀掉工作进程后重新启动，已提交的数据都在；主进程连接断开后工作进程退出。
- 用 `crates/kernel/tests/fixtures/` 里的测试插件经协议走通：建分组 → `new:` 保存成资源 → 改名 → 移动 → 删除；授权一个临时文件夹 → 提供树列出文件 → `node:` 页面打开、保存、再打开内容已变。

## 交付物

分支 `week1/kernel` 上的提交；`docs/handoff/week1-kernel.md` 不要覆盖——交接文件写到 `docs/handoff/week1-kernel-done.md`（贴测试命令和结果摘要）。

## 共同规则

- 先读：`CLAUDE.md`、`docs/redesign/week1-slice.md`、`docs/handoff/week1-protocol.md`（协议与约定，必须逐条遵守）、本文件。按需读 `docs/redesign/kernel-design.md` 的相关小节。
- 只改“允许修改”里的文件；范围外的问题追加到 `docs/handoff/todo.md` 的末尾（只追加）。不清楚的地方自行按内核设计决定，并写进交接文件的“我做的决定”，不要停下来问。
- 改完就编译、就跑对应测试；`cargo clippy -p <你的包> --all-targets -- -D warnings` 无警告。测试只用临时目录，绝不碰 `~/Library/Application Support/onedesk*`。
- 小步提交到自己的分支，提交信息 `<范围>: <做了什么>` + 空行 + 为什么。不推送、不合并。
- 省额度：不做范围外的事；不重读已读过的大文件；长时间的构建放后台。
- 结束时写交接文件 `docs/handoff/<分支名把/换成->.md`（模板见 `docs/handoff/README.md`，另加“我做的决定”“新依赖”“协议变更”三节），如实写出没做、没验证的地方。
