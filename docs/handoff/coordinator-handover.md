# 协调工作交接（2026-11-16，由上一个协调会话写给下一个）

上一个协调会话和三个开发会话的上下文都快满了，用户要求换新会话。这份文件是接手所需的全部；不需要之前的对话。

## 0. 最新（第四个协调会话，2026-11-18）

- 第十一、十二轮已验收、完整检查通过，合并到 main 并推送（`6b7890c`）。记录：`round11-acceptance.md`、`round12-acceptance.md`。
- 第十三轮（旧库升级 + 多工作区；D397–D401）的计划与三份任务书已写好：`round13-plan.md`、`round13-kernel.md`、`round13-shell.md`、`round13-tests.md`。**还没开会话**：要在用户发消息的回合里一次开三个（内核 Opus、外壳 Sonnet、插件与测试 Sonnet），工作树从协调分支 `claude/onedesk-coord-4-3ac9ba` 切出。
- 下面 §1 是第三个协调会话交接时的状态，已过时，只作背景。

## 1. 现在的位置（2026-11-18，第三个协调会话交给第四个）

- 协调分支：`claude/onedesk-coord-3-f0c048`（旧的 `coord-2` 不再使用）。**你的工作树从它切出，你所在的分支就是新的协调分支。**
- `main` 在 `6bbc59c`：第一到第十轮都已合并并推送。阶段 1–3 完成，阶段 4 做了第一部分（虚拟滚动、按字段合并、类型自供子节点、通知入口）；多窗口、多工作区按 D378 排到阶段 5 之后。
- **第十一轮**（阶段 5 第一部分：语言插件、网址、提示词、笔记阅读态、欢迎页；`round11-plan.md`，审查 `round11-review.md`，D378–D387）：内核、外壳的全部工作和界面检查（17 条通过）都已合并在协调分支上，协调会话已亲自验收（截图 `docs/screenshots/round11-accept/`）。**还差**：
  1. 第十一轮测试会话 `r11-tests`（`local_6396dadf-5893-4ea6-8d03-78255c435e84`，分支 `claude/r11-tests-6101f2`）手上有两条消息的活：三处插件小修（欢迎页切换语言后介绍文字和标题不变、网址插件的结果文字不随语言变、笔记“模式”下拉显示占位符）和把内核词表的约 303 条 `kernel.*` 键的中、日文字补进两个语言插件的 JSON（D387；在它补完前 `plugins/_testing/lang-check.test.ts` 失败、日语和中文界面里这批文字回退成英语）。它上次停在“需要用户批准”的请求上，只有用户能答复。它交回后合并它的分支。
  2. 完整 `pnpm check`（放后台；期间不要 `git add docs`，界面检查会改写 `docs/screenshots/`）。
  3. 写 `docs/handoff/round11-acceptance.md`（照 `round10-acceptance.md` 的格式；我亲自验过的：全新数据目录出现欢迎页、默认英语、`i18n.languages` 三项、设 `ui.language` 为日语后界面立即变、网址的打开效果与 `javascript:`/`file:` 被拒、提示词的输入框与复制、笔记阅读态里 `<script>`/`<img onerror>` 不执行、`javascript:` 链接变纯文字、图片只出替代文字、`[[引用]]` 可点、锁文件里没有 `markdown-it`/`argparse`；没亲手看的：阅读态的画面、停用语言插件后回到英语、桌面版经主进程打开链接）。
  4. 合并到 main 并推送。
- **第十二轮**（阶段 5 第二部分：综合、集合、HTTP 请求补全；`round12-plan.md` 与三份任务书，D388–D392）：三个会话的第一阶段都已交回，**还没合并、没审查**：
  - 内核 `r12-kernel`（`local_68b86c98-9419-495d-981d-cfd6633ae4eb`）：分支 `claude/r12-kernel-9bd8fa`，最后提交 `1a80508`。
  - 外壳 `r12-shell`（`local_3385652f-2733-4fe2-ab3e-fc85d7f77018`）：分支 `claude/r12-shell-3ce5e9`，最后提交 `66f60d5`。
  - 插件与测试 `r12-tests`（`local_7cc37322-6b47-477f-ab2c-43f80e9db72d`）：分支 `claude/r12-tests-b15013`，最后提交 `a0e30d7`。
  更新（同日稍后）：三个分支已合并到协调分支（`134e66e`；`src/workbench/i18n/index.tsx` 的冲突已解决），类型检查和 lint 通过；独立审查已开（结果要整理成 `round12-review.md` 并分派）；`r12-shell` 在对着真内核对齐，`r12-tests` 在写 `e2e/round12.spec.ts`。还差：审查修改、亲自验收、完整检查、验收记录、合并推送。语言插件 JSON 的补译有先后：先 `r11-tests` 补第十一轮的 `kernel.*` 键并合并，再让 `r12-tests` 补第十二轮外壳新增的键（两个会话不要同时改同一份 JSON）。
