# 协调工作交接（2026-11-16，由上一个协调会话写给下一个）

上一个协调会话和三个开发会话的上下文都快满了，用户要求换新会话。这份文件是接手所需的全部；不需要之前的对话。

## 1. 现在的位置

- 协调分支：`claude/week1-slice-3b4ae5`（最后提交见 `git log`）。`main` 在 `912c73a`（第三轮结束）。**第四轮的全部提交只在协调分支上，没有推到 main。**
- 已完成并合并到 main：本周最小系统、第二轮（环境与参数、配置、历史、已删除、收藏、搜索、审计）、第三轮（运行、示例查询插件、插件状态与设置、命令面板）。各轮的范围、审查、验收记录在 `docs/handoff/week1-*.md`、`round2-*.md`、`round3-*.md`；决定 D256–D318 在 `docs/decisions.md`；遗留事项在 `docs/handoff/todo.md`。
- 第四轮（安装、版本与升级、密钥、网络、HTTP 请求插件）进行中：范围 `round4-plan.md`，审查 `round4-review.md`。

## 2. 第四轮还剩什么

已合并：内核、外壳、HTTP 插件与夹具；审查的 14 条（3 条必须修）内核与外壳都已修；验收中发现的 D317（授权按主机加端口）、D318（可含密钥引用的文字字段、`RunError.reason`）内核已修并合并。合并后 `cargo build`、`pnpm check:types`、`pnpm typecheck`、`pnpm test`（195）通过；完整 `pnpm check` 在这些修改之后**还没跑**。

没做完的：

1. **外壳**：`RunError.reason` 的各个原因码要有英中文字（码的清单在 `round4-kernel-done.md` 最后一节）；D317/D318 之后界面有没有要跟着改的（例如 `network.allow` 的条目要带端口的提示）；`kernel-texts` 齐全性测试。
2. **HTTP 插件**：清单里 `request` 类型的 `url`、`headers`、`body` 字段要声明 `"secrets": true`（D318）。旧的“插件与测试”会话（分支 `claude/week1-plugins-15d46f`）正在做这件事和 `e2e/round4.spec.ts`，它的工作树里有未提交的修改；上一个协调会话已请它“提交现有进度、写清楚做到哪、然后停下”。**开新测试会话前先看那个分支有没有新提交，有就合并进来，从它停下的地方接着做；不要重写。**
3. **界面检查** `e2e/round4.spec.ts`：按 `round4-plan.md` §1 逐项，另加审查和 D311–D318 带来的检查（清单见上一个协调会话发给测试会话的说明，要点：安装确认框列出权限且新增的被标出；自动切换与接管；版本表、切回、撤销升级后重启不会又升回去；坏包被拒；`0.3.0` 升级失败且什么都没变；移除有资源绑定的版本；手动拷进插件文件夹的包显示未确认、不能启用；密钥页；HTTP 请求的发送、密钥代入后服务器收到真值而界面、`run.get`、数据库文件里都没有；换端口被拒；重定向到别的主机时密钥头不带过去；`network.allow` 收紧；草稿里新写的密钥名字未保存就发送被拒；未保存的新建请求页面填了密钥直接发送后数据库文件里没有明文）。
4. **协调会话亲自验收**（不以测试通过代替）：见 §4 的做法。上一个协调会话只验了密钥与网络的一部分，**安装、版本切换、升级、撤销、移除、密钥页、HTTP 请求页的界面都还没亲自看**。
5. 合并后跑完整 `pnpm check`，写 `docs/handoff/round4-acceptance.md`，向用户汇报并请示是否合并到 main。

## 3. 之后的轮次（用户说“继续开发”时）

按 `docs/redesign/dev-plan.md`。阶段 3 还剩：宿主能力 `process`、`transfer`、`events`、`plugins`（插件请求安装）；依赖与导出（§7.3）；本地插件市场；其余策略参数（§6.3）；参数声明 `param_decls`、引用 `refs`；导出导入；第一版旧库升级；清单缓存；空闲回收；结果导出 CSV。然后是阶段 4（外壳补全）、阶段 5（基础插件：网址、提示词、综合、集合、语言插件、欢迎页）。每一轮的范围由协调会话定，尽量小到一轮能验收完。

## 4. 做法（照这个循环做，三轮都是这么过来的）

