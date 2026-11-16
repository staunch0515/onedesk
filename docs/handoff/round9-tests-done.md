# 第九轮 · 插件与测试 · 第一阶段 完成记录

分支 `claude/r9-tests-da6b88`。只改了 `plugins/**`、`e2e/fixtures/**`、本文件；没碰内核、外壳、真钥匙串和 `~/Library/Application Support/onedesk*`。第二阶段（`e2e/round9.spec.ts`）没写。

## 做了什么
1. **`com.example.transfer`**：`ctx.progress` 的第一个参数改为 `fractionOf(p)`：有 `total`（>0）时是 `bytes/total`（夹在 0..1），没有时是 `null`；文字不变。vitest（`plugins/_testing/round8-fixtures.test.ts`）加了断言：`[0.25, null]`。
2. **市场插件**（`plugins/org.onedesk.market`）：清单 JSON 读得出，但缺 `apiVersion`/`name`/`icon`/`main` 任一（内核 `Manifest` 里没有默认值的字段，加上原有的 `id`/`version`），标“不可用”，原因 `reason.incomplete`；按 `<id>/<版本>` 两层目录找到的包，清单的 `id`/`version` 与目录名不同，标“不可用”，原因 `reason.mismatch`。两种都不进“要安装的包”下拉。新文字中英都加了。只有一层目录（`<根>/<文件夹>/manifest.json`）的包不查目录名（文件夹名本来就没有约定）。
   - 为此改了原有测试里的假清单：补齐 `apiVersion/icon/main`，两层目录的包改用与清单一致的目录名；“非字符串的 name”那条改成字符串且无译文（非字符串的 `name` 现在直接算不可用）。新增一条测试覆盖三种情形。
3. **`com.example.keeper/0.1.0`**：按任务书。类型 `box`（字段 `text`）；页面 `editor`：一个表单、事件 `remember`/`recall`/`abuse`；动作 `stash`、`slow`（两次 `util.sleep(10000)`，共 20 秒——宿主 `MAX_SLEEP_MS` 是 10 秒，单次 20 秒会被截断）；提供树 `keeper`（页面 `tree`，一个节点，标签 `Keeper node (<ctx.locale>)`）；`requires.network.hosts = ["example.com"]`。`abuse` 用存下的 host 调 `network.request({method:"GET", url:"https://example.com/"})`，把错误的 `message` 原样返回（没存时返回 “No handle kept.”）。假 host 的 vitest 在 `plugins/_testing/round9-fixtures.test.ts`。
4. **`e2e/fixtures/make-many-plugins.mjs <目录> <个数>`**：写 `<id>/0.1.0/{manifest.json,main.js,locales/en-US.json}`，id 为 `com.example.many-00001`…；拒绝 `~/Library/Application Support/onedesk*` 及其内部；个数限 0..100000。同一个测试文件里用 20 个验证，且只在临时目录。

## 测试结果（实际跑过）
- `pnpm typecheck` 通过；`pnpm lint`（架构检查、界面规范）通过；`pnpm test`：41 个文件、350 条通过。
- 没跑 `pnpm check` 的 Rust/clippy/e2e 部分（本阶段不碰这些）。

## 我做的假设（合并后对着真内核核对）
- keeper 的 `manifest.json` 没有被真内核的清单校验加载过（没有 Rust 测试读 `e2e/fixtures/plugins`）：`trees` 里 `source: "provided"` + `page: "tree"`（页面 `tree` 的 `actions` 为空数组）、`pages` 里的事件动作没有 `action` 字段（照 sample 的 `tidy`），都可能被严格校验挑剔——第二阶段第一件事就是装一次看。
- （第一阶段的写法，第二阶段已改：真内核的错误 `message` 只是 `denied`，原因在 `params`，所以现在 `abuse` 返回 `<code>/<reason>`，如 `denied/staleContext`）`abuse` 返回的 `message` 用 `String(err.message)`：我假设宿主错误的 `message` 带 code/原因（假 host 里是 code）。真内核给的 `message` 若不含 `staleContext`，第二阶段的断言要改成看别的地方。
- `stash` 之后 `abuse` 用的是模块级变量；空闲回收会丢掉它（这是预期，回收后 `abuse` 返回 “No handle kept.”）。
- 市场插件的“必需字段”以当前内核 `Manifest` 为准（`apiVersion`、`name`、`icon`、`main`）；若内核再改，这里要跟着改。

## 没验证的
- 没在真内核/界面里跑任何一个新夹具，没生成 1 万个包测过耗时。
- 没有真跑过 `slow` 的 20 秒（假 host 只验证调了两次 10 秒）。

---

# 第二阶段：`e2e/round9.spec.ts`（连真内核）

合并了协调分支 `5e466b5`，用本工作树编的 `cargo build -p onedesk-worker -p onedesk-host`（debug）跑：`E2E_PORT=1435 pnpm exec playwright test e2e/round9.spec.ts`。devhost：内存钥匙串、临时数据目录、`ONEDESK_PLUGIN_IDLE_MS=2000`（`e2e/kernel-host.ts` 的 `startHost(dataDir, env?)` 加了可选的环境变量参数，密钥库那项仍然强制为内存）。

