# 任务：第四轮收尾——外壳（Sonnet）

协调分支：`claude/onedesk-coord-2-91a88b`（你的工作树从它切出）。第四轮的内核、外壳、HTTP 插件都已合并；验收中内核又改了 D317（网络授权按主机+端口）、D318（可含密钥引用的文字字段、`RunError.reason`），外壳还没跟上。

## 目标

1. `RunError.reason` 的每个原因码都有英、中文字，并在运行失败的界面上显示出来（码的清单：`docs/handoff/round4-kernel-done.md` 的“本轮新增的错误原因与文字键”和“验收后的修改（D317、D318）”两节；以 `crates/kernel` 源码里实际发出的为准，用 grep 核对，不要只信文档）。
2. D317/D318 之后界面要跟着改的地方：`network.allow` 的条目可带端口（提示文字、校验若有）；其他你对着真内核走流程时发现对不上的。
3. `kernel-texts` 齐全性测试覆盖到新增的码和键。
4. **对着真内核把第四轮流程实际走一遍再交**（`round4-plan.md` §1 的每一条）：安装（确认框、权限、坏包被拒）、装 0.2.0 自动切换与接管、版本表、切回、撤销升级、移除有绑定的版本、密钥页、HTTP 请求（发送、`{{secret:名字}}`、别的主机/端口被拒时显示的文字、`network.allow` 收紧）。启动办法见 `docs/handoff/coordinator-handover.md` §4 第 6 条（**必须 `ONEDESK_SECRET_STORE=memory`，数据目录用临时目录**）。发现的外壳缺陷就修；内核或插件的缺陷不改，写进交接文件。

## 允许修改

`crates/host/**`、`src-tauri/**`、`src/workbench/**`（`protocol/generated/` 除外）、`src/design/**`（只用 token）、`vite.config.ts`、`package.json`、`scripts/dev.sh`、`scripts/prepare-bundle.sh`；`docs/handoff/round4-finish-shell-done.md`；`docs/handoff/todo.md`（只追加）。

## 只读依赖

`crates/protocol`、`crates/kernel`、`crates/worker`、`src/workbench/protocol/generated/`、`plugins/**`、`e2e/**`、`docs/handoff/round4-plan.md`、`round4-review.md`、`round4-kernel-done.md`、`round4-shell-done.md`、`docs/decisions.md`（D298–D318）。

## 完成标准

- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test -p onedesk-host`、`cargo clippy -p onedesk-host --all-targets -- -D warnings` 通过。
- 纯假数据模式 `E2E_PORT=1433 pnpm exec playwright test e2e/workbench.spec.ts` 全过、截图不变（跑完 `git checkout -- docs/screenshots`）。
- 交接文件里逐条写：真内核下每个流程你实际看到了什么（通过 / 有问题），没走到的如实写。

## 交付物

自己分支上的提交（不推送、不合并）；`docs/handoff/round4-finish-shell-done.md`（短：改了什么、测试结果、真内核走查逐条结果、发现的内核/插件缺陷、没验证的）。

## 共同规则

- 先读 `CLAUDE.md` 和本文件；其余按需读，不要整篇读大文件（`round4-kernel-done.md` 只读上面点名的两节）。
- 只改“允许修改”里的文件。不清楚的自行按 `docs/redesign/kernel-design.md` 决定并写进交接文件，不要停下来问。
- 测试只用临时目录和内存密钥库，绝不碰真钥匙串和 `~/Library/Application Support/onedesk*`。
- 小步提交：`<范围>: <做了什么>` + 空行 + 为什么。省额度：不做范围外的事；长构建放后台。
- 没运行过、没看到结果的如实写出，不说“完成”。
