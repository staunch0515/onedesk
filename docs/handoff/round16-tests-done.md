# 第十六轮 插件与测试会话：第一阶段完成

## 测试数据库与浏览器

- 本机原来没有 PostgreSQL，也没有 Playwright 浏览器。经用户批准：`brew install postgresql@17`（只装程序，没启动服务；路径 `/opt/homebrew/opt/postgresql@17/bin`）、`pnpm exec playwright install chromium`（缓存在 `~/Library/Caches/ms-playwright`）。
- `e2e/pg-fixture.ts` 的 `findPgBin()` 现在按 `ONEDESK_E2E_PG_BIN`、`/Library/PostgreSQL`、Postgres.app、`/opt/homebrew/opt`、`/usr/local/opt` 找，取最新版本；找不到时导出 `PG_SKIP_REASON`（含安装办法）。`round15.spec.ts` 找不到时用它 `test.skip`（原先是断言失败）；设 `ONEDESK_E2E_REQUIRE_PG=1` 则变回失败。
- 测试里不再写死 “PostgreSQL 15”（现在是 17）。
- 用共享目录里的 devhost 跑 e2e：`ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost`（用 `CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target cargo build -p onedesk-host --bin onedesk-devhost` 构建）。
- 实际装的是 `postgresql@17`，路径 `/opt/homebrew/opt/postgresql@17/bin`（协调会话转达了用户“用 brew 装”的同意；没有 `brew services`，没有常驻库）。
- 验证：`round15.spec.ts` 20 条在真内核 + 临时 PostgreSQL 17 上全部通过（F5 就是 G3 的整条解析链）。

## G 组（对照 sqlpool-parity.md）

| 行 | 结论 | 验证方式 |
|---|---|---|
| G1 环境树：父子、继承、覆盖、说明 | 通过（内核已有，未改） | `e2e/round2.spec.ts` 既有；本轮 devhost 脚本里新建子环境并继承父环境的值 |
| G2 拖动改父子 | 通过（内核已有，未改） | 既有 round2/round13 测试；第二阶段 e2e 再覆盖 |
| G3 环境指定数据源，子环境继承 | **通过；按新需求补了一处** | ① devhost（`ONEDESK_SECRET_STORE=memory`、scratchpad 数据目录）上脚本：无任何来源 → “No data source”；设 `datasource.default`(ref) → 取默认；父环境设 `datasource`(ref)，用**子环境**运行 → 取到父环境的值（继承成立）；语句自己的最优先；删掉被引用的数据源 → 报找不到。② `round15.spec.ts` F5（真 PG，验证实际连到哪个库）通过。③ 补：引用的数据源被删后，错误原先只写一串 id；现在写明来自“环境”还是“工作区默认”（`error.sourceMissingEnv/Default`，英中日），`main.test.ts` 新增用例。环境页里“选数据源”的界面在 `r16-shell`（第二阶段再验） |
| G4 参数表标明来源层、新行自动出现 | 通过（外壳已有） | `round2`/`round14` e2e 既有；第二阶段再验 |
| G5 悬停显示整棵树取值 | 通过（外壳已有） | 同上 |
| G6 当前环境在标签页选择（按新需求） | 通过（按新需求） | 既有 e2e；`run.start` 的 `envId` 即标签页环境，G3 脚本用它 |
| G7 改名、删除 | 通过（内核已有） | 既有内核测试；第二阶段 e2e 再覆盖 |

G1/G2/G4/G5/G7 本阶段没有新改动，只复核了既有测试仍通过；第二阶段 `round16.spec.ts` 会逐行写进真内核 e2e。

## 其他