**结果（实际跑过）：14 条里 13 过、1 跳过（`test.fixme`）、0 失败。** 另跑 `pnpm lint`、`pnpm typecheck`、`pnpm test`（41 文件 352 例）通过。跑完已 `git checkout -- docs/screenshots`；新增的 6 张 `round9-*.png` 保留（未跟踪）。

| 覆盖（计划 §1） | 测试 |
|---|---|
| 启动后 `plugins/.index` 存在、条目与已装包逐项一致（含清单原文）；装 keeper 后多一条 | cache 1 |
| 删掉 `.index` 重启：重建、内容相同、插件照常；`.index` 写坏也重建 | cache 2 |
| 2000 个包，重启两次，`.index` 有 2000 条，抽查 3 个包 `loaded` | cache 3 |
| `remember` 后 `runtime` 变 `idle`，插件页显示“Not running; it starts automatically…”；`recall` 取回、`live`；之后又回到 `idle`；`idle` 不是停用 | idle 1 |
| `slow` 运行 7 秒（> 3 个空闲时长）每 0.5 秒取样都是 `live` | idle 2 |
| `stash` 结束后页面事件 `abuse` 被拒：`code: denied`、`params.reason: staleContext` | staleContext 1 |
| `stash` 后 `slow` 在跑时 `abuse` 仍被拒 | staleContext 2 |
| 切换语言后 keeper 提供树的节点名变（协议带 `locale` 与界面里切语言） | provided tree |
| 无总量的下载进度（`/slow`，分块、无 Content-Length）：`run.get` 的 `progress` 没有 `fraction`；状态栏和任务面板没有 `%` | progress |
| `outsideGrant` 的错误带 `path`，界面文字里看得到路径 | refused path |
| `network.allow` 拒绝带 `layerName`，界面文字里有“<层名>” | refused layer |
| 市场页：id 与目录不符、版本与目录不符、缺 `main` 的包显示“Unavailable”，下拉里只有可装的那一个 | market |
| **取消的下载在 `audit.list` 里是 `transfer.download` 且结果 `cancelled`** | **`test.fixme`，见下** |

## 2000 个包的启动时间（debug 构建，机器上还有别的会话在编译，负载高，数字只作参考）
“从启动 devhost 进程到 hello 答复并且 `tree.list` 答复”（`rpc` 先发 hello）：

- 多次运行的第一次启动（建 `.index`）：5.4 s、9.2 s、10.5 s；
- 第二次启动（读 `.index`）：2.4 s、3.7 s、6.7 s（同一台机器、不同负载下）。
- 断言只写了“第二次 < 60 s”和 `.index` 条数、抽查插件 `loaded`，没有把时间当严格门槛（负载太不稳）。每次运行会在输出里打一行 `ROUND9-TIMING`。

## 发现的缺陷（不改别人的文件，`test.fixme` 标出）
1. **内核：取消的下载审计结果是 `error`，不是 `cancelled`（D368 没做到）。** `run.cancel` 一个进行中的下载后，`audit.list` 里 `transfer.download` 一行 `result: "error"`，`detail: {"ms":207}`，对象是主机 `127.0.0.1`（在 `e2e/round9.spec.ts` 的 fixme 测试里复现）。看 `crates/kernel/src/carry.rs`：取消路径 `_ = &mut stop => return Err(denied("cancelled"))` 返回错误，被正常的“失败”审计记成 `error`；只有 `Unfinished` 的 drop 守卫才写 `cancelled`，而这次它没有起作用（或已被 disarm）。内核的 `round9.rs` 测试（直接调内核）测的可能是另一条路径（调用被丢弃）。修好后去掉 `test.fixme`。

## 另外的观察（不是缺陷，但要知道）
- 宿主错误到插件里是 `Error`，`message` 只是码（`denied`），原因在 `err.params`（`reason`）。所以 keeper 的 `abuse` 现在返回 `JSON.stringify({message, code, params})`（第一阶段是 `String(err.message)`，在真内核里看不到原因，已改）。
- `staleContext` 第二条测试在负载高时偶发：`stash` 与 `abuse` 之间若超过空闲时长且运行里没有别的调用，运行环境被释放，keeper 存的 host 随模块一起没了（`abuse` 回 “No handle kept.”）。这是预期（释放就是丢掉模块状态），测试里已改成：`slow` 在跑时（保证 `live`）发 `abuse`，没拿到就整段重来，最多 4 次。
- `/nolength/<n>` 太快，进度几乎看不到；“无百分比”的验证用 `/slow/20`（同样分块、无长度）。
- 只在 debug 构建上跑；没跑 1 万个包（单元测试和外壳的 Rust 测试里有）；没在 Tauri 窗口里验证（只有 devhost + 浏览器）。
- 截图 `docs/screenshots/round9-*.png` 我没有逐张看过画面，只靠断言（文字可见）。
