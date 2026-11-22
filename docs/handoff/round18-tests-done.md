# 第十八轮 · 测试会话（r18-tests）· 第一阶段完成

## 1. `scripts/check-arch.mjs`
内核侧（crates/kernel、worker、protocol、host、src-tauri）禁用词整词（不分大小写）新增：`anthropic`、`ollama`、`claude`、`ai`、`sse`、`ndjson`。
- 边界是“不是字母数字下划线”，所以 `"org.onedesk.ai"`、`"ai.policy"` 里的 `ai` 段会命中（符合预期：内核不认识这些）；`maintain`、`said`、`details` 等不命中。
- Rust 注释和 `#[cfg(test)]` 之后不扫（沿用原规则）；`tests/` 目录里的文件不扫词。
- 已验证：加入含 `ollama`/`SSE`/`claude`/`ndjson`/`org.onedesk.ai`/`ai.policy` 的临时内核文件各自报错，注释里的 `ai`、`maintain` 等不报；现有源码零命中，`pnpm lint`、`pnpm typecheck` 通过。临时文件已删。
- 注意给内核会话：内核里需要英文词 “sse” 的地方不能出现（如变量名 `sse_`——下划线算词内，不会命中；但 `Sse` 单独一词会）。

## 2. e2e 脚手架
- `e2e/fixtures/fake-ai.ts`：**我自写的最小假服务**（`r18-providers` 的 `plugins/_testing/fake-ai/` 当时还没有）。Anthropic 风格 SSE（`/v1/messages`、`/v1/models`）与 Ollama 风格 NDJSON（`/api/chat`、`/api/tags`、`/api/version`）；可设分块、间隔、HTTP 错误状态、`refusal`、`hang`（只发头不发数据）；记录每个请求（方法、URL、头、正文）；统计被客户端中途断开的连接数 `aborted`。**第二阶段若 providers 的夹具到位且约定不同，改 import 即可**。
- `e2e/round18.spec.ts`：启动 devhost（临时数据目录、`--plugins plugins/`、内存密钥库）、辅助函数（`call/create/startRaw/waitRun`）、1 个脚手架自检用例（通过）、K1–K10 与 X5/X6/X15/X16/外壳共 17 条 `test.fixme` 占位，每条写了第二阶段要断言什么。
- 绝不连真 Anthropic/Ollama：只有 127.0.0.1 上的假服务。第二阶段连接资源里要把 `baseUrl` 指向 `ai.origin`（并让资源明确写出这个本机主机和端口）。
- 跑法：`ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost pnpm exec playwright test e2e/round18.spec.ts`。当前：1 通过、17 fixme。

## 3. 需要的内核事实（第二阶段前请确认）
1. 两个服务商连接资源的完整 kind id（我暂写 `org.onedesk.ai.anthropic:connection`、`org.onedesk.ai.ollama:connection`）和字段名（`baseUrl`、`model` 等）以合并后的清单为准。
2. `ONEDESK_SECRET_STORE=memory` 下，表单密钥字段经 `page.save` 写入是否同样进内存密钥库（K5 要查“数据目录里没有明文”）。
3. 假 AI 在 127.0.0.1 随机端口：Anthropic 连接的“只放行连接里写的主机”是否允许 `baseUrl` 写本机地址（D308：本机地址要明确写出），否则 K3/K5 的 Anthropic 用例无法指向假服务。
4. 取消运行的 RPC 名（预期 `run.cancel`），以及 `result.actions`、`search` 新参数、`interfaces.*` 在 devhost 里能否直接 `rpc` 调用（X15 的 `denied/notUsed` 需要一个没声明 `uses` 的测试插件——可能要在 `plugins/_testing/` 放一个或用 `ONEDESK_TEST_HOOKS`）。
5. 长 >60s 的用例不能真等：需要内核有可配置的测试时限（如环境变量缩短 `idleTimeoutMs` 的默认值），否则只测 `idleTimeoutMs` 显式传小值。

## 范围外
无。

最后提交号：见 `git log -1 -- docs/handoff/round18-tests-done.md`。


---

