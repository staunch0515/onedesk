# 第十四轮独立审查（只读的 Opus 子代理，2026-11-18；第四个协调会话整理并分派）

范围：`git diff 152ffce HEAD`。审查者只读代码，没跑命令。每条修改都要补测试；结果写进各自 `round14-*-done.md` 的“审查后的修改”。

| # | 级别 | 问题 | 位置 | 处理人 | 处理 |
|---|---|---|---|---|---|
| 1 | 必须修 | 切换语言后给后台标签改名的新 effect 没沿用 `page-host` 的例外：`shell:secrets` 标签被改成 "shell:secrets"、问号图标、`missing=true`（一直置灰）；插件页标签被改成默认语言的名字 | `src/workbench/workbench.tsx:78-87` | 外壳 | 跳过 `shell:`；`plugin:` 不改标题；把“页面描述 → 标签字段”抽成一个函数三处共用；补单元测试 |
| 2 | 应修 | 该 effect 拿到新语言靠时序（`document.documentElement.lang` 由父组件 effect 设置）；`?lang=` 启动时语言被固定 | `workbench.tsx:79-86`；`main.tsx:29`；`app.tsx:112` | 外壳 | 显式把语言传给 resolve |
| 3 | 应修 | `current_name()` 每次 `workspace.info`/hello/导出都整读 `workspace.json`，不限大小、不查是否普通文件（符号链接到 `/dev/zero`、FIFO 会耗尽内存或挂住）；名字无长度上限；`Workspace::open` 同样 | `crates/kernel/src/workspace.rs:118-119,141-150` | 内核 | 先查是普通文件且 ≤ 64 KiB，限量读；名字截到 100 字符（与主进程校验一致）；补测试 |
| 4 | 应修 | e2e 的 D6 断言几乎不可能失败（拿文件名一起匹配） | `e2e/round14.spec.ts:384-395` | 插件与测试 | 列出具体测试名逐个断言存在，注明真正执行的是 `pnpm test:rust` |
| 5 | 应修 | D5 对比度扫描：阈值 3:1；不算祖先 `opacity`；输入框里的值与占位文字不扫 | `e2e/round14.spec.ts:195-246` | 插件与测试 | D411：正文 4.5:1，大字（≥ 18.66px 粗体或 ≥ 24px）与禁用态 3:1；乘上祖先的 `opacity`；`input`/`textarea` 的值和占位文字也扫；扫出的问题外壳改 token |
| 6 | 只记录→本轮做 | 没编译 devhost 时 round14 整个静默跳过 | `e2e/round14.spec.ts:33` | 插件与测试 | 环境变量 `ONEDESK_E2E_REQUIRE_DEVHOST=1`（`pnpm check` 设上）时缺 devhost 直接失败 |
| 7 | 只记录 | D3 断言没查“不可用”状态；D5 里 `.catch(()=>undefined)` 吞错误 | `round14.spec.ts:141-143,345-348` | 插件与测试 | 顺手改 |
| 8 | 应修 | `layerName` 已加，但界面文字仍不显示是哪一层禁止的 | `kernel-texts.ts:177` | 外壳 | 文字里带上层名 |
| 9 | 只记录 | `env_options` 的防环无效（无害）；防环测试对删除结果用 `let _ =` 忽略 | `round2.rs:199-213`；`tests/round14.rs:96-118` | 内核 | 测试断言删除结果；无效的防环删掉或改成真正有用 |
| 10 | 只记录 | 下拉菜单 `anyIcon` 用 `!e.type` 判断；勾选项与无图标项混排仍不齐 | `dropdown-menu.tsx:36` | 外壳 | 顺手改 |
| 11 | 应修（核实） | 运行中改名后界面上的工作区名是否更新没验证 | `state/startup.ts:14` | 外壳 | 收到 `app.workspacesChanged` 时更新标题栏名称；补测试 |

没有问题的检查点：内核无插件名；`init-settings` 判定正确、全新工作区仍能应用；`layerName` 只在拒绝时多查一行；`current_name()` 回退正确；`descendants`/`purge` 防环正确；下拉菜单只用 token；e2e 用内存密钥库与临时目录、深色组确实在深色下拍；D1–D4 真正在检查需求。