- `scripts/check-arch.mjs`：内核禁用词检查先去掉 `include_str!(…)`（迁移文件名）和 `rusqlite`、`SQLITE_*` 再匹配；已用临时文件验证“迁移文件名含 postgres 的 include_str! 通过、真正的 `"postgres"` 仍被拒”。
- `plugins/README.md`：新增“插件里的错误：文字怎样到界面”（不带宿主码才显示插件文字；被调插件的文字尚未带回；密钥）。
- `pnpm test`（72 文件 669 条）、`pnpm lint`、`pnpm typecheck` 通过。

## 范围外 / 给别人的

- `r16-kernel` 的“被调插件错误文字带回”合并后，数据源插件可以改回直接 throw（现在用 `{error}` 数据绕过）；那时 README 的第三条要改。
- 完整 `pnpm check` 里的 e2e 需要 `ONEDESK_DEVHOST_BIN` 或 `target/debug/onedesk-devhost`；各工作树没有自己的 target，协调会话跑时请设置。

最后提交：`75c049e`。


---

# 第二阶段（`e2e/round16.spec.ts`，合并 `claude/onedesk-coord-6` `ab5b1bc` 之后）

运行：`ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost ONEDESK_E2E_REQUIRE_PG=1 E2E_PORT=<空闲端口> pnpm exec playwright test e2e/round16.spec.ts`。真内核 + 临时 PostgreSQL 17；查询目录用临时目录里的 `.sql` 和 `mapping.yaml`；**15 条通过，7 条 `test.fixme`（别人的缺陷，下面）**。环境里先装过 Playwright 浏览器（用户批准）。

## SQL 插件 `create`（任务 1）

`org.onedesk.sql` 导出 `create`（清单 `exports.actions` + 动作，输出 `link`）：输入 `{ name, description, sql, source, params }`，新建 `query`（`body: {sql, source}`、`description`），`source` 可为 id 或名称，空 = 不指定，未知 → “was not found”；空 SQL → 报错。`params` 收下但不存（链接 `link` 输出没有带初始参数的字段，需要协调会话决定：给 `link` 加 `params`，或 SQL 插件把值写成声明里的默认值）。vitest 三条；真内核上 A10 通过（`saveAsSql` → 新的 SQL 资源，正文已代入映射、带 `-- @param min`，再运行成功）。

## 逐行结果

