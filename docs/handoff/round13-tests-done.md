# 第十三轮 插件与测试会话交接（第一阶段）

分支 `claude/r13-tests-f02c69`。第二阶段（`e2e/round13.spec.ts`、中日译文）**未做**，等协调会话通知。

## 夹具 `e2e/fixtures/legacy-v1/`
- `0001_init.sql`：`git show bf8f6b0^:src-tauri/migrations/0001_init.sql` 的逐字拷贝。
- `build.mjs`：`node e2e/fixtures/legacy-v1/build.mjs <输出.db> [--http-base http://127.0.0.1:PORT]`；也可 `import { buildLegacyV1, EXPECTED, resources } from ...`。用 Node 22 自带 `node:sqlite`（无新依赖，会打一行 ExperimentalWarning）。已存在的文件不覆盖；路径落在 `~/Library/Application Support/onedesk*` 下直接拒绝。再加第一版迁移执行器建的 `schema_version`（一行，1）。
- 数据（固定，`EXPECTED` 导出计数）：8 条资源——网址×2（一个 `Work/Tools`）、笔记×2（`Work`、`Work/Tools/Deep`）、提示词×1（`Prompts/Writing`，带 `{{ name }}` 和 parameters）、HTTP 请求×2（`API`，POST `/echo`、GET `/health`，网址用 `--http-base`）、未知短类型 `sql-query`×1（`Work`，无插件认领）；分组路径 6 个（API、Prompts、Prompts/Writing、Work、Work/Tools、Work/Tools/Deep）；集合 2 条（`col-tag-web`：tag/web；`col-kind-note`：kind/note）；`plugin_storage` 2 条；`secret_names`：`api-token`、`github-pat`；`app_settings`：`language=zh-CN`、`theme=dark`、`windowBounds`（应被丢弃）；`plugins`：`org.onedesk.link` 启用、`org.onedesk.sample` 停用。
- 验证：`plugins/_testing/legacy-upgrade.test.ts` 的“fixture database”用它建库并核对计数、分组、转换。

## 第一版各类型字段与转换表（来源 git `e02ab2d^:src/plugins/*/index.ts`）
| 第一版 kind | 第一版正文 | 现在的插件 / kind | 转换 |
|---|---|---|---|
| `link` | `url`、`profile` | `org.onedesk.link:link` | 字段名不变；去首尾空白；非文字→空/转文字；其余键保留 |
| `note` | `content` | `org.onedesk.note:note` | `content`→`text`（已有 `text` 优先）；其余键保留 |
| `prompt` | `template`、`parameters[{name,label?,default?,required?}]` | `org.onedesk.prompt:prompt` | `template`→`text`，`{{ name }}`→`{{name}}`（新语法不容空格）；`parameters` 原样留在正文里（新插件不用，不丢数据；参数默认值新版没有对应） |
| `http-request` | `method`、`url`、`headers`、`body` | `org.onedesk.http:request` | 字段名不变；方法转大写，未知/缺失→GET；新增 `query:""`、`token:""` |
| 集合表 | `ruleType`(`tag`/`kind`)、`ruleValue` | `org.onedesk.collection:collection` | `tag`→`tags`；`kind`→`kinds`，短名转全名（link/note/prompt/http-request→`org.onedesk.http:request`/collection；不在表里或已含 `:` 的原样）；逗号分隔多个也支持；非法→无条件 |
坏数据（非对象正文、字段类型不对）一律转成空字段、不抛错，避免一条坏数据让整批认领回滚（D399）。

## 给内核会话/协调会话的问题（我自行决定、需对齐）
1. **HTTP 的短名对不上**：第一版 `http-request`，现在插件的 kind 叫 `request`（清单 `legacyKinds: ["http-request"]`）。我在插件里写的是 `host.kinds.handle("request", { upgrade })`。内核认领时应把资源改写为 `org.onedesk.http:request`（即插件自己唯一贡献的 kind；或“短名等于其贡献的 kind id 就用它，否则插件只有一个 kind 就用那个”），不能机械地拼成 `org.onedesk.http:http-request`。如果内核按 `<插件id>:<短名>` 机械拼，需要改内核或改插件的 kind id——请协调会话决定。集合的转换假设了 `org.onedesk.http:request`。
2. `upgrade` 只返回 `{ body }`，不返回 kind。
3. 集合 `legacyKinds: ["collection"]`：`upgrade` 登记在已有的 `host.kinds.handle("collection", …)` 里。

## 其它改动
- `e2e/fixtures/market/org.onedesk.note/0.1.0/main.js` 同步为内置笔记插件（`round7-fixtures` 要求逐字节一致）。

## 结果
- `pnpm test`（vitest 全部 65 个文件、630 条，含 lang-check、locale-check 与新增 `legacy-upgrade.test.ts`）、`pnpm lint`、`pnpm typecheck` 通过。
- 没跑：Rust 测试、clippy、Playwright（本阶段没改它们）；夹具与真内核/主进程的联调留第二阶段。
