# round4/tests（分支 claude/week1-plugins-15d46f）：第一阶段——HTTP 请求插件与升级夹具

## 完成了什么
- `plugins/org.onedesk.http/`：类型 `request`（资源树；body `method`、`url`、`headers`、`body`；`defaults` GET/空）；清单 `requires.network.fromResources: true`，类型声明 `"fields": { "url": { "type": "text", "grants": "network" } }`；动作 `send`（`output: "text"`）；页面 `editor`（`recompute`、`usesEnv`；动作 发送/保存/保存并发送；结果页签 `response`（output）、`headers`（view）、`history`）；“新建”菜单。
  - 页面：方法（枚举）+ 地址一条带；参数条（从地址、请求头、请求体里的 `:name` 得出；冒号前是空白、行首或 `= , ( & ? /` 才算参数，所以 `http://`、`host:8080`、JSON 的 `"k":v`、`{{secret:名}}` 都不是）；请求头（长文本）；请求体（占满高度的长文本）；运行页（`ctx.run`）全只读。
  - 动作：参数先取手填（`ctx.params`）再取环境（`host.params.get`）；填进地址/请求头/请求体；请求头按行 `名: 值` 解析；GET/HEAD 不发请求体；`host.network.request({method,url,headers?,body?})`；输出文字 = 响应正文；摘要 `<状态码> · <耗时> ms · <字节数> bytes`（截断时加 truncated）；非 2xx 是成功的运行（状态码在摘要里）；宿主错误（网络错误、denied…）带原因抛出：消息 `The request failed (denied/hostNotAllowed)`，`code`/`params` 原样保留；地址为空在发请求前失败。`{{secret:名字}}` 一个字不动地交给宿主，插件不碰 `host.secrets`。
  - 响应头页签：动作把响应头按资源存进 `storage`（键 `lastHeaders:<资源id>`），页签读这个键渲染成表格（按名排序）。
- `e2e/fixtures/plugins/`：
  - `org.onedesk.sample/0.2.0/`：`upgradesFrom: ">=0.1.0 <0.2.0"`；`requires.network: { hosts: ["example.com"] }`；`host.kinds.handle("query", { migrate(body, from) → {...body, note: "migrated from <from>"} })`；页面在编辑区上方显示 `note`（`Note: …` / `备注：…`）。
  - `org.onedesk.sample/0.3.0/`：`upgradesFrom: ">=0.1.0"`，`migrate` 抛错（检查“失败则全部不动”）。
  - `broken/`：清单里有未知字段（严格校验拒绝）。
  - 它们在 `e2e/` 下，不在 `plugins/`，所以 `check-arch`、`check-ui` 和 vitest 的内置插件扫描都不会碰；它们的 vitest 在 `plugins/_testing/fixtures.test.ts`。
- `plugins/_testing/view-check.ts`：`registry` 也收 `kinds`。

## 测试与检查结果
`pnpm test`、`pnpm lint`、`pnpm typecheck` 通过（插件相关 vitest：5 个文件 72 个测试，其中 HTTP 插件 22、夹具 7）。

## 我做的决定 / 假设（第二阶段合并后对着真内核核对）
- 类型字段声明的位置：`kinds[].fields.<名字> = { type, grants? }`；清单里 `requires.network` 的两种写法：`{ "fromResources": true }` 与 `{ "hosts": [...] }`；`upgradesFrom` 在清单顶层。第四轮内核还没合并，这些都只按计划文字写，清单是否被严格校验接受要合并后看。
- 响应头只保存“该资源最近一次”的响应头（动作拿不到运行 id），所以历史里打开旧的那次运行时“响应头”页签显示的是最新一次。想精确的话需要内核把运行 id 放进动作的 `ctx`。
- 摘要里的耗时用 `Date.now()` 在插件里量（含网络），与内核记的 `durationMs` 不同。

## 没验证
- 没有在真沙箱里跑：`host.network.request` 的返回形状 `{status, headers, body, truncated}`、`host.kinds.handle`、`migrate` 的签名都按计划文字假设。
- `e2e/round4.spec.ts` 第二阶段再写（本机 HTTP 测试服务器）。

## 第二阶段进度（协调会话 2026-11-16 记）

旧测试会话没有提交就停在运行中；协调会话把它工作树里未提交的修改原样带进了协调分支（提交“tests: 带入旧测试会话未提交的第二阶段进度”）：HTTP 插件清单的 `secrets: true`（D318）与相应的 `main.js`/语言文件/vitest 修改、`0.2.0` 夹具的 `upgradesFrom` 改成带逗号的写法（内核用 Rust `semver` 的范围语法，`">=0.1.0, <0.2.0"`；不带逗号被拒 `badUpgradesFrom`）、`e2e/kernel-host.ts`、`e2e/round3.spec.ts`、`e2e/round4.spec.ts`（约 2.3 万字节，**没跑过，状态不明**）。带入后 `pnpm exec vitest run plugins` 73 个通过。新测试会话从这里接着做：先跑一遍 `round4.spec.ts` 看哪些过、哪些没写。

## 第二阶段结果（协调会话 2026-11-16）

新测试会话没能自动开起来，协调会话自己把草稿跑通：`E2E_PORT=1437 pnpm exec playwright test e2e/round4.spec.ts` **13 个全部通过**，没有 `test.fixme`。
- 草稿第一遍 9 过 1 败 2 未跑。失败的是“重定向到另一台服务器时不带密钥头”：按 D317 重定向到别的端口整个被拒，用例已过时，改写为“重定向到别的端口被拒、第二台服务器什么都没收到、审计原因 `hostNotAllowed`”。D316（跳到**已授权**的别的主机时丢掉密钥头）界面上到不了（`fromResources` 的一条资源只授权一个主机:端口），只有内核测试覆盖。
- 新增一个用例：同一主机换端口被拒（D317）；草稿里新写、已保存资源里没有的密钥名被拒（`secretNotAllowed`，D318）。
- 没覆盖：真钥匙串、https、桌面窗口。其余 e2e（`workbench`、`week1`、`round2`、`round3`）由完整 `pnpm check` 跑。