# 第二阶段：`e2e/round18.spec.ts`

连真内核（devhost，合并了 `claude/onedesk-r18`）、`plugins/_testing/fake-ai`（r18-providers 的夹具；我自写的 `e2e/fixtures/fake-ai.ts` 已删）、临时 PostgreSQL、内存密钥库。绝不连真 Anthropic/Ollama：两个连接的 `baseUrl` 都是 127.0.0.1 上的假服务。
- 两个探针插件放在 `e2e/fixtures/r18-plugins/`（运行时复制进临时插件目录，不动 `plugins/`）：`org.test.nouses`（没声明 `uses`）、`org.test.uses`（声明了 `uses`，还声明一个没人实现的接口）、`org.test.keeper`（结果区动作里调 `runs.saveArtifact`，用来验证 D442，因为 AI 工作台自己的“保存分析”目前存不进去，见缺陷 2）。
- 20 个用例，无 `test.fixme`。跑法：`ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost pnpm exec playwright test e2e/round18.spec.ts`（要 PostgreSQL，同上几轮）。
- **目前集成分支上有 2 个用例会失败**（K3 两条等，由缺陷 1 引起）。`R18_SOFT=1` 时，已知缺陷对应的断言只打印 `FINDING …` 不失败（我用它在本地补丁上跑完全部用例：20 通过、6 条 FINDING）；缺陷修好后这些断言就是硬断言，不需要改测试。
- 本地验证补丁（只为验证后面的用例，不提交）见本文件末尾“附：本地补丁”，修缺陷 1 可以直接参考。

## K1–K10 逐行

