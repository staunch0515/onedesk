# 第五轮 外壳 交接

分支 `claude/r5-shell-655929`（从协调分支切出，未推送、未合并）。

## 改了什么
- **协议层**：`ProtocolClient` 加 `refs.outgoing/incoming`、`params.known`、`workspace.export/importPreview/import`、`run.export`；`real-client`、`mixed-client`（引用按资源归属分流，导出/导入走内核）、假实现都补上。`PageDescriptor` 在外壳侧类型上加 `restrictions?: string[]`（生成类型里还没有）。
- **信息面板“引用”一节**（`parts/info-panel.tsx`）：引用了 / 被引用两组，`deleted`、`missing` 徽标（悬停有说明），点一条打开对方；订阅 `resource:<id>` 刷新。
- **删除确认**（`parts/command-dialogs.tsx`）：危险确认弹出时按 `refs.incoming` 查被引用数，写进说明。
- **导出/导入**（`parts/transfer-dialogs.tsx`）：入口在设置菜单（现在不管有无钥匙串都是下拉菜单）和命令面板；桌面用系统选文件夹，浏览器输入绝对路径；导入先显示 `ImportPreview`（新建/更新数、跳过列表和原因、不可读的原因），确认后带 `fingerprint` 调 `workspace.import`，完成后在树里定位新分组。
- **添加参数**（`pages/add-param-dialog.tsx`）：环境页和配置页（配置页是 ViewPage，动作栏里多一个“添加参数”）从 `params.known` 按 `layers` 过滤、排除已有的，值控件按 `type`（boolean 用开关，默认开；number 用数字框）。
- **保护提示与禁用**：`Frame` 在 `restrictions` 含 `readonly`/`noExport` 时显示横幅；`ViewPage` 在 `readonly` 时禁用保存/运行（含 ⌘S、⌘↵）；结果区在 `noExport` 时禁用“导出 CSV”和“复制结果”并把提示放在按钮标签上。
- **结果区“导出 CSV”**：桌面走新的 Tauri 命令 `pick_save_file`（系统另存为），浏览器输入路径；调 `run.export`，提示写了多少行；非表格输出时禁用。
- **文字**：`kernel-texts.ts` 新增原因 `readonly noExport notExport badVersion unreadable notEmpty insideData exists notTable notFinished unsupportedFormat changedSincePreview`（中英），清单原因 `badRefsField`，审计操作 `workspace.export workspace.import run.export`；`kernel-texts.test.ts` 的清单同步更新。
- **验收问题两条**：版本变化（升级接管）时 `ViewPage` 清掉结果区的运行并重新取页面（“上次运行”与结果区一致）；密钥页“使用者”按资源 id 取名称显示。
- 测试：`transfer-dialogs.test.tsx`、`info-panel.test.tsx`（引用）、`protocol/mock/round5.test.ts`、`mixed-client.test.ts`。

## 结果
- `pnpm typecheck`、`pnpm lint` 通过；`pnpm test` 32 个文件 207 个用例全过。
- `cargo test -p onedesk-host` 19 个通过；`cargo clippy -p onedesk-host --all-targets -- -D warnings` 通过；`cargo check -p onedesk`（src-tauri，含新命令）通过。
- `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts`：22 通过、1 跳过；第一次跑 “dark plugin page” 因等标签超时失败，单独重跑通过（负载抖动，非代码问题）。已 `git checkout -- docs/screenshots`。
- 没有提交截图。信息面板多了“引用”一节、环境页多了“添加参数”按钮，所以假数据模式下相应截图与之前**不会**逐像素相同；没有改任何已有样式，也没有新增 CSS。

