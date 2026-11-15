# 任务：第五轮——外壳（Sonnet）

协调分支 `claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。内核会话同时在写，你拿不到这一轮的真内核：按 `round5-plan.md` 和已生成的类型（`src/workbench/protocol/generated/`，round 5 的 `RefInfo`、`KnownParam`、`ImportPreview` 等）写，假实现（`protocol/mock`）补上对应方法供假数据模式和单元测试用。合并后协调会话会请你对着真内核对齐并实际走一遍。

## 目标（`round5-plan.md` §8 外壳一行）
1. 信息面板“引用”一节：引用了 / 被引用两组，`RefState` 三种状态的徽标（已删除、失效），点一条打开对方；`resource:<id>` 事件后刷新。
2. 删除确认框写明被引用数（`refs.incoming`）。
3. “导出工作区…”“导入…”：入口在设置菜单和命令面板；选文件夹（桌面用系统对话框，浏览器模式用输入路径的对话框，照安装插件的做法）；导入先显示 `ImportPreview`（新建、更新、跳过的列表与原因），确认后带 `fingerprint` 调 `workspace.import`，完成后在树里定位到新分组。
4. 配置页、环境页“添加参数”：从 `params.known` 列出已知参数（按 `layers` 过滤），类型按 `KnownParam.type`。
5. 只读、禁止导出：按内核给的 `restrictions`（`readonly`、`noExport`）禁用保存/运行/导出/复制结果并显示原因；`denied` 的 `reason: readonly / noExport` 有英中文字，`params.layer` 用来说明是哪一层限制的。
6. 结果区“导出 CSV”：选保存路径 → `run.export` → 提示写了多少行；非表格输出时禁用。
7. 新增原因码、审计操作名的文字（内核交接文件出来前先按计划里写到的配；`kernel-texts` 齐全性测试合并后再对一次）。
8. 顺带修 `docs/handoff/todo.md` 里“第四轮验收”标出的外壳两条：升级后“上次运行”与结果区不一致；密钥页“使用者”显示资源名称。

## 允许修改
`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round5-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖
`crates/protocol`、`src/workbench/protocol/generated/`、`docs/handoff/round5-plan.md`、`docs/decisions.md` D321–D328、`plugins/**`、`e2e/**`。

## 完成标准
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、host 的 clippy 通过；假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。界面外观不得走样：所有 CSS 只在 `src/design`、只用 token。

## 交付物
自己分支上的小步提交（不推送、不合并）；`docs/handoff/round5-shell-done.md`：改了什么、测试结果、我做的假设（等内核合并后要对的地方逐条列出）、没做/没验证的。

## 共同规则
- 先读 `CLAUDE.md`、`round5-plan.md`、本文件；其余按需读，不整篇读大文件。
- 只改“允许修改”里的文件。不清楚的自行决定并写进交接文件，不要停下来问。
- 测试只用临时目录，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 提交信息 `<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。
