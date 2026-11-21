# 第十六轮 插件与测试会话：第一阶段完成

## 测试数据库与浏览器

- 本机原来没有 PostgreSQL，也没有 Playwright 浏览器。经用户批准：`brew install postgresql@17`（只装程序，没启动服务；路径 `/opt/homebrew/opt/postgresql@17/bin`）、`pnpm exec playwright install chromium`（缓存在 `~/Library/Caches/ms-playwright`）。
- `e2e/pg-fixture.ts` 的 `findPgBin()` 现在按 `ONEDESK_E2E_PG_BIN`、`/Library/PostgreSQL`、Postgres.app、`/opt/homebrew/opt`、`/usr/local/opt` 找，取最新版本；找不到时导出 `PG_SKIP_REASON`（含安装办法）。`round15.spec.ts` 找不到时用它 `test.skip`（原先是断言失败）；设 `ONEDESK_E2E_REQUIRE_PG=1` 则变回失败。
- 测试里不再写死 “PostgreSQL 15”（现在是 17）。
- 用共享目录里的 devhost 跑 e2e：`ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost`（用 `CARGO_TARGET_DIR=/Users/chloe/onedesk/repo/target cargo build -p onedesk-host --bin onedesk-devhost` 构建）。
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
