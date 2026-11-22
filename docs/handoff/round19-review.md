# 第十九轮独立审查（只读 Opus，2026-11-22，对 `claude/onedesk-r19` @ f7f0260 起）

没跑测试/构建，只读源码。内核关口本身守得住：AI 请求只放行白名单方法、写入管线再拦一道、非 `ai:` 的 actor 被拒、套接字 0600 并校验 uid、迁移 0014 只增、`ai_visible` 挡住 search/describe/run、`run_sql` 默认关、schema 先校验再调用插件、密钥不进结果和审计。

| # | 级别 | 问题 | 归属 | 决定 |
|---|---|---|---|---|
| 1 | 必须 | AI 触发的运行里插件宿主调用不受限（写资源、files、settings、plugins、openExternal、非 GET 网络…），只读靠清单自报 | r19-kernel | D450① |
| 2 | 必须 | 限流只在内存，无界面进程空闲 5 秒退出即清零 | r19-kernel | D450② |
| 3 | 必须 | 审计里 object/resource/runId 无长度上限；被拒/限流/总开关关着的调用无频率上限 | r19-kernel | D450③ |
| 4 | 必须 | `check-arch-ai.mjs` 的 `"ai:…"` 例外会抹掉字符串里的任何禁用词；`.sql` 的 `--` 去注释同理 | r19-tests（等用户回答其请求后再派） | 只放行精确 `"ai"`/`"ai:"`/`"ai:{…}"` |
| 5 | 建议 | search 的 snippet 是正文，可换词拼出 | r19-kernel | D450④ |
| 6 | 建议 | 客户端名写死 `ai:mcp`，`get_run` 只读自己的运行名不副实 | r19-mcp | D450⑤ |
| 7 | 建议 | 动作无静态 `ai.params` 时参数不校验；插件 describe 返回无长度限制 | r19-kernel | 校验并截断 |
| 8 | 建议 | actor 经全局 client 表盖章，连接结束先删章；WS 可自选 `ai:` client id | r19-mcp | actor 直传，WS 拒 `ai:` id |
| 9 | 建议 | AI 连接 `touch_last_opened` 改了默认工作区；应用等锁时持有 `ops`，MCP 套接字在锁之后才监听 | r19-mcp | 跳过；先监听再等锁 |
| 10 | 建议 | 无界面进程不带 `--builtin`；非 UTF-8 行使服务器退出且行长无上限；`Gone` 重发使 `mcp.call` 可能跑两次；退出删别人的套接字；回退路径可预测且不校验 uid | r19-mcp | 逐条修 |
| 11 | 建议 | 自由查询：只读事务挡不住副作用函数 | r19-plugins | D450⑥ 黑名单+说明 |
| 12 | 可接受/记录 | `ai_visible` 管不到插件工具和 `describe` 的宿主读取；用户关可见后 `get_run` 仍可读旧结果；每 10ms 轮询 | r19-kernel | #1 的 resources 过滤 + get_run 再查 |

没验证：真 PostgreSQL 上的副作用函数与词法绕过、外壳代码、e2e、MCP 规范原文对照、`interfaces.*`/`runs.read`/`transfer.*` 等宿主接口。
