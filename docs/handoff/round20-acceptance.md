# 第二十轮验收记录（发布收尾 / v1.0.0）

集成分支 `claude/onedesk-r20`，头 `15962cc`。

## 结论
可以合入 main 并打 `v1.0.0`，但下列“未做/没查清”必须让用户知道。**未合并、未打标签、未推送。**

## 我自己跑的
- 完整 `pnpm check`（类型、架构、界面规范、vitest 1151、Rust 测试、clippy、e2e）：全绿，e2e 406 通过、5 跳过。
- `.app`（`target/release/bundle/macos/OneDesk.app`）：`codesign --verify --deep --strict` 通过；ad-hoc 签名；版本 1.0.0；二进制 `strings | grep /Users/` = 0；22 个内置插件；`onedesk`、`onedesk-worker`、`onedesk-mcp` 齐全；`smoke-app.sh` 15 项 ok（含 kill -9 工作进程后自动重启）——后两项是 r20-package 的汇报，我未重跑。
- 独立审查（`round20-review.md`）：无阻塞项，应修项已处理。

## 验收中发现并修掉的
- 内核新拒绝原因 `readOnlyField` 缺外壳三语文字（`49b2257`）。
- `gen-types.sh` 的 sort 随环境语言变，检查时好时坏（`15962cc`，固定 `LC_ALL=C`）。

## 没做 / 没查清（如实）
1. **round15 D1 偶发失败没查清根因**（完整跑里出现过两次，单跑 20/20）。已排除内核文案变化和语句真的被执行（`pwned` 标记不存在）；最像的是填入后立刻点运行的时序。已加固（成对重试 + 现场日志），之后完整 e2e 连跑 6 次全过。
2. **week1 K1“点文件夹行不开页签”**：约 1/5 会开出关不掉的 docs 页签，现为 `test.fixme`，是真缺陷，进 1.0 后（见 `post-1.0.md`）——**待用户决定是否 1.0 前修**。
3. **sqlpool 90 项**：77 通过、5 按新需求改、0 不通过、**8 未验证**（F2、F3、F7、I4、J1、K5、K8、L10：需真钥匙串、真 ssh/docker 服务器、真 Anthropic）。
4. **没在 `.app` 窗口里手测**：窗口截图和窗口内崩溃重启提示未验证；手册 8 处截图因此仍缺。
5. **真实 Anthropic / Ollama 验收**未做，等用户用自己的 key 在 `.app` 里做（D447/D452）。
6. `.app` 未公证：首次打开右键→打开（或 `xattr -dr com.apple.quarantine`）。
7. 手册仍有约 10 处“待确认/待补截图”标记，清单见 `round20-docs-done.md`。
8. 后置项见 `post-1.0.md`（D453 多一次渲染、NULL 哨兵撞值、迁移升级只造空库）。