| 行 | 结果 | 验证 |
|---|---|---|
| A1 索引、启动时同步 | 通过 | 授权文件夹 → 重新索引 “4 queries indexed, 2 skipped”；外部键=路径；“activation” 用例：重启 devhost 后不按任何键目录就有内容 |
| A2 只读 | **部分**：页面没有绑定字段、类型不可新建（通过）；但页面不显示 SQL 且不是只读 → 缺陷 ① | `A2` 通过，`A2 (screen data)` fixme |
| A3 保留收藏/标签/名字 | 通过 | 改名+标签+收藏后改文件重新索引：说明和正文变了，名字、标签、收藏不变；资源 id 不变。运行历史的保留由内核 Rust 测试覆盖（目录条目本身现在跑不了，缺陷 ②） |
| A4 删文件后失效 | 通过 | 删文件 → 重新索引 “1 missing”；树和搜索里没有；`resource.get` 是 `broken/sourceMissing`；文件恢复后回来 |
| A5 无法解析的文件列原因 | 通过 | 索引报告页含 plain.sql（无头）、broken.sql（YAML 行号） |
| A6 `{{实体}}`/`{{实体.字段}}` | **不通过（缺陷 ②）**；补丁下通过 | 条目运行报 “Data source … does not exist”；打上补丁后发出的 SQL 是 `FROM orders`，行对 |
| A7 时间版本、截至时间 | **不通过（缺陷 ②）**；补丁下通过 | 补丁下：现在=[pen v2, cup]（已删除的不出现），`as_of=2026-01-10` = [pen, cup, old] |
| A8 检查警告 | 通过 | 页面含 undeclared、unused、未映射的名字 |
| A9 按 id 前两段分组 | 通过 | `sales › orders`、`sales`、`items`、`misc` |
| A10 另存为保存的 SQL | 通过（值不带到表单，见上） | 新 SQL 资源、正文、再运行 |
| E1 每查询最近 200 次、保留结果不受限 | 通过 | 一口气 206 次运行，最近运行 ≤200，保留的那条仍在 |
| E2 复用参数 | 通过 | `run.reuse` → `open resource:<id>`，`params.min` 是当时的值 |
| E3 最近运行 | 通过（数据层）；界面 | 两组节点；界面截图 `docs/screenshots/round16/saved-result.png`。点开“回到查询并带值”只验了命令，外壳点击没单独验 |
| E4 保留结果、名字 | 通过 | `run.setKept` 带名字，标签 `#n 名字`，退出“最近运行” |
| E5 打开、删除二次确认 | 通过 | `run.delete` 先给 confirm 效果，不删；带 confirmed 才删 |
| E6 保存结果在自己的标签页 | 通过 | 页面是 `runId` 的只读页、有行；界面截图有工具栏、数据源、SQL、行、重命名/取消保留/删除。已保留页的标题仍是资源名，保留名字只在树里（可改进，非缺陷） |
| G1 环境树、继承、覆盖 | 通过 | 三层环境：根的值被孙环境继承；覆盖生效；取消覆盖回到继承值 |
| G2 拖动换父 | 通过 | `tree.move … inside`，子环境继承的值随新父变 |
| G3 环境指定数据源，子环境继承 | 通过 | 默认→环境→子环境；`params.resolve` 的 `display` 是数据源名；被删后错误写明 “(from the environment)” |
| G4 来源层标注 | 通过（数据层） | `params.resolve.sourceName` 是来源环境名；表格界面外壳已有 |
| G5 悬停全树取值 | 未在本轮复测 | 外壳既有功能，round2/14 e2e 覆盖 |
| G6 标签页选环境 | 通过（按新需求） | 运行传 `envId` |
| G7 改名、删除 | 通过 | `tree.rename`；删除进“已删除”列表（没有二次确认，软删除可恢复） |
| H1 表树按前缀分组 | **不通过（缺陷 ③）** | tree.children 报 `denied/notInRun` |
| H2 一层/两层切换 | **不通过（缺陷 ③）** | 同上（工具栏命令本身在 `tree.list` 里） |
| H3 缺失表标记 | **不通过（缺陷 ③）** | 同上 |
| H4 表页、可勾选列取行 | **不通过（缺陷 ②③④）**；补丁下 “取行” 通过 | 页面 `page.resolve` 同样 `notInRun`；取行补丁下：不勾=全部 5 列，勾 `col.customer`=仅 customer |
| H5 五种版本查询 | **不通过（缺陷 ②④）**；补丁下通过 | 补丁下：current=[1,2]、history(key=1)=2 行、at(2026-01-10)=[1,2,3]、changes[1/20,3/1)=[1]、deleted=[3]；缺键/非版本表报错 |

## 别人的缺陷（我没改别人的文件；7 条 fixme 对应它们）

1. **内核 `pages.rs`（`page.resolve`）**：插件 `render` 返回的 `values` 和 `readOnly` 被忽略（`values` 只来自有 `bind` 的字段，`readOnly` 只来自类型）。查询目录条目的 SQL 框是空的，也不是只读；已保留的运行页同理。`catalog/main.js:949` 返回了 `values: {sql}`、`readOnly: true`。
2. **`org.onedesk.catalog` 与 `org.onedesk.table` 清单**：插件只有在自己某个动作的 `kinds` 里写了 `org.onedesk.datasource:source` 才能 `resources.list` 数据源（`manifest.rs foreign_kinds`）。两个清单都没有，`sourceList` 吞掉拒绝返回空，运行报 “Data source … does not exist”。补丁（只加一个无关动作用来声明）见 `docs/handoff/round16-probe-patches.diff`；更好的做法是内核给 `requires`/`depends` 声明一个读取权限，或这两个插件改用 `datasource` 提供的列表动作。
3. **内核 + 表插件**：提供树和页面（`children`/`path`/`render`）里没有运行，`host.actions.call` 一律 `denied/notInRun`，而表插件的树、页面都靠 `catalog:mapping` 动作取映射。需要内核允许树/页面处理函数调被调动作（只读），或表插件改读映射的另一条路径（例如文件直接读、或催内核“提供”）。
4. **内核 `runs.rs` ~403**：`node:` 目标的动作运行 ctx 没有 `node`（页面 ctx 有），表插件 `entityOfNode` 读 `ctx.node.key`，所有表动作报 “ is not in the mapping”。补丁：键取自 `ctx.target` 的最后一段。
5. 提醒：提供树节点的状态（H3 的“节点状态”）和同步后树的刷新（`round16-plugins-done.md` 里 2、3）本轮没有测，因为 H 树整个不通。

