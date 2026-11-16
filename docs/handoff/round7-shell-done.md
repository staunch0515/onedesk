# 第七轮 外壳 交接

分支 `claude/r7-shell-54d7fe`。只改了 `src/workbench/**`；`crates/host`、`src-tauri` 没有改动（不需要）。

## 改了什么
- **安装请求**（`parts/install-dialogs.tsx`，`useInstallRequests`）：启动时、收到主题 `install-requests` 和 `connection` 时调 `plugin.installRequests`；请求入队，一次一个、且手动安装框空闲时才弹；走 `app.inspectPlugin` → 同一个确认框（标题 `“{请求方}”请求安装“{名称}”？`，说明里写“你不确认就不会安装”）→ `app.installPlugin`；然后 `plugin.answerInstallRequest`：安装成功 `installed`（带 `plugin`、`version`）；取消 `declined`；检查或安装出错 `failed`，`reason` = 错误的 `params.reason`，没有则用错误码；预览本身不合法（`valid: false`）时关闭 = `failed`。内核那边已结束的请求（过期、请求方被停用）从列表里消失，外壳会撤掉正在显示的框、不再答复。
- **插件页**：状态区新增“在等它依赖的插件”横幅（启用着、`load.state=disabled` 且有未满足的依赖时，替换普通的“已停用”横幅，列出缺的插件与范围、正在用的版本）；“依赖的插件”表（id、范围、状态、正在用的版本）；“被这些插件依赖”一节（按钮，点开对方的插件页）。
- **被拒提示**：`conflict/dependents` 带 `params.plugins` 的整句（`conflict.dependents`），自动切换失败的 `switchFailure.reason = dependents`（`reason.dependents`，不带名单）。
- **文字**（`i18n/`）：`reason.dependents`、`conflict.dependents`、`reason.dependsUnmet`、`reason.pendingRequest`、`reason.badDepends`、`reason.badExports`；清单问题 `badDepends`、`badExports`、`dependsUnmet`；审计操作 `plugin.installRequest`、`plugin.installAnswer`；页面用语若干。`notRequested`、`outsideGrant` 原有文字通用，未改。
- **假数据**：mock 里 `com.example.slack-notify` “依赖” `org.onedesk.http >=0.1.0`（未装，所以显示未满足）；`http` 的 `dependents` 在 slack 启用时含它。mock 没有安装请求（`installRequests` 缺省则整套不启动）。
- 核对：依赖方加的动作走现有的“动作 / 页面操作区 / 右键”路径，外壳不识别动作来源，所以没改代码；权限 `resources` 的明细（`<插件id>:<kind>`）在安装确认框与插件页权限表都按 `detail` 原样（等宽字）显示，有单元测试。

## 测试结果
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（241 个）通过；新增 `parts/round7.test.tsx`（7 个）。
- `cargo test -p onedesk-host`、`cargo clippy -p onedesk-host --all-targets -- -D warnings` 通过（退出码 0；没细看测试计数）。
- 假数据模式 `E2E_PORT=1433 playwright test e2e/workbench.spec.ts`：23 通过 1 跳过（原本就跳过）。截图是被写出的，没做像素比对；已 `git checkout -- docs/screenshots`。

## 等内核合并后要对的假设
1. 类型名和形状：`PluginDetail.depends?: {id, range, satisfied, activeVersion?}[]`、`dependents?: string[]`；`InstallRequest {id, plugin, pluginName: Label, folder, at}`；`InstallAnswer {id, outcome, plugin?, version?, reason?}`。现在是 `protocol/types.ts` 里的本地类型，生成类型出来后换成再导出。
2. 方法名 `plugin.installRequests`（无参）、`plugin.answerInstallRequest`（参数直接是 `InstallAnswer` 的字段）；主题 `install-requests`。`real-client.ts` 已按此写，但没连过真内核。
3. “依赖未满足”的表示：外壳不看 `load.message` 里的 `dependsUnmet`，而是用 `enabled && load.state==="disabled" && depends 里有 satisfied=false`。若内核用别的状态（例如 `load.message="dependsUnmet"` 或加字段），要对。`dependsUnmet` 的 `params.plugin/range` 外壳取自 `depends`。
4. `conflict/dependents` 的 `params.plugins` 是逗号分隔 id，外壳原样显示（不拆、不转成名称）。切换/停用/移除各处的失败都经 `actions.fail` 弹出整句，未做专门对话框。
5. 外壳答复时机：安装成功后立即答复（先清掉框再答复）；`app.installPlugin` 失败时 `reason` 取错误的 `params.reason ?? code`。答复失败（如已过期）被静默忽略。
6. `app.*` 在主进程；请求里的 `folder` 由外壳直接交给 `app.inspectPlugin`，未再校验。
7. 权限 `resources` 的显示名仍是“自己的资源”（`PERMISSIONS.resources`）；有了 `<插件id>:<kind>` 明细后这个名字可能偏窄，对着真数据看是否要改成“资源”。