| 行 | 结果 | 怎么验证（测试名里的编号） |
|---|---|---|
| K1 分析按钮 | 通过（外壳按钮与内核）/ **不通过：点了落在空白页** | `result.actions`：表格和文字结果有 `org.onedesk.ai:analyze`，失败的运行为空，link 结果没有；点击用 `run.start`+`resultRun` 得到草稿 `analysis` 资源且**不发给服务商**；不经点击直接跑 `analyze` 失败（`runs.read` 只在被点击期间）；点击 A 时即使入参写 B 也只读 A；`syncDocs` 带 `resultRun` → `notResultAction`。界面截图 `round18-result-actions.png`。缺陷 4：点了之后外壳开一个标题是裸 id `org.onedesk.ai:analyze` 的运行页，正文空，用户到不了预览页 |
| K3 预览 | 通过（连接缺陷见 1）| 预览页是 `analysis` 资源页：连接/模型行、token 估算、完整请求（可编辑）、每个文档一个勾选；发送前服务商零请求；Send 才发，发的正是（改过的）文字，取消勾选的文档不在里面，`stream:true`、无 `thinking`/`temperature`，密钥只在 `x-api-key`；运行中部分输出逐次是全文，最后输出等于全部。连接优先级：页面 > 环境 `ai.connection` > 设置资源默认；选了非 AI 连接→文字说明；都没有→“No AI connection”。截图 `round18-analysis-preview.png`、`round18-streaming-answer.png`、`round18-answer.png` |
| K4 脱敏 | 通过 | 25 行结果：`password`/`email` 整列 `***`，长数字串→`[number]`，只带前 20 行，300 字的单元格被截；设置里加 `customer` 列名后也被遮；`maxRows` 改 3 生效；发给假服务的正文里没有 `pw-secret-`、`@example.com` |
| K2 资料索引 | 通过 | 授权文件夹（`plugin.grantFolder`）→ `syncDocs` 得 4 个文档（.md/.txt，子文件夹也算，.png 不算）；没设文件夹/没授权都报错；删了文件再同步，资源标为失效、搜不到；`search.query` 的 `mode:any`+`rank:relevance`+`kinds`：任一词命中、命中词多的在前、`all` 要全中、`kinds` 排除同词的笔记；分析草稿里按语句的表名/列名挑到 `orders.md`，总 token ≤ 预算 3000、最多 8 篇 |
| K5 密钥 | 通过 | 密钥进钥匙串（内存库），资源里是 `{secret: …}`；数据目录任何文件、`secrets.list`、所有表的 dump、审计、运行、导出里都没有原值；假服务只在 `x-api-key`（Anthropic）、`authorization`（Ollama）头里见到；连接到关着的端口是普通错误且不带密钥 |
| K6 保存分析 | **不通过（AI 工作台）**；D442 机制通过 | 缺陷 2：`keep` 页面事件调 `runs.saveArtifact`，但内核规定页面事件里只有“本插件已经有附属内容的运行”才能存，新分析没有，所以第一次永远被拒（`denied/notInResultAction`）。D442 本身用 `org.test.keeper` 验证：点击期间能存、列出、每次点击一条；不经点击被拒；审计有 `runs.saveArtifact` 但无名字/内容；用户保留再删除运行后附属内容一起没了 |
| K7 生成 SQL | 通过 | SQL 页“用 AI 写”：默认 `preview`，第一次只给预览、服务商零请求；`aiSend` 后才发；发给假服务的正文有说明和表名，**没有任何行数据** |
| K8 检查 | 通过 | `DROP`、`DELETE`、`SELECT 1; DROP`、注释遮掩的第二条、`WITH … DELETE`、`SELECT INTO`、空文本都不能接受（接受事件没有 `changes`、有文字说明）；字符串和注释里的危险词不误报 |
| K9 接受/拒绝 | 通过 | 接受返回 `changes: {"body.sql": …}`（未保存修改），已保存的资源不变；拒绝后编辑器不变 |
| K10 设置/策略 | 通过（连接下拉缺陷见 1）| 设置资源保存默认连接；`ai.policy`：`off` 时分析、发送、生成全部被拒且服务商零请求；乱写的值按 `preview`（不发）；`allow` 时生成请求直接发。审计里 `interfaces.call`/`runs.read` 不含内容 |
| 提供商 | 通过（断连见缺陷 3） | Anthropic 流式 SSE；401→“refused the key”、429+`retry-after:7`→“Try again in 7 s”、529→busy、400 太长→too long、拒答→“declined”、流内 error 事件→错误；出错后连接仍可用，失败的发送不存答案。取消流式运行 3 秒内结束（断开连接，不排空 30 秒的流）。Ollama：NDJSON、含非 ASCII、用量取最后一行、`/api/tags`/`/api/version`、没有模型的提示 `ollama pull`、404 模型未下载的提示 |
| X15 接口 | 通过 | 没声明 `uses`：`call`/`list` 都 `denied/notUsed`；声明了：`list` 返回两个服务商的类型，没人实现的接口 `invalid/noImplementation`，非 AI 资源 `invalid/wrongInterface`，不存在的资源 `notFound`，真调用返回 `data.text`；审计只有 `interfaces.call`，无内容 |
| X16 流式 | 通过（长超时/两块之间超时没测） | 部分输出、取消、错误状态正文、密钥抹除见上；`idleTimeoutMs` 的 120 秒默认值无法在 e2e 里等，内核 Rust 测试已覆盖（`silence_between_two_blocks_times_out`） |

## 缺陷（别人的文件；我没改。优先级从高到低）

1. **`org.onedesk.ai`（r18-workbench）读不到服务商的连接资源**。原因两层：
   - 清单 `requires` 没有 `"resources": true` → `resources.search` 一律被拒（`notRequested`）。表现：K2 的资料挑选永远是空。
   - `resources.get/list` 只能读自己的类型或**依赖了且被“开放读取”**的别的插件的类型（`export_allows` 要 `depends` 且清单引用了该类型）；AI 工作台经接口使用任意服务商，不能依赖具体插件。所以 `pickConnection` 的 `resources.get(id)` 永远拿不到、`connectionList` 永远为空；预览页写“连接 xxx 没找到”，分析、发送全部失败，设置/分析页的连接下拉只有“无”和裸 id。（`connectionList` 里还有一个小错：`interfaces.list` 返回的 `kind` 已是完整名，不该再拼 `${i.plugin}:`。）
   - 我验证过的**纯插件修复**（`requires.resources: true`；`pickConnection` 用 `resources.search({ ids: [id], limit: 1 })`；`connectionList` 用 `resources.search({ kinds: [i.kind], limit: 200 })`），只要这些，K2/K3/K5/K10 以及提供商用例全部通过；代价是模型名读不到（预览页显示“连接里设的默认模型”）。也可以由内核改成“声明了 `uses` 的插件可读实现方的连接资源”，两种都行，由协调会话定。
