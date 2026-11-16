# 第六轮 外壳：完成记录

分支 `claude/r6-shell-96639c`。只改了 `src/workbench/**`（含新测试），没动 host/src-tauri/design（外观不变，没有新增 CSS）。

## 做了什么
1. **外部程序的单独一段**（`parts/programs-notice.tsx`）：安装确认框和插件页“允许版本 X？”确认框里，`programs` 权限不再把 `detail` 当小字，而是一条警告横幅“它会运行外部程序，这些程序可以访问这台电脑上你能访问的一切”+ 程序名列表，带 `(plugin)` 的标“插件自带”。
2. **文字**（`i18n/kernel-texts.ts`）：`reason.undeclaredProgram`、`reason.notInRun`、`reason.notExecutable`、`notFound.program`、审计 `process.run`、`events.failed`，中英文；`blockedByPolicy` 的文字改为同时说明 network.allow / process.allow。`error()` 在没有 `reason` 时按 `params.what` 找 `<code>.<what>`（为 `notFound`+`what: program`）。`process.allow` 进“添加参数”：来自 `params.known`，核对过，不需要改代码。
3. **`plugin:<id>` 主题**（`parts/page-host.tsx`）：页面所属插件（目标 `plugin:<id>`、页面动作 `<pluginId>:<name>` 的前缀、资源 `kind` 的前缀）收到主题就 `page.reload`→重新 `page.resolve`，草稿（`drafts[tab.id]`）随请求带上，未保存输入不丢。
4. **流式输出**（`parts/result-area.tsx` `useLiveLog`）：运行中把 `run.progress.message` 逐条累积成日志（最多 2000 条）显示在代码块里；只有一条消息时仍是原来的单行，所以现有外观/截图不变。结束后显示插件的完整输出。
5. **小项**：插件页版本表上方 `switchFailure` 提示（版本、原因、时间）；已删除页“永久删除”确认框写被引用数（`refs.incoming`，无引用则原文）；引用面板用 `fieldLabel`，没有标签就不显示“位于…”。假实现的引用补了 `fieldLabel`。

## 测试结果（我实际跑过）
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（34 文件 217 用例，含新的 `parts/round6.test.tsx` 6 条）通过。
- `cargo test -p onedesk-host`、`cargo clippy -p onedesk-host --all-targets -- -D warnings` 通过。
- `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts`：23 通过、1 条原本就跳过；已 `git checkout -- docs/screenshots`，截图无改动。

## 等内核合并后要对的假设
1. `PluginPermission.id === "programs"`，`detail` 是逗号分隔的名字，插件自带的以 ` (plugin)` 结尾。
2. `PluginDetail.switchFailure?: { version, reason, at }`，`at` 为毫秒时间戳；`reason` 按 `reason.<reason>` 在错误文字表里找，找不到就原样显示（可能要补 `migrateFailed` 之外的原因文字）。插件树节点的“状态原因”由内核给 `stateReason`，外壳已有显示，未单独改。
3. `RefInfo.fieldLabel?: Label`；合并后可去掉 `protocol/round6.ts` 里的 `switchFailureOf`/`fieldLabelOf`/`RefInfoR6`，改读生成类型。
4. 运行里外部程序被拒的 `RunError`：`code` 为 `denied`/`invalid`，`reason` 为上面几个原因码，已能出字；找不到程序的 `RunError` 若 `code: notFound` 且没有 `reason`，只会显示“它已经不存在了”或插件自己的消息——`RunError` 目前没有 `what`，需要内核给 `reason: "program"` 才能出“找不到这个程序”（`notFound.program` 已备）。
5. 页面所属插件取自 `Resource.kind` 的 `<pluginId>:` 前缀；`plugin:<id>` 主题由内核在事件处理函数结束后发。
6. `refs.incoming` 对已删除目标也返回引用方（内核任务书里已写）；若不支持，确认框只是不显示被引用数。
7. 流式：内核的 `run.progress` 只保留最新一条，外壳靠 `run:<id>` 主题到达时取到的消息累积；若插件一次发得比刷新快，中间几条会漏，**结束后的完整输出才是准确的**。需要真正的逐块输出就得内核给进度增量（本轮没要求）。

## 没做 / 没验证
- 没有连真内核跑；假数据里没有播种 programs 权限、switchFailure 的插件，这几处只靠 vitest 覆盖（e2e 的 `round6.spec.ts` 由测试会话写）。
- 日志不会自动滚到底；实际体验待合并后看。
- 没改 host/src-tauri（无需）。

## 合并后的对齐（对着真内核，实际走了一遍）

合并了协调分支（含第六轮内核与审查修改）。启动法按交接文件做法第 6 条：`ONEDESK_SECRET_STORE=memory`、临时数据目录（会话 scratchpad）、devhost 端口 1450、vite 1441，内置浏览器面板操作；结束后两个服务都已停。