## 没做 / 没验证
- 没连真内核走过：请求弹框、依赖两节、被拒提示都只在单元测试和假数据里验证。
- 没做主进程改动；没截图确认新两节的外观（只用现有组件和 token）。
- 弹框里没有“请求方是哪个插件 id”的单独显示，只有名字（`pluginName`）。

## 合并后的对齐（合并了协调分支，对着真内核走过）

### 改了什么
- 本地临时类型换成生成的：`InstallRequest`、`PluginDependency` 直接再导出，`InstallAnswer = InstallAnswerParams`。假设 1–3 的形状与方法名都对得上（`plugin.installRequests`、`plugin.answerInstallRequest`、主题 `install-requests`）；`load.message` 的 `dependsUnmet` 与外壳的推断（`disabled` + 有未满足依赖）一致。
- **主进程接了 `plugin.checkRemove`**（`crates/host/src/lib.rs` 的 `remove_plugin`：拿到安装锁后、挪文件之前转发，出错原样返回）。测试：`remove_is_refused_untouched_when_the_kernel_says_dependents`（假工作进程回 `conflict/dependents`，文件原样、没有 rescan）；原有的移除测试改为期望日志里先 `plugin.checkRemove` 再 `plugin.rescan`。
- 补文字：清单原因 `badPlugins`；`reason.notInteractive`、`reason.requesterDisabled`、`notFound.installRequest`；`load.message = notExported` 的说明（插件页状态区）；权限 `resources` 的显示名“自己的资源”→“资源”（明细是别的插件的类型，原名误导）。
- 检查：`pnpm typecheck`、`lint`、`pnpm test`（289）、`cargo test -p onedesk-host`、host clippy、`workbench.spec.ts`（23 通过 1 跳过）通过。

