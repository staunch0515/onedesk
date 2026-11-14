# 所有会话的共同规则（先读）

开始前按顺序读完：`CLAUDE.md` → `docs/requirements.md`（全部需求与补充要求）→ `docs/architecture.md` → `docs/decisions.md` → 你的任务文件。

- 只改“允许修改”列出的文件。其他文件只读。需要改别处（含冻结接口 `src/plugin-api/**`、`src/kernel/contracts.ts`、`src/platform/contract.ts`、`docs/decisions.md`、`docs/architecture.md`、`CLAUDE.md`、`package.json`、`scripts/**`）时，写进你的交接文件“需要谁确认”，先做不依赖它的部分。
- 不要问用户（用户通常不在电脑前）。不确定的地方选最简单的做法，写进交接文件的“决定”一节，由主会话汇总到 decisions.md。
- 新依赖：先查 decisions.md 的依赖表；表里没有的，写进交接文件（用途、替代方案、许可证），只用 MIT/Apache-2.0/BSD/ISC。可以先用 pnpm/cargo 加上，但必须在交接文件里写明。
- 小步提交到你自己的分支，提交信息 `<范围>: <做了什么>` + 空行 + 为什么，结尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。不要 push，不要合并到 main。
- 每写完一段就编译、跑对应测试和 `pnpm lint`；Rust 改动后跑 `cargo clippy --all-targets -- -D warnings`。写完 JSON 立即 `python3 -m json.tool` 校验。
- 没运行过、没看到结果的，不写“完成”。
- 结束时更新交接文件 `docs/handoff/<你的分支名>.md`（模板见 docs/handoff/README.md），包括：完成了什么、改了哪些文件、测试与检查结果（命令 + 结果摘要）、还缺什么、决定、需要谁确认。
