# 第十八轮独立审查（只读 Opus 子代理，2026-11-22）与分派

读代码推断的 #1–#3 没在真内核跑过，需用 e2e 复现；决定见 D444、D445。

| # | 严重度 | 问题 | 归 |
|---|---|---|---|
| 1 | 必须 | 工作台读不到服务商连接（resources.get/list 被 foreignKind 拒），发送与 generate 必败；下拉自己填 options 使内核不再补 | kernel（D444③ interfaces.resources）＋ workbench |
| 2 | 必须 | K2：缺 `requires.resources`，search 被拒、表名读不到 | workbench（加权限；表名从运行输出的列与 meta 取） |
| 3 | 必须 | K6：页面事件首次保存被拒（has_own） | workbench（analyze 点击时先存一条草稿附属内容） |
| 4 | 必须 | search snippet 泄露任意资源正文（D389） | kernel（D444②） |
| 5 | 必须 | `uses` 不是权限 | kernel（D444①） |
| 6 | 必须 | generate 预览可由调用方 `confirm:true` 绕过；aiSend 重新组装，所见≠所发；instruction/tables 可夹带数据 | workbench |
| 7 | 必须 | 敏感列脱敏可绕过（passwordhash、accesstoken、emailaddress、中文列名；只查 label） | workbench（子串匹配＋中文词表＋label 与 key 都查） |
| 8 | 建议 | ai.policy=off 时 result.actions 仍显示按钮；服务商不查 policy | 记入 1.0 后；点击时给清楚的说明（workbench） |
| 9 | 建议 | 配置名与 D443 不一致 | D444⑥ 统一为 ai.connection |
| 10 | 建议 | baseUrl 允许 http（非本机）、`@` 伪装主机 | providers |
| 11 | 建议 | 结果区动作新运行的环境依赖外壳传的 envId | kernel（D444④） |
| 12 | 建议 | 沙箱流 id 撞名 | kernel（D444⑤） |
| 13 | 建议 | 非 2xx 正文 8KB 先截后抹除；编码形式未抹除 | kernel（D444⑤） |
| 14 | 建议 | checkSql 放过有副作用函数；只适用 PG | workbench（黑名单＋注释写明 PG 语义） |
| 15 | 建议 | 电话格式漏打码 | workbench |
| 16 | 建议 | 预览不显示 system；send 把内容写进资源正文并进全文索引 | workbench（预览加 system；内容只在用户保存时存） |
| 17 | 建议 | SQL 为找锚点加了 requires.resources | D445 去掉锚点；kernel＋workbench |