## 等内核合并后要对的假设
1. `refs.outgoing/incoming` 的参数是 `{ id }`，结果是 `RefInfo[]`；`incoming` 里 `source` 是对方、`outgoing` 里对方是 `target`（`missing` 时没有 `target`，外壳显示 `[[text]]`）。
2. 引用变化发 `resource:<id>`（来源、目标两边）；外壳只订阅这个主题。
3. `params.known` 返回 `layers` 里的值恰好是 `config`、`env`；配置页的判断依据是 `breadcrumb` 最后一项 `tree === "config"` 且 `autosave`（内核当前 `core:config` 页就是 `param_form` + `autosave`）；添加用的是 `params.set(节点 id, 名称, 值)`，配置节点也应接受。boolean 默认写 `"true"`。
4. `PageDescriptor.restrictions`（`readonly`/`noExport`）：`page.resolve` 和 `page.save` 返回的页面都带；没有时按“无限制”。生成类型里还没有这个字段。
5. `denied` 的 `params.reason` = `readonly`/`noExport`；文字由 `reason.readonly`/`reason.noExport` 给，**没有用 `params.layer` 拼层名**（`error()` 是同步的、拿不到节点名）。文字只说“请到设置它的工作区配置或环境里关闭”。若要写出具体哪一层，需要外壳再按 `layer` 取一次节点名——合并时再决定。
6. 导入预览的 `problem` 是 `ProtocolError`，`params.reason` 为 `notExport`/`badVersion`/`unreadable`；跳过原因只认 `unknownKind`/`needsVersion`/`invalid`，其他原样显示。
7. `workspace.import` 返回的 `group.id` 是资源（分组）id，外壳用 `resource.get` 取 `tree` 后 `reveal`。
8. `run.export` 参数外壳发 `{ run, path, format: "csv" }`；“非表格输出”禁用只看 `run.output.type === "table"` 且 `status === "success"`。
9. 内核给的新原因码我是按计划文档猜的：`notEmpty`（目标文件夹非空）、`insideData`（在数据目录里）、`exists`（CSV 文件已存在）、`notTable`、`notFinished`、`unsupportedFormat`、`changedSincePreview`（指纹不符，code 我假设是 `conflict` 之类，只靠 reason 取字）。合并后对 `round5-kernel-done.md` 的清单逐个核；`kernel-texts` 齐全性测试里 `KERNEL_REASONS`/`OPERATIONS` 也要对一次（`workspace.import` 之类字符串若出现在内核源码里，那个“扫描新 key”的用例会逐个检查）。
10. 删除确认的被引用数：假设危险确认的 `context.target` 是 `resource:<id>` 或 `context.nodeKey` 就是资源 id（资源树的 key = 资源 id）；对环境树/回收站同样适用，查不到时当 0。
11. 版本变化清结果区：用 `resource.get(id).pluginVersion` 变化判断（订阅 `resource:<id>`、`plugins`）。若内核升级接管后 `pluginVersion` 不变（只改正文），就不会触发。
12. 桌面端 `pick_save_file` 只写了 Rust 命令并通过 `cargo check`，**没在桌面窗口里实际点过**；系统选文件夹导出、导入也没点过。

## 没做 / 没验证
- 只读时，信息面板里的名称/描述/标签输入框和历史“恢复”按钮没有按 `readonly` 禁用（保存会被内核拒并弹 toast）；树里的新建/删除/拖动同理，靠内核拒绝。
- 导出/导入入口没有按 `no_export`/`readonly` 灰掉（工作区层面的限制界面拿不到，只有页面的 `restrictions`）；被拒时弹带原因的 toast。
- 没有连真内核跑过任何一条新流程（内核本轮还没合并）；`e2e/round5.spec.ts` 是测试会话的事。
- 正文里 `[[…]]` 点击跳转按计划不做。

## 合并后的对齐（对着真内核走了一遍）

合并了 `claude/onedesk-coord-2-91a88b`（内核第五轮 + 审查）。用临时的 Playwright 脚本（已删，没提交）连 `onedesk-devhost`（`ONEDESK_SECRET_STORE=memory`、临时数据目录）实际操作，下面是看到的。

**修了的外壳问题**
- 删除确认：内核的 `node.delete` **没有确认框**（直接软删），所以原来挂在确认框上的“被引用数”根本不会出现。改成外壳在 `actions.command("node.delete")` 里先查 `refs.incoming`，有引用就弹确认并写明“还有 N 处引用了它”，没有引用照旧直接删。纯假数据模式和演示树（演示数据里自带 `[[…]]`）仍直接删，否则 `workbench.spec.ts` 里的删除用例会被确认框挡住。测试 `state/delete-refs.test.tsx`。
- 导入预览被拒时对话框标题和横幅标题重复（“这个文件夹不能导入”两遍）：去掉横幅标题。
- 只读/禁止导出的横幅标题与正文重复：只留正文。
- “添加参数”里 Select 受控/非受控切换的 React 警告：按所选值加 `key`。