- **之后**：第十三轮预定做第一版旧库升级（`legacyKinds` 已在清单里，D383；旧库结构要从 git 历史里的 `src-tauri/migrations/` 读出，如提交 `844b532`）和多窗口、多工作区；阶段 5 的验收是“第一轮需求的验收项全部通过”（`docs/requirements.md` D 节）。再往后见 `dev-plan.md` 阶段 6–9；阶段 6 的“AI 接口”和阶段 9 的各项要先出设计、用户确认后再开发。
- 用户 2026-11-17/18 的指示：尽快做到阶段 5；用户通常不在，决定自己做并记入 `decisions.md`；每轮亲自验收且完整检查通过后**自行合并到 main 并推送**，然后直接进下一轮（用户没有另说之前一直如此）；额度要省，协调会话上下文长了就在合适的时机换新的协调会话。
- 给这些会话发消息用 `SendMessage`，`to` 填上面的 `local_…` id。它们是上一个协调会话开的，完成通知会发给上一个协调会话，由它转给你；你也可以在消息里要求它们做完后用 `SendMessage` 把汇报发到你的会话 id。上下文快满的会话不要再加大活，新一轮开新会话（只能在用户发消息触发的回合或紧接其后的回合里开）。
- 各轮记录在 `docs/handoff/`；遗留事项在 `docs/handoff/todo.md`。

## 2. 下一轮可选的范围

见 §1 的“之后”。还没做的零碎：“用别人的输出类型”（等插件自己的输出类型）、`param_decls`、`ai.policy`、常驻外部程序，以及 `todo.md` 里各轮留下的小项。每一轮的范围由协调会话定，尽量小到一轮能验收完。

## 3. 开会话时要知道的

- 协调会话在“由后台事件触发的回合”里不能直接开新会话（只能出一张卡片等用户点）；在用户刚发过消息的回合里可以。所以一轮的三个会话要在用户说“继续”的那个回合里一次开出来；之后的追加任务用 `SendMessage` 发给已有的会话，不要新开。
- 子会话停在“需要用户批准”的请求上时，只有用户能答复；告诉用户是哪个会话。
- 测试会话分两阶段：第一阶段写插件和夹具，合并后第二阶段写 `e2e/roundN.spec.ts`。
- 新的协调工作树里没有 `.claude/launch.json`（不进版本库）：自己建一个，内容 `{"version":"0.0.1","configurations":[{"name":"coord-vite","runtimeExecutable":"pnpm","runtimeArgs":["exec","vite","--port","1442","--strictPort"],"port":1442}]}`，端口避开别的会话在用的。
- 验收时直接用协议 `run.start` 要把页面的值放进 `input`（如 `body.text`），否则动作拿到空值；浏览器面板的截图有时比页面慢一拍，以 `get_page_text`/JS 读到的为准；截图文件在工具结果目录里，拷进 `docs/screenshots/roundN-accept/`。
- 独立审查用 Agent 工具开只读的 Opus 子代理可以；开“会写文件的子代理”会被拒，写代码的工作一律交给开发会话。
- 第四到第七轮都是：协调会话在用户说“继续开发”的那个回合里定范围、写 `roundN-plan.md` 和三份任务书（`roundN-kernel.md` 等，可照抄上一轮的格式）、开三个会话；之后的对齐、审查修改、第二阶段都用 `SendMessage` 发给这三个会话。

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
- 每一轮都会遇到“界面文字”的对齐：外壳只加英语（`src/workbench/i18n/en-US.ts`），中文、日语在语言插件的 JSON 里（测试会话的文件），`plugins/_testing/lang-check.test.ts` 保证键一致——外壳加了键，合并后要让测试会话补译文。
- 定新依赖时连子依赖的许可证一起查（第十一轮 `markdown-it` 的子依赖是 Python-2.0，审查才发现，换成了 `marked`）。
- 整套单元测试并行跑时 `src/workbench/parts/tree-batches.test.tsx` 偶尔失败，单独跑通过；完整 `pnpm check` 里假数据模式的拖动用例也偶发失败——先单独重跑确认再判断。
- 内置浏览器面板的视口有时被放得很大，截图变得极小：先 `resize_window` 到 1280×800，用完再还原。