## 状态

- 新增：`e2e/round16.spec.ts`（22 条，15 通过、7 fixme）、`plugins/org.onedesk.sql` 的 `create`、`docs/screenshots/round16/saved-result.png`。
- `pnpm typecheck`、`pnpm lint` 通过；`pnpm test` 只剩 5 条失败：`lang-check`（4）与 `kernel-texts`（1），都是外壳新增的文字键尚无中日译文，等协调会话通知合并外壳提交后补。
- 最后提交：`ac24ad8`（译文提交另计）。

---

# 审查修正后的重跑（合并 `claude/onedesk-coord-6` `5c3dbca` 之后）

`e2e/round16.spec.ts`：25 条，**19 通过、6 `test.fixme`**；`pnpm test` 78 文件 756+ 条全过（中日译文已补：外壳新增 24 键 + `kernel.audit.workspace.opened`，`lang-check` 过）；`pnpm typecheck`、`pnpm lint` 过。

## 与之前相比变了的行

| 行 | 现在 | 说明 |
|---|---|---|
| A4 | 通过（按 D422 改） | 删文件后条目留在树里带失效标记；搜索里没有；`resource.get` 是 `broken/sourceMissing`；文件回来后恢复 |
| H1 | 通过（按 D421 改） | 没刷新前树里只有“尚未加载”节点（目标 `page:org.onedesk.table/overview`）；运行 `org.onedesk.table:refresh` 后出现 `item_*`、`no_*` 前缀组和 `orders`，`item_ver` 在组里 |
| H2 | 通过 | 工具栏有 `toggleDepth` 和 `refresh`，`refresh` 打开概览页；切换两次回到原样 |
| H3 | **不通过（缺陷 ⑤）** | 刷新后映射里有、库里没有的 `no_such_table` 仍是 `state: ok` 无徽标 |
| H4 页面 | 通过 | `page.resolve` 现在能出表页（说明、来源、列） |
| H4 取行、H5 | **仍不通过（缺陷 ④）**，fixme | `node:` 目标的动作 ctx 没有 `node`；打补丁后通过（`round16-probe-patches.diff`） |
| A6/A7 | **仍不通过（缺陷 ②）**，fixme | catalog 清单仍没有任何动作的 `kinds` 含数据源类型，列不出数据源 |
| A2（页面数据） | **仍不通过（缺陷 ①）**，fixme | `page.resolve` 仍忽略插件返回的 `values`/`readOnly` |
| A1 限制 | 符号链接循环：通过（12 个文件 + `loop -> .`，只索引一次）；**>5000 文件：不通过（缺陷 ⑥）**，fixme | 5100 个文件时工具栏命令 `pluginTimeout`，作为运行则沙箱异常 “Exception generated by quickjs: Null”，报告“Stopped at 5000 files”到不了 |

新缺陷：⑤ 表插件刷新后缺失表不标记；⑥ 目录 5100 文件时索引不能完成（超时/沙箱异常）。

## 审查里归我的

