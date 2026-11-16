# 任务：第七轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round7-plan.md` 里定死的名字写（协议类型合并后才生成，先在外壳里按可选字段和本地类型写），假实现补上对应数据。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round7-plan.md` §7 外壳一行）
1. 安装请求：订阅 `install-requests` 主题，启动时也取一次 `plugin.installRequests`；对每个请求走现有的安装流程（`app.inspectPlugin` → 确认框 → `app.installPlugin`），确认框标题写明是哪个插件请求的（`pluginName`）；结束后调 `plugin.answerInstallRequest`（`installed` 带 `plugin`、`version`；取消 → `declined`；检查或安装出错 → `failed` 带原因码）。同时来多个时排队，一次一个。
2. 插件页：“依赖”一节（`PluginDetail.depends`：id、范围、是否满足、对方的活动版本）和“被依赖”一节（`dependents`）；状态原因 `dependsUnmet` 的文字。
3. 切换版本、停用、移除被拒（`conflict`，`reason: dependents`，`params.plugins`）时的提示：列出依赖它的插件，说明先停用它们。自动切换因此失败时 `switchFailure.reason = dependents` 的文字。
4. 核对：依赖方加的动作在被依赖类型的页面操作区、右键项里正常显示和运行（应当不用改代码）；权限 `resources` 的明细（`<插件id>:<kind>` 列表）在安装确认框和插件页权限表里的显示。
5. 新增原因码（`badDepends`、`badExports`、`pendingRequest`、`notRequested`、`outsideGrant` 用在安装请求上的说法等）和审计操作名（`plugin.installRequest`、`plugin.installAnswer`）的英中文字。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round7-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round7-plan.md`、`docs/decisions.md` D342–D348、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。内置插件清单 `plugins/**` 不归你改；主进程复制内置插件的逻辑若需要认识新插件，应当是通用的（不写插件名字）。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round7-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round7-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。最后的汇报开头写分支名和最后一个提交号。