### 对着真内核走的结果（`ONEDESK_SECRET_STORE=memory`、临时数据目录、devhost + vite，内置浏览器面板；浏览器里没有系统文件夹对话框，授权和安装都用路径框）
1. 插件市场（它是自己的活动栏入口，树里一个“Local packages”节点，不在插件树里）：页面先说“还没有授权文件夹”；用工具栏“添加文件夹”输入 `e2e/fixtures/market` 后列出三行：`plugin.name`（清单有错的那个，名称和说明显示成**原始键**，状态写“未安装”而不是“不可用 + 原因”）、你好（未安装）、笔记（已安装 0.1.0）。→ 这条是**插件的缺陷**（不归外壳）：坏包应该列为“不可用”并给原因；下拉框里坏包的名字也是 `plugin.name 0.1.0`，选了会装不了。
2. 选“你好”点“安装”：弹出框架确认框，标题“‘插件市场’请求安装‘你好’？”，说明“只有一个‘问候’类型”、`com.example.hello@0.1.0`、“没有特殊权限”。点“安装”后列表里“你好”变“已安装 0.1.0”，右下提示“已安装 你好 0.1.0”。✔
3. 取消：我第一次不小心在框外点击，对话框关闭，页面显示“已取消安装。”，列表里“你好”仍是未安装，什么都没发生。✔（意外走到的，不是单独设计的一步；之后“你好”已装，没有可再选的包了，没有重做。）
4. 手动安装 `note-tools/0.1.0`：确认框列出权限“资源”（修正前显示“自己的资源”）+ 新增标记 + 明细 `org.onedesk.note:note`。装好后它的插件页：已加载，“依赖的插件”表一行 `org.onedesk.note >=0.1.0 已满足 0.1.0`，权限表里同样的明细，提供“统计字数”“盖章”两个动作。✔
5. 新建一条笔记并保存：页面操作区在保存之后重新打开才有“统计字数”“盖章”（已打开的页面不会自己刷新，是内核交接文件里写的已知项）。点“统计字数”：运行成功，输出“4 个词，1 行”，**但笔记页没有结果区**，只在任务面板里看到“统计字数 · 4 个词 · 9 ms”。→ 笔记类型没有声明结果区页签，依赖方又不能加；若要在页面上看到字数，需要决定（内核/协议：依赖方是否可以给被依赖类型加结果区页签，或外壳在没有页签时也显示最近一次运行的输出）。**没有改**，记入 `todo.md`。
6. 点“盖章”（试图改笔记）：运行失败，状态栏和任务面板显示“它属于另一个插件。”（`denied/foreignKind`）。✔
7. Notes 插件页：“被这些插件依赖”一节列出 `com.example.note-tools`（按钮）。点“停用”：弹出错误“还有启用着的插件依赖它：com.example.note-tools。请先停用它们，再重试。”，插件仍启用。✔ 点版本行的“移除”→确认→同样的提示，磁盘上 `plugins/org.onedesk.note/0.1.0` 还在，也没有 `.removed`（`plugin.checkRemove` 生效）。✔
8. 先停用 note-tools（成功），再停用 Notes（成功，`dependents` 变空）；再启用 note-tools：它的插件页状态区出现“在等它依赖的插件”横幅，写“需要 org.onedesk.note >=0.1.0（正在用：0.1.0）”，依赖表那一行“未满足”；协议上 `enabled: true`、`load: {state: disabled, message: dependsUnmet}`。重新启用 Notes 后 note-tools 自动恢复 `loaded`。✔
   - 小问题：依赖被停用时横幅写“（正在用：0.1.0）”，读起来有点怪（版本在、但没启用）。没改。

### 没验证 / 记下的
- 浏览器里无法点“选择文件夹”系统对话框；桌面版（Tauri）没有走。
- 没有走“同时多个请求排队”和“请求过期”的真内核路径（只有单元测试）。
- 依赖方动作不在树的右键菜单里（内核说现在树菜单只有命令，没有任何动作）；外壳没有改。
- 一个插件树里的显示名 “Note tools” 在中文界面下是英文，说明 `note-tools` 的清单/语言文件里没有中文（fixtures，不归外壳）。

## V1：依赖方动作的输出（D351）
- `parts/result-area.tsx`：新增外壳自己的输出页签（id `run-output`，标题 = 动作名称 `Run.actionLabel`，图标 terminal，用现有的文字/表格输出组件）。依赖方的动作（动作 id 带 `<插件id>:` 前缀，页面自己的动作不带）运行时一律用它，排在页面自己的页签之前，页面自己的页签仍可切换；页面没有输出页签时，任何一次运行也用它。`pages/view-page.tsx`：没有声明结果区页签的页面，有运行时也显示结果区；启动运行时选中的页签：自己的动作 = 页面的输出页签，依赖方的 = 默认页签。
- 假设：“依赖方的动作”用动作 id 含冒号判断（内核给的依赖方动作 id 形如 `com.example.note-tools:count`，页面自己的动作没有）。若以后页面自己的动作也带前缀，要改成比较插件 id。
- 测试：`parts/round7.test.tsx` 三条（无页签 → 默认页签带动作名；有页签 → 依赖方用默认页签、页面页签仍在；页面自己的动作不变）。
- 真内核：装 note-tools，新建笔记并保存，点“统计字数”：笔记页底部出现结果区，页签“统计字数”，内容“4 个词, 1 行”，状态栏“#1 · 4 个词”。✔
- 另补：`reason.cooldown`（内核 D349 的新原因码，`kernel-texts` 测试要求）。
- 检查：`pnpm typecheck`、`lint`、`pnpm test`、`workbench.spec.ts`（23 通过 1 跳过）通过。