- #9（sql）：`E:param` 的字面量现在把反斜杠加倍（`\'` 结束不了字面量），名字以 e 结尾的 `name:p` 不算 E 字符串；vitest 2 条。
- #13：译文已补。
- #14：`plugins/README.md` 的被调方错误说明改为“`e.message`/`e.detail` 是被调方第一行文字（已抹密钥）”。
- #18 e2e：catalog、table 真内核流程已覆盖（见上）；符号链接循环通过，>5000 文件被缺陷 ⑥ 挡住；内核部分的 #18 不在我这里。

---

# D423 与最后一轮对齐（合并 coord-6 `2e37488` 之后）

- `org.onedesk.sql:create` 现在在 `link` 输出里带 `params`（只收文字值，空值略去；`plugins/_testing/view-check.ts` 的 link 键表加了 `params`）；vitest 对齐；e2e A10 检查运行结果里带 `"min":"20"`。
- 中日译文：合并后 `lang-check` 与 `kernel-texts` 都已通过（`pnpm test` 78 文件 762 条）。
- `round16.spec.ts` 25 条：19 通过、6 `test.fixme`（A2 页面数据、A6/A7、H3、H4 取行、H5、A1 >5000 文件）。H 组按 D421 写：先 `org.onedesk.table:refresh`（目标 `page:org.onedesk.table/overview`）再看树和表页。
- H3 缺陷改写：现在刷新后**有的表（`item_ver`）也被标为缺失**（之前是一个都不标）；疑似存在表查询的结果被读成空。H3 的 fixme 同时断言“缺失的 `no_such_table` 标缺失、现有的不标”。
- 等内核（#19 #20 #22）和插件（#21）修好合并的通知后，把对应 fixme 改回 test 重跑。

## 关于 Playwright chromium 的下载（如实记录）

本机没有 Playwright 浏览器。我第一次发现缺它时，自己用 AskUserQuestion 直接问了用户“可以运行 `pnpm exec playwright install chromium`（约 100–200 MB，来自 Playwright CDN）吗”，用户选了“Yes, download”，之后才下载（实际 100.1 MiB，装在 `~/Library/Caches/ms-playwright`）。PostgreSQL 的安装同样是我先问了用户（得到“Yes, install”）才执行 `brew install postgresql@17`；后来协调会话转达的“用 brew 装”是第二次说明，并非我执行安装的依据。协调会话在第二阶段的消息里写的“这次下载还没批”是在我已得到批准之后，所以不是它批的。

---

# 内核/插件修复合并后（coord-6 `c750e0f`/`192982a`）

`round16.spec.ts` 25 条：**23 通过、2 `test.fixme`**。原 fixme 里 A2 页面数据、A6/A7、H4 取行、H5 改回 `test` 并通过（页面用 `values`/`readOnly`；`node` 在动作 ctx 里；catalog/table 的数据源可读）。还挂着两个：**A1 >5000 文件**（缺陷 ⑥，5100 个文件时索引仍不能完成）和 **H3**：刷新后库里有的 `item_ver` 仍被标为缺失（缺陷 ⑤，已转插件会话）。sql `create` 带 `params` 的 link（D423）已做。Playwright chromium 的下载：我先问了用户并得到同意（见上一节）。

## Final rerun (after the plugin session fixed ⑤ and ⑥)

- `org.onedesk.datasource` `query` now takes `{ sql, inline: true, maxRows }` and returns the rows directly (via `runReadonly`, default 1000, at most 10,000), no data file; vitest added. This was the rest of defect ⑤ (the table plugin could not read "which tables exist").
- `e2e/round16.spec.ts`: the symlink-loop test and the >5000 test each use their own temp folder and data dir (`limitsHost(page, files, tag)`); no more `EEXIST`. H3 and A1 >5000 are plain `test` again.
- Result against the real kernel + PostgreSQL 17: 25 of 25 pass. Defects ⑤ and ⑥ are closed.