**对齐的接口与文字**：`ImportPreview.grantHosts`、`secretNames`（假实现补上；预览框列出“将允许插件访问的主机”和“引用的密钥”，用 `secrets.list` 标“本机已有/本机没有”）；`ImportSkip.reason = config` 有文字；补了 `insideDataDir noParent writeFailed fingerprintChanged badParent badFormat duplicateId tooLarge noOutput` 的中英文和审计名 `refs.rebuild refs.sync`，`kernel-texts` 测试（含扫描内核源码的用例）通过。

**实际看到的**
1. 笔记 A 写 `[[Target B]] and [[Nobody]]`：信息面板“引用”一节显示“Refers to：Target B（In body.text）、[[Nobody]] 失效”；改名 B 后面板自己刷新成新名称（按钮“Open Renamed B”）；删除 B 后显示“已删除”徽标，恢复后回到正常；打开 B，“Referred to by”里有 A，点它打开 A 的标签。三种状态都看到了。
2. 删除确认：见上，修后弹出“Are you sure? 1 other item(s) refer to it…”（对话框标题是通用的“Are you sure?”）。
3. 导出工作区：设置菜单 → 路径框 → 导出，写出 `audit.json blobs manifest.json resources.json revisions.json runs.json`，提示“Exported 4 item(s) to …”。
4. 导入 `e2e/fixtures/exports/sample`：预览“4 new, 0 updated, 1 not imported；Orphan thing / com.example.missing:thing —— 没有已安装的插件处理这个类型”；确认后“Imported 4 new and 0 updated into “Export sample””，树里出现新分组。选一个不是导出的文件夹：显示“这个文件夹不是 OneDesk 的导出”，导入按钮灰。样例里没有授权主机和密钥，所以这两块**只在假实现和单元测试里看过，没在真内核上看到**。
5. 配置页：动作栏里“Add parameter”，下拉列出 `ui.language, network.allow, protection.readonly, protection.no_export`；加了 `protection.no_export`、`network.allow`（值 `api.example.com:443`）、`protection.readonly`，页面值读回正确。环境页的下拉列出 `network.allow, protection.readonly, protection.no_export`（没有 `ui.language`，符合 layers）。
6. 只读：横幅出现；笔记页 Run、Save & run 灰；在信息面板里改描述，弹出带原因的 toast（“Read-only protection is on … Turn it off in the workspace configuration or the environment that sets it.”）。配置页本身仍可改参数（关得掉）。
7. 禁止导出：结果页横幅；“导出 CSV”和“复制结果”灰；设置菜单里导出工作区被拒，toast 带原因，目标文件夹没被创建。
8. 结果区导出 CSV（示例查询跑一次）：“Wrote 200 row(s) to …/r.csv”，文件以 BOM 开头、CRLF，首行 `id,customer,amount,status`。

**内核/插件侧的现象（只记录，没改）**
- 配置页里 `ui.theme` 的标签是原样的参数名，`tx()` 打了一条“no text for kernel key ui.theme”的控制台警告（参数名当标签用）。
- 删除确认的标题是通用“Are you sure?”，没有针对删除的标题（外壳侧没有对应的 kernel 文字键，可后续加）。

**没验证**：桌面窗口里的系统选文件夹/另存为（`pick_save_file`）；导入预览里的授权主机、密钥名在真内核上的显示；中文界面下这些新对话框没截图。

**完成标准**：`pnpm typecheck`、`pnpm lint`、`pnpm test`（33 个文件 211 个用例）通过；host：`cargo test -p onedesk-host`、clippy `-D warnings` 通过；假数据模式 `workbench.spec.ts` 23 通过、1 跳过（已 `git checkout -- docs/screenshots`）。
