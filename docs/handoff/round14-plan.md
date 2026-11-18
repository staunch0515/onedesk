# 第十四轮：日常可用版本收尾（协调会话定，2026-11-18）

依据：`dev-plan.md` 阶段 4 验收（`docs/design/ui-spec.md` 逐项对照、I.8 对照 VS Code、浅色深色截图）与阶段 5 验收（`docs/requirements.md` D 节 6 条）；第十三轮后给用户的差距说明（多窗口已做，旧库升级已取消 D403）。沿用前几轮的全部约定。决定从 D409 起编号。

## 1. 做完是什么样

- `ui-spec.md` 里所有标“默认”的项（约 35 处）逐条有结论：**已做**（写明在哪、截图或测试名）、**按现状定稿**（现状与写的不同但合理：改 ui-spec 写成现状，并记决定）、**本轮补上**（日常使用会碰到的小缺口，补实现与测试）、**以后**（明显超出收尾范围的，写进 `todo.md` 并说明理由）。ui-spec 里的“默认”标记全部换成“已定（D…）”或“以后（todo）”。
- `requirements.md` D 节 6 条连真内核逐条有界面检查（`e2e/round14.spec.ts`），全过。
- 浅色、深色：主要页面各一张（欢迎、资源树+笔记、网址、提示词、HTTP 请求与结果、综合、集合、环境、工作区配置、插件页、设置、命令面板、工作区管理），没有看不清的文字、错位、写死的颜色；问题修掉。
- `todo.md`：各会话把自己范围内的条目过一遍——影响日常使用的修掉，其余标“以后”并保留。
- 给用户的桌面实机检查清单 `docs/handoff/desktop-checklist.md`（协调会话写）：启动、窗口、多窗口、钥匙串（用一个测试用密钥名）、https、打包的 `.app`，每项“怎么做、应该看到什么、看到别的怎么告诉我们”。

## 2. 分工

| 会话 | 做什么 | 允许修改 |
|---|---|---|
| 内核（Opus） | `todo.md` 里内核与主进程以外的内核条目（`crates/kernel`、`crates/worker`、`crates/protocol`）：影响日常使用的修掉并有测试；外壳在对照 ui-spec 时提出的内核配合（经协调会话转）；`workspace.info` 改名后名称不更新（第十三轮审查 #10）一并修 | `crates/kernel/**`、`crates/worker/**`、`crates/protocol/**`（只增不改）、生成的 TS |
| 外壳（Sonnet） | ui-spec 逐条（结论表写进 `round14-shell-done.md`，ui-spec 的标记由协调会话最后统一改，外壳在交接文件里给出每条建议的新写法）；补本轮要补的小缺口；深色/浅色的问题；`todo.md` 外壳与主进程条目；I.8 对照 VS Code 的差异表 | 同前几轮 |
| 插件与测试（Sonnet） | 第一阶段：`todo.md` 插件条目（含网址输出文字随语言、各插件页在深色下的问题）；`e2e/round14.spec.ts` 的 D 节 6 条与浅色/深色截图集（`docs/screenshots/round14-light-*.png`、`round14-dark-*.png`）；第二阶段：外壳新增文字的中日译文、对齐外壳补的缺口 | `plugins/**`、`e2e/**`、`scripts/check-*.mjs`、`docs/screenshots/` |

## 3. 完成标准

- 完整 `pnpm check` 通过；`round14.spec.ts` 没有 `test.fixme`。
- 三份 `round14-*-done.md`；外壳的 ui-spec 结论表每条都有出处。
- 不加新依赖；协议只增。
