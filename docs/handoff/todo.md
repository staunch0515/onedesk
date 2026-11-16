# 范围外待办（第一个里程碑结束时汇总，主会话）

- 插件隔离：插件与宿主同进程，可绕过宿主 API（D58）。下一阶段：Worker/独立进程 + Rust 侧权限检查。
- 浏览器预览模式的 localStorage 持久化（T01）：第二个里程碑结束前评估是否保留预览模式。
- 多语言：内核、插件、平台、Rust 的中文信息抽取到资源文件（D134）。
- lucide 全量图标约 1.2 MB，改为按需加载（D121）。
- 附件：导出中的 `attachments/` 目前为空（D57）。
- 导入时校验标签中的 `"`、`\`（D113）。
- 跨分组拖动排序（D126）。
- 视觉回归：截图像素比对（D137）。
- 界面测试只覆盖 Chromium 预览；导入导出、钥匙串、卸载/重新安装没有 e2e（原生对话框与钥匙串在预览中不可用）。
- “动作执行中界面不冻结”没有自动化测试（动作是异步的，手动验证过）。
- 桌面应用内冷启动的自动计时；空闲机器上重测 docs/perf.md。
- 外部插件只能手写 `OneDeskError`（name/code 约定），可提供一个可复制的小运行时。

## 来自 week1-kernel（2026-11-15）

- 根 `Cargo.toml` 的 `[workspace.dependencies]` 里 `futures-util`、`libc`、`onedesk-host`、`tokio-tungstenite` 未被任何包用到时，每次 cargo 都打 4 条 “unused workspace dependency” 警告（外壳分支用上之后自然消失；否则删掉）。
- 架构检查（`scripts/check-arch.mjs`）给 Rust 内核加规则时：`files`（宿主能力名、清单 `requires.files`）、`text`（视图节点和字段类型）是协议里的机制名，不是插件名；应检查的是内置插件 id（`org.onedesk.*`）和它们的类型名。
- 审计的“合并计数”（kernel-design §4.3）未做：`audit` 禁止 UPDATE，需要另设计存法并加迁移。
## 外壳会话（week1/shell）追加

- 发布构建：`pnpm build` / `tauri build` 还没验证。入口是 `workbench.html`，Tauri 的 `frontendDist` 默认找 `index.html`；需要把 `vite.config.ts` 的 `build.rollupOptions.input` 指向 `workbench.html` 并让打包后的首页叫 `index.html`（或加一个重定向页），内置插件目录要放进应用包的 `Resources/plugins`（主进程已按这个位置找）。
- 工作进程可执行文件的打包：发布构建里 `onedesk-worker` 要作为同目录的附带可执行文件（Tauri `externalBin` 或自定义打包步骤）。
- `playwright.config.ts` 的 `webServer.url` 是 `http://localhost:<port>`，而界面入口是 `/workbench.html`，Vite 对根路径返回 404，Playwright 会等到超时。插件与测试会话的分支已把它改成 `/workbench.html`；合并时保留那处改动。
- 大树分页：外壳现在一次把一层所有批次读完（上限 5000 个节点，`protocol/children.ts`）。文件树里有几万项时需要真正的虚拟滚动 + 按需分批。
- 混合客户端判断资源归谁用“先问内核、再回退演示”并缓存；演示数据与真数据的 id 万一相同会判错（真 id 是随机的，本周不会发生）。
- `page.event`（SQL 格式化等）仍由演示实现；内核没有对应方法。
- （验收）在桌面窗口里实际点一遍并截图；系统选择文件夹对话框未验证。
- （收尾）打包出的 `OneDesk.app` 从命令行启动时停在图形启动阶段，未能确认；在访达里双击验证。未签名、未公证。
- （第二轮审查 #14）`env_options`、`descendants`、永久删除的遍历没有“已访问”集合，库里若出现成环数据会死循环。

## 来自 round2 kernel（审查 #14）

- 库里若有成环数据（接口造不出），`env_options`、`store::descendants`、永久删除的后代遍历会死循环；`store::ancestors` 已有 1000 层上限。需要时给这几处加访问集合。
- （第三轮审查 #10）宿主写调用已交给写线程后遇到取消：写入落库而插件收到被拒。
- （第三轮审查 #12）停用插件与激活运行环境之间的窄竞态。

## 来自 round3 kernel（审查 #10、#12）