1. **定范围和协议**：协调会话自己在 `crates/protocol/src/lib.rs` 末尾加这一轮的类型（Rust 为准，`pnpm gen:types` 生成 TS），写 `docs/handoff/roundN-plan.md`（做完是什么样、范围、方法表、约定、分工、完成标准与必须有的测试），决定记入 `docs/decisions.md`（接着 D318 编号），提交。
2. **三个会话并行**，各自一个工作树和分支，从协调分支切出；一个文件同一时间只有一个写入者：
   - 内核（Opus）：`crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）。
   - 外壳（Sonnet）：`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`。
   - 插件与测试（Sonnet）：`plugins/**`、`e2e/**`、`playwright.config.ts`、`scripts/check-*.mjs`、`docs/screenshots/`。第一阶段写插件（假 host 的 vitest），合并后第二阶段写连真内核的界面检查。
   - 每个会话结束写 `docs/handoff/roundN-<块>-done.md`。会话之间只通过 `docs/handoff/` 交流。
3. **合并**到协调分支（`git merge --no-ff`；先核对每个分支只改了自己范围内的文件）。合并后几乎每次都会出现：界面的类型与内核实际生成的类型不一致、`kernel-texts` 测试报内核新增的键没文字——让外壳会话对齐，并要求它**对着真内核实际走一遍再交**。
4. **独立审查**：用 Agent 工具开一个 Opus 子代理，只读，不许看 `*-done.md`，只对照代码和设计查：内核有没有混入插件逻辑、界面有没有绕过 token、权限检查有没有漏（每轮按新功能列具体的检查点）。结果写成 `roundN-review.md`（问题、位置、处理人），分派给对应会话修，每条补测试。
5. **界面检查**：测试会话写 `e2e/roundN.spec.ts` 连真内核跑通；发现内核或外壳的缺陷不改别人的文件，写进交接文件并用 `test.fixme` 标出，修好后去掉。
6. **亲自验收**：
   - `cargo build -p onedesk-worker -p onedesk-host`
   - `ONEDESK_SECRET_STORE=memory ONEDESK_BUILTIN_PLUGINS=$PWD/plugins target/debug/onedesk-devhost --data-dir <临时目录> --port <端口> --token <令牌>`（**必须设 `ONEDESK_SECRET_STORE=memory`，绝不碰真钥匙串**；数据目录用会话的 scratchpad，绝不碰 `~/Library/Application Support/onedesk*`）
   - 用内置浏览器面板开 vite（`.claude/launch.json` 里的 `week1-vite`，端口 1441），打开 `workbench.html?kernel=ws://127.0.0.1:<端口>&token=<令牌>&lang=zh-CN`。
   - 先用页面里的一段 JS 开 WebSocket 直接调协议（`hello {protocol:"1"}` 之后任意方法）核对语义和权限边界，再在界面上操作并截图，截图存 `docs/screenshots/roundN-accept/`。
   - 网络相关的用本机临时 HTTP 服务器（上一个会话的做法：一个记录请求头的 Python 小服务器）。
   - 界面面板里的拖动不触发自定义拖放，要用脚本合成指针事件；点菜单项、对话框按钮用 JS 找元素更稳。
   - 完整 `pnpm check` 要十几分钟，放后台跑（`E2E_PORT=1432 pnpm check`）；跑完会改写 `docs/screenshots/` 下的基准截图，用 `git checkout -- docs/screenshots` 还原。
7. **汇报并请示**：对用户用中文，简短，先结论；逐条写通过与否、怎么验证的、没做到或没验证的、新增的决定。合并到 main 和推送要用户同意。主检出在 `/Users/zhongpingxue/onedesk/repo`（main），用 `git -C /Users/zhongpingxue/onedesk/repo merge --ff-only <协调分支>` 再 `push origin main`；那里有一处不是我们产生的未提交改动（`docs/prototype/workbench.html` 显示为已删除），不要动。

## 5. 用户的约束（一直有效）

- 额度要省：自己的上下文保持短，细节放进交接文件；不做范围外的事，范围外的问题记到 `docs/handoff/todo.md`。
- 用户通常不在电脑前：尽量不问，自行决定并记入 `docs/decisions.md`。
- 每一块都按 `docs/redesign/kernel-design.md` 写，不是临时代码；与设计不一致或设计没写到的自行决定并记录。
- 界面外观不得走样：纯假数据模式的 `e2e/workbench.spec.ts` 是基准；所有 CSS 只在 `src/design`、只用 token。
- 内核源码里不得出现任何具体插件的名字或逻辑；许可证只允许 MIT/Apache-2.0/BSD/ISC/Zlib/Unicode-3.0。
- 没运行过、没看到结果的如实写出，不说“完成”。

## 6. 一直没能验证的（每次汇报都要提）

- **桌面窗口里的画面和操作**：协调会话没有截屏和辅助功能权限，`pnpm start` 能启动、窗口里的界面能连上内核（库里有它写的布局），但画面没看到。需要用户自己看。
- **打包出的 `.app`**：`pnpm tauri build` 能打出来，但从命令行启动时进程停在系统的图形启动阶段，没能确认。
- **真钥匙串和 https**：测试只用内存密钥库和本机 http。

## 7. 经验（省得再踩）

- 协议里新增的字段名要在任务书或审查文件里**定死**，否则内核和外壳各猜各的，合并后类型对不上。
- 数值字段按协议类型发，不要转成文字（第二轮环境页因此全部失败过）。
- 子会话停在“需要用户批准”的请求上时，只有用户能答复；协调会话不能代答，也不要绕过去做同一件事，告诉用户哪个会话在等。
- 协调会话的测试进程曾两次被外部结束，原因没查实；验收时如果界面提示“工作区服务已停止”，先看 devhost 进程还在不在。
- 审查每一轮都查出了真问题（第四轮 3 条必须修都是权限边界），不要省。
- 协调会话亲自验收每一轮也都发现了测试没覆盖的问题（保存没写盘、永久删除有残留、授权不看端口、密钥引用用不了），不要以测试通过代替。
