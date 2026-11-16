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