### 改了什么
- 类型：内核已生成 `switchFailure`/`fieldLabel`，删掉临时的 `protocol/round6.ts`，直接读生成类型（typecheck 的 1 处错误是我测试里的 `fieldLabel` 类型）。
- 文字（`kernel-texts`）：清单拒绝 `badPrograms`、`badEvents`；`stateReason` `switchFailed`；原因 `badArgs`、`badEnv`、`tooManyProcesses`、`notFound.folder`（`what: folder`）；`invalid.timeout` 的文字改为网络请求或程序都适用；`insideDataDir`（已有）改成同时适用于授权文件夹与文件访问。测试清单补了 `run.ended`、`resource.changed` 等不是命令/审计名的字符串（kernel-texts 测试那一个失败就是它们）。`events.failed`、`process.run` 早已有文字。事件的 `dropped` 只在插件收到的事件对象里，外壳不显示。
- **主进程清理孤儿（D340）**：`crates/host/src/process_groups.rs`，`cleanup_recorded(workspace_dir)` 与内核同一规则（文件 `<工作区>/process-groups`，每行 `pgid sec usec`；组不存在跳过；组长在且启动时间不同则不动；其余 SIGKILL 整组；最后删文件）。host 不链接内核，所以重复了几行；新增依赖 `libc`（内核已在用，MIT/Apache-2.0；还没写进 `docs/decisions.md`——不在我的允许范围，请协调会话补）。`monitor` 里两处调用：工作进程退出后、关机（含超时强杀）后。**不在“被另一个工作进程锁住（exit 3）”的启动失败路径上清理**，那时工作区属于别人。测试 4 个（/bin/sleep，进程组；结束的、启动时间对不上的不动、组长已退出只剩组员的、文件缺失或乱写），测试后没有残留 `sleep`。
- 流式：显示按整行拼接（之前块自带换行时会多出空行，真内核里看到了）。
- 切换失败提示：原因文字末尾的句号不再重复（真内核里看到“..”）。

### 实际看到了什么（逐条）
1. **安装确认框**：装 `com.example.command/0.1.0`：“Run programs”标“新增”，下面一条警告横幅“It runs external programs, and those programs can reach everything…”，程序名 `echo`、`hello`（带“from the plugin”标）、`sh`、`sleep`。通过。（小瑕疵：程序名与标记挨得较紧，没改。）装完插件树出现 Command。
2. **新建“命令”并运行 `sh -c 'for i in 1 2 3; do echo $i; sleep 1; done'`**：每 300 ms 采样结果区：第 2.0 s 出 `1`，3.1 s 出 `1 2`，约 3.9 s 完成后是完整输出 `1 2 3`；运行中界面确实边跑边出（截图里看到了日志框与“取消运行”按钮）。通过。注意运行中的日志框偏窄、居中（沿用原来的居中布局）。
3. **取消**：`sh -c 'sleep 100 & wait'` 运行中点“取消运行”，3 秒内运行结束为已取消，`pgrep` 里 `sh` 与 `sleep 100` 都不在了。通过。
4. **`process.allow`**：工作区配置页“添加参数”列表里有 `process.allow`（来自 `params.known`，没改代码）。先留空添加（= 禁止一切），运行被拒，结果区文字：“denied — A workspace or environment setting (network.allow for addresses, process.allow for programs) does not allow this.”（文字没有指明程序名和层，可以更具体，内核给了 `program`、`layer`，但 `RunError` 只带 `reason`，外壳拿不到；记 todo）。再把名单改成 `echo, sh`，运行恢复正常。通过。**没试**：名单里不含某程序时只拒那一个（内核测试覆盖）。
5. **`plugin:<id>`**：标签页 A 打开“命令”页并在参数框里改了字（未保存，标着“未保存”）；另一个浏览器标签页新建并运行一条命令。A 页 1 秒内“最近一次运行”变为新的成功时间、“资源数”从 1 变 2，且参数框里的未保存文字还在。通过。
6. **switchFailure**：用 `app.installPlugin` 装 sample 0.2.0（自动升级成功）和 0.3.0（migrate 故意抛错，警告也在安装结果里）。插件页版本表上方出现红色提示“Switching to 0.3.0 failed on 11/16/2026, 11:32: The new version could not take over a resource. Nothing was changed. The plugin stays on its current version.”（已修句号）；插件树节点悬停文字“The automatic switch to a new version failed”。通过。
7. **永久删除的被引用数**：建两条笔记（一条 `[[…]]` 引用另一条），删除被引用的那条，在“已删除”页点“永久删除”，确认框写“…and 1 other item(s) still refer to it; those references will show as missing…”。通过。
8. **引用面板的字段标签**：被引用那条的“Referred to by”只显示来源名，没有“位于…”，因为内置笔记插件的字段没有声明 `label`，内核按设计不给 `fieldLabel`。**有标签的真实路径没有对着真内核看到**（没有现成插件声明字段标签；单元测试覆盖了有/无两种）。
9. **没做**：真实地 `kill -9` 工作进程看主进程清理（这个操作被权限拦下了，我没有绕）；host 的清理只靠 4 个单元测试和代码阅读。zh-CN 没逐屏看。

### 检查
`pnpm typecheck`、`pnpm lint`、`pnpm test`（34 文件 234 用例）通过；`cargo test -p onedesk-host`（13 单元 + 19 集成）和 host clippy `-D warnings` 通过；假数据模式 `e2e/workbench.spec.ts` 23 通过、1 跳过（原有），已还原 `docs/screenshots`。
