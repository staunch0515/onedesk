# round2/tests（分支 claude/week1-plugins-15d46f）：第二轮界面检查

## 完成了什么
- `e2e/round2.spec.ts`（连真 devhost）：
  - 环境：新建子环境、继承并显示来源、覆盖（“Overrides Default: eu”）、父值改变后出现“Changed upstream”、“Keep mine”清掉标记、再变化后“用继承值”。
  - 工作区配置页改一个参数（autosave），重启 devhost 后仍在。
  - 语言（简体中文）、主题（深色）、密度（紧凑）改后，内核里存的值正确，重启后界面仍是这些。
  - 收藏/取消收藏出现并消失于收藏树；删除→已删除树与页面→恢复→再删除→永久删除（确认框含“cannot be undone”，取消后仍在，确认后 `resource.get` 为 null）。
  - 历史：环境页历史列出参数变化与改名，新的在前，点“Restore”恢复并出现 `restore` 条目；笔记的改名/改正文历史与按字段恢复（走协议，见“发现的问题”G1）。
  - 搜索：⌘K 搜名称、搜正文、搜两个字的中文词“周报”、搜不到已删除的笔记。
  - 审计：经命令面板打开审计页，能看到刚才的操作（笔记创建）；按“结果”过滤，OK 有行，Denied 的行数与 `audit.list` 一致（插件读授权之外的文件被拒绝并有审计）。
- `e2e/kernel-host.ts`：把 devhost 启停、`openKernel`、`rpc` 等从 `week1.spec.ts` 抽出共用；`openKernel(page, host, null)` 不带 `?theme`（重启检查用）。
- 截图：`docs/screenshots/round2-*.png`（浅色 12 张；深色 3 张：环境页、审计页、中文·深色·紧凑设置）。
- 架构检查规则这轮无需调整（新代码没有误报）。

## 测试结果
`E2E_PORT=1432 pnpm e2e`：**39 通过、0 失败、2 跳过**（1 个 `test.fixme`：K-A1；1 个 workbench.spec 原本就跳过的 review shots）。`pnpm lint`、`pnpm typecheck`、`pnpm test` 通过。

## 发现的问题
**K-A1（内核，`crates/kernel/src/round2.rs` 约 489–492 行）**：`audit.list` 的 `text` 过滤是 `op LIKE ? OR object LIKE ? OR summary LIKE ? OR actor LIKE ?`，匹配的是 `object`（资源 id）而不是页面显示的 `target`（资源名称），所以审计页“Contains / 目标或详情”输入资源名称什么也找不到。复现：`page.save {target:"new:org.onedesk.note:note", changes:{name:"Audit probe"}}`，然后 `audit.list {text:"Audit probe"}` 返回 `[]`，而 `audit.list {}` 里有 `target:"Audit probe"` 的行。期望：也匹配资源当前名称（或写审计时存名称）。检查：`test.fixme("audit: the Contains filter finds a record by the target name")`。

**A1（外壳，`src/workbench/parts/status-bar.tsx` 约 78 行）**：状态栏的主题切换是只有图标的 `StatusItem`，`title` 只放进了 Tooltip，按钮没有可访问名称（读屏器读不出；`getByRole("button", {name})` 找不到）。建议给它 `aria-label={t("status.theme")}`。我的检查用 CSS 选择器绕开，改后可换成 `getByRole("button", { name: "Switch light / dark" })`。

**G1（外壳，信息面板）**：笔记等资源页没有历史入口——历史只出现在环境页和带结果区的页面（`result-area.tsx` 的 History 标签，只有 SQL 演示页有）。任务要求里“信息面板或页面里的历史”对笔记在界面上无法检查；笔记的历史与恢复我只测到协议层（`resource.history`/`resource.restore`）。若期望笔记也有历史界面，需要外壳在信息面板或笔记页加历史。

**观察（非缺陷）**：审计页没有树/工具栏入口（内核命令 `open.audit` 只能经命令面板 ⌘⇧P 到达）；左侧活动栏按钮是开关（再点会收起侧栏），检查里用 `aria-pressed` 判断后再点。