2. **K6 保存分析永远失败**：见上表。内核规则（§9.7 ②）是页面事件里只能给“已有附属内容的运行”存。可选做法：`analyze`（结果区点击）里就存一条“草稿”附属内容，之后 `keep` 事件再存；或把 `send`（不是结果区动作）改成可以存；或内核放宽。
3. **断开的流 60 秒后才结束，错误还写成“没在规定时间回答（timeout）”**：假服务在流的一半 `destroy()` 连接，Anthropic 和 Ollama 都是 60 秒后才 `error`（`code: timeout`），不是立刻以网络错误结束。预期：连接异常断开应立刻让 `request` 抛错（插件映射为 `network`）。用例：`X16: Ollama — NDJSON …`（`R18_SOFT=1` 时只打印）。我没有查是内核 `network.rs` 还是插件的问题。
4. **外壳：结果区点击“分析”后落在空白的运行页**：动作返回 `link` 输出，外壳新开的运行页标题是裸 `org.onedesk.ai:analyze`、正文空，不显示链接、也不自动打开目标资源；用户到不了预览页。协议 §1 说“沿用已有的‘动作打开页面’”。需要外壳在结果区动作的运行结果是 `link` 时打开目标（或渲染可点击的链接），并给运行页一个按动作标签的标题。
5. **AI 的回答最后以等宽纯文字显示**：流式过程中（部分输出）按 Markdown 渲染，运行结束换成最终输出后变成 `## Summary` 的原文。服务商/工作台的最终输出需要带 `format: "markdown"`（外壳已松读）。用例里是 `findingA`。
6. 次要：外壳控制台反复打印 `[i18n] no text for kernel key "orders.md"`（文档资源的名字被当成内核文字键）；AI 分析页的“Answer”结果页签和“Send”页签重复，回答只出现在“Send”里。
7. `ai.policy` 是插件自己的参数，内核不认识，所以结果区的“分析”按钮不会在 `off` 时变灰，只在点击后报“AI 被关闭”（r18-workbench 已写明）。

## 其它

- `scripts/check-arch.mjs` 的新禁用词见第一阶段；`plugins/_testing/view-check.ts` 的 `ACTION_RESULT_KEYS` 加了 `data`（D441）。
- 中日译文：补全了外壳新键 `result.elapsedFor`、`result.action.disabled.noExport/readonly/pluginDisabled/other`、6 条 `kernel.error.reason.*`；`lang-check`、`locale-check` 通过（译文未经母语审校）。
- 新截图：`docs/screenshots/round18-result-actions.png`、`round18-analysis-preview.png`、`round18-streaming-answer.png`、`round18-answer.png`（在上面的本地补丁上拍的，所以预览页里连接和 token 估算齐全）。
- 没有跑完整 `pnpm check`（只跑了 `typecheck`、`lint`、`plugins/_testing` 的 vitest）；`round16`/`round17.spec.ts` 没重跑。

## 附：本地补丁（验证用，没有提交）

```diff
--- a/plugins/org.onedesk.ai/main.js
@@ pickConnection
-    r = await ctx.host.resources.get(wanted);
+    const found = await ctx.host.resources.search({ ids: [wanted], limit: 1 });
+    r = (Array.isArray(found) ? found : found.items || [])[0] || null;
@@ connectionList
-      const all = (await ctx.host.resources.list({ kind: `${i.plugin}:${i.kind}` })) || [];
+      const all = (await ctx.host.resources.search({ kinds: [i.kind], limit: 200 })) || [];
--- a/plugins/org.onedesk.ai/manifest.json
   "requires": {
-    "files": true
+    "files": true,
+    "resources": true
   },
```