- 宿主写调用已交给写线程之后遇到取消：写入照样落库，而插件收到“被拒绝”。要么写入前再查一次令牌，要么把“已提交”作为结果返回。
- 停用插件与激活之间的窄竞态：停用丢弃运行环境的同时若有一次调用正在激活，新的运行环境可能留下（之后的调用仍会被 `plugin_enabled` 拒绝，只是占内存）。
- （第三轮验收）插件树节点的名称不随界面语言变化（`TreeNode.label` 是纯文字，内核取了英文）；需要 `tree.children` 带语言或节点标签支持多语言。
- （第三轮验收）插件页上“卸载”“检查更新”等还没有实现的按钮应隐藏或禁用；没有声明 `files` 的插件不应显示“授权文件夹…”。
- （第三轮）运行记录树里失败的运行与“失效”节点用同一种删除线样式，容易混淆；需要一个表示“失败”的节点状态。

- 示例查询升级接管后，运行条显示“还没有运行过”而结果区仍留着升级前的结果，二者不一致（A8，轻微）。外壳在版本变化时没有清结果区，也没有重取运行条的“上次运行”；需要确认是内核升级后把 lastRun 清掉了，还是外壳按资源绑定版本取。
- 密钥页“使用者”列显示资源 id（A2 的可选部分）：外壳可以按 id 取资源名，但没做。
- （第四轮验收）自动切换版本失败（`rescan` 时 `migrate` 抛错）界面没有任何提示；需要内核在 `plugins` 事件或插件节点上带“升级失败”状态，外壳配字。
- （第四轮验收）手动启用旧版本会把它固定；之后再启用新版本，“已固定”仍留在旧版本上，含义含糊，需要定规则。
- （第四轮验收）工作区配置页没有 `network.allow` 的编辑入口，只能经协议 `params.set` 设。
- （第四轮验收）构建产物 `target/debug/onedesk-worker` 在一次 `pnpm check` 中途变成 0 字节，原因没查实。
- （第五轮审查）导入与安装插件的指纹用 FNV-1a，不防蓄意碰撞；两处一起换成 SHA-256（需新依赖 sha2，MIT/Apache-2.0）。

- [round5-tests] 外壳：假实现/测试补 `ImportPreview.grantHosts/secretNames`（typecheck 3 处）；导入预览对话框渲染这两项；删除确认的被引用数（见 round5-tests-done.md 的 fixme）；`kernel-texts` 补 `run.export` 与新原因码。
- （第五轮）已删除页里“永久删除”的确认框没有被引用数（普通删除已有）；`e2e/round5.spec.ts` 里留了一条 `test.fixme`，下一轮由外壳补。
- （第五轮验收）信息面板“引用”一节里显示的是字段的内部名（“位于 body.text”），应显示字段的标签或不显示。

- （第六轮内核）动作的总时长仍是 D288 的 60 秒，`process.run` 的 `timeoutMs` 最长 600 秒实际被它截断；是否在运行外部程序时延长动作时长，请协调会话定。
- （第六轮审查，D339）运行的宿主接口可被插件存起来在运行期间从别的上下文使用；考虑把调用 id 与发起它的那次调用绑定。
- （第六轮审查，D339）插件可以把某次运行的 `ctx.host` 存起来，在运行结束前从页面或事件处理函数里使用（运行里才允许的能力因此短暂可用）。要改需要让宿主调用按“调用者的当前上下文”而不是按调用 id 授权。

- （第六轮外壳）运行失败的文字对外部程序太笼统：`blockedByPolicy` 不说是哪个程序、哪一层、`notFound` 不说缺哪个程序、`undeclaredProgram` 不说名字。内核的 `params` 里有 `program`/`layer`，但 `RunError` 只带 `reason`。需要内核在 `RunError` 加可选 `params`（只增），外壳再把名字写进文字。
- （第六轮外壳）`libc` 作为 `onedesk-host` 的新依赖，尚未记入 `docs/decisions.md`。

## 第七轮内核会话留下的（2026-11-16）

- 主进程 `app.removePlugin` 应在移除前转发 `plugin.checkRemove {plugin, version}`，出错原样返回（`conflict/dependents`）。内核已提供方法，host 未接（外壳的文件）。
- 依赖方给被依赖类型加的动作目前只在页面操作区；树节点右键菜单里没有动作这一类，要加需先定怎么从菜单发起运行。
- `plugin.undoUpgrade` 不检查依赖方（计划没列）；是否也应被 `conflict/dependents` 拒绝，待定。

- （第七轮 外壳对齐）笔记页没有结果区：依赖方的动作（统计字数）成功后输出只出现在任务面板。需要决定：依赖方能否给被依赖类型加结果区页签，或外壳在没有页签时显示最近一次运行的输出。
- （第七轮 插件）插件市场里清单有错的包显示成原始键 `plugin.name`/`plugin.description`，状态“未安装”，应为“不可用”并给原因；下拉框也不应让它可选。
