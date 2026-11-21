# 第十七轮 · 测试会话 · 第一阶段完成

## 1. 假 `ssh` / `scp` / `docker`

文件：`e2e/fake-tools.ts`（API）、`e2e/fake-tools/fake-tool.sh`（脚本本体）、`e2e/fake-tools.spec.ts`（证明内核真的在跑假的）。

### 为什么不能“放到 PATH 最前面”
内核（`process.rs` 的 `locate`）对 `source: "system"` 的程序**只看固定位置**（`/usr/bin` 在前，从不读 PATH）；`searchPaths` 只在固定位置都没有时才试。本机 `/usr/bin/ssh` 存在，所以真的永远赢。
内核允许的替换路径：`source: "plugin"` 的程序先找 `<数据目录>/workspaces/default/plugin-data/<插件id>/bin/<名字>`。另外宿主复制内置包时逐文件写、会丢可执行位，所以假程序必须放在 plugin-data 里，不能放在包里。

### 用法
```ts
import { FakeTools } from "./fake-tools";
const fake = new FakeTools(path.join(base, "fake"), pgBinOrNull);   // pgBinOrNull：临时 PostgreSQL 的 bin 目录（给 exec 模式的 PATH）
const plugins = fake.preparePlugins(path.join(ROOT, "plugins"), path.join(base, "plugins"), path.join(base, "data"));
host = await startHost(path.join(base, "data"), {}, plugins);        // startHost 新增第三个参数 pluginsDir
fake.rule("ssh", { match: "pg_dump", mode: "exec", env: { PGPASSWORD: "..." } });
fake.rule("ssh", { steps: [{ out: "a" }, { sleep: 1 }, { err: "b" }], code: 3 });
fake.rule("docker", { match: "^ps", steps: [{ out: "onedesk-pg" }] });
fake.calls("ssh")   // [{ tool, args: string[] }, ...] 按调用顺序
fake.reset()        // 清规则和记录
```
- `preparePlugins` 把 plugins 复制到临时目录（不含 ssh/scp/docker 声明的插件只做符号链接），把其中声明了 `ssh`/`scp`/`docker` 的程序改成 `source: "plugin"`（`path` 仍写 `bin/<名字>`，清单校验要有，实际文件不在包里），并把假程序装进 plugin-data。**仓库里的清单不动。** 只对“清单里声明了这些名字”的插件生效，所以新插件（command、datasource 的备份）合并后自动生效。
- 规则按添加顺序试，第一条 `match`（扩展正则，对“参数用单个空格连接”的字符串）命中的生效；没有命中 → 退出码 127 并在 stderr 说明（测试不会误连真的）。
- 模式：`script`（默认：steps 输出 + 退出码；steps 里可 `sleep`，用来测边运行边显示、超时、取消）；`exec`（ssh：把远端命令交给本机 `sh -c`，工作目录 `fake/remote-home`，PATH = 临时 PG 的 bin + /usr/bin:/bin，所以 `pg_dump` 能连临时 PostgreSQL；`env` 可给 `PGPASSWORD` 等）；`scp`（`host:路径` 解析到 remote-home）；`docker-cp` / `docker-exec`（容器内路径映射到 `fake/container-fs`，命令在本机运行）。
- ssh 参数解析：跳过带值的选项（`-o -p -i -F -l -J …`），第一个非选项词是主机，之后（可带 `--`）连成命令。

### 已验证
`e2e/fake-tools.spec.ts`：数据源插件“经 ssh”模式测试连接，跑的是假 ssh（记录了含主机名和 `docker` 的参数，错误输出显示在结果区）。脚本本身也直接测过 script/exec 模式和调用记录。

### 限制
- `docker-exec`/`docker-cp`/`scp` 模式按常见参数写，**还没碰过 r17-ops 的真实调用**；第二阶段按实际参数调整。
- 命令里写在 stdin 的内容不被记录（只记参数）。
- 假程序只在“清单声明了 ssh/scp/docker”的插件里生效；`pg_dump` 等不被替换（exec 模式下由 PATH 找到真的、连临时 PG）。
- 本机 worktree 没有 `target/`：跑 e2e 要 `ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost`。

## 2. `scripts/check-arch.mjs`
内核侧禁用词（整词）加了 `bash`、`pg_dump`、`pg_restore`、`disk-file`（`ssh`、`docker` 原本就在）。现有源码零命中，`pnpm lint` 通过；放一个含 `disk-file` 的临时文件确认会报错（已删）。`connection`（计划里提到）太常见（连接、WebSocket connection），没有加成整词禁用——需要的话请协调会话定一个更窄的写法。

## 3. 检查
`pnpm test`（767 通过）、`pnpm lint`、`pnpm typecheck` 通过。

## 范围外
无。

最后提交号：见本文件所在提交（`git log -1 -- docs/handoff/round17-tests-done.md`）。

---

# 第二阶段：`e2e/round17.spec.ts`

连真内核（devhost）、假 ssh/scp/docker、临时 PostgreSQL、临时废纸篓（`ONEDESK_TRASH_DIR`）、打开日志（`ONEDESK_OPEN_LOG`，要同时设 `ONEDESK_TEST_HOOKS=1`）、本机 HTTP 服务。**整份 `round17.spec.ts` 和 `round16.spec.ts` 各跑两次，全部通过**（round17：41 通过、2 个 `test.fixme`；round16：25 通过）。`round16.spec.ts` 里“已保留结果”与“最近运行”的顺序已按 D431 改成新顺序。

跑法：worktree 没有 `target/`，用 `ONEDESK_DEVHOST_BIN=/Users/chloe/onedesk/repo/target/debug/onedesk-devhost pnpm exec playwright test e2e/round17.spec.ts`。夹具额外增加：`FakeTools.remoteDockerShim()`（ssh 的 exec 模式下 `docker exec <容器> …` 变成本机命令）、docker-exec 里把 `/tmp/onedesk-*` 映射进假容器目录。

## 逐行结果

| 行 | 结果 | 怎么验证（测试名里的编号） |
|---|---|---|
| I1 | 通过 | 保存命令、`:name` 参数，经假 ssh 运行（I1/I3/I4） |
| I2 | 通过 | 6 种恶意值（引号、`$()`、反引号、分号、换行）原样作为一个词到达，注入文件从未出现 |
| I3 | 通过 | 主机名以 `-o…` 开头在 ssh 启动前被拒（假 ssh 零调用）；`--` 在主机之前 |
| I4 | 通过 | 参数含 `BatchMode=yes`；255 → 运行失败并带 ssh 的话；命令自己退出码 3 不算失败 |
| I5 | 通过 | 流/行表、导出 csv、保留后在“已保留结果”、历史；超时和行数上限保留已有行；取消 8 秒内结束 |
| I6 | 通过（页面）/ **不通过（运行中）** | 最终输出：深色底、stderr 另一种颜色（页面检查 + 截图 `round17-terminal.png`）。运行中逐行显示 → 缺陷 A |
| I7 | 通过 | `PASSWORD=`、`TOKEN:`、`Authorization: Bearer` 打码，普通变量不打码 |
| I8 | 通过 | 本机 bash 脚本：参数当数据、stderr 独立、超时、行数上限 |
| I9 | 通过 | 导出 `.sh`；没有授权的文件夹什么都不写 |
| J1 | 通过 | 假 ssh 在本机 shell 里跑 `pg_dump` 连临时 PostgreSQL；调用顺序 docker(查库) → ssh(dump) → docker cp → createdb → pg_restore → rm；新库有 4 行；新直连数据源资源已建；每一步失败即停并说明 |
| J2 | 通过 | 清单：`docker` 是系统程序，`searchPaths` 含 Docker.app、OrbStack（不读 PATH）。真的“找不到 docker”没有测（会碰真路径） |
| J3 | 通过 | 8 种坏名字/容器/端口/用户在任何程序启动前被拒；库已存在 → 第 1 步停，ssh 零调用，不出现 drop/clean/create，已有库的数据不变 |
| J4 | 通过 | 转储在 `plugin-data/org.onedesk.datasource/backups/`，以 `PGDMP` 开头 |
| L1、L3、L4 | 通过（截图） | 真内核下的页面截图 `round17-*.png`；其余沿用外壳 vitest 与 `workbench.spec.ts` 的基准 |
| L2、L5、L6、L9、L10 | 外壳 vitest 通过；**本轮没有新增真内核 e2e** | 外壳会话的 `round17-layout.test.tsx`；`workbench.spec.ts`（假数据）里有分割线记忆、展开全部。如要求真内核逐条，需后续补 |
| L7 | 通过 | `search.query`：3 字符以上命中、2 字符按顺序模糊（`qb` 找到 Quarterly budget）、多词必须全中、无匹配为空 |
| L8 | 通过 | 收藏在收藏树里、搜索结果排在前面（资源树本身不重排——按需求理解为搜索与收藏树）；标签可改并能被搜到 |
| I.10b | 通过 | 授权文件夹增/查/改（replaceFolder）/移除，各写审计，移除后资源和文件都在；导入登记 path/size/modified/ext，重复导入不增加，文件没了标失效、回来恢复；分组 |
| I.10b-2 | 通过 | 新建文件夹/文件、重命名（非法名被拒）、移动、复制；授权外被拒；同名三选一（协议与页面各走一遍：覆盖、跳过、保留两份、取消）；永久删除先问且“不可撤销”，取消不删；移到废纸篓进临时目录；打开/在 Finder 中显示写进日志；按文件名搜索；节点页按钮；`.command` 被拒且不进日志；只改大小写的改名成功不弹框；授权根不能改名/移动 |
| I.10h | 通过 | Bearer、Basic（base64(用户名:密钥)）、自定义头、查询参数，本机服务看到的头/查询；路径不能换主机；密钥不在资源、审计、运行、数据目录；每次调用进审计；HTTP 请求插件选连接；分组与搜索 |

## 缺陷（别人的文件，用 `test.fixme` 标出，没有改）

- **A（外壳 `result-area.tsx`）**：内核确实发 `Run.partial`（协议用例通过），但运行中命令的页面只显示“Running on web-1…”，没有已出现的行。疑似页面持有的 run 来自任务列表（不带 `partial`），`run:<id>` 事件没有触发 `run.get`。用例：`I5/I6 (page): while the command runs…`。
- **B（`org.onedesk.command` 的 `runLines`）**：部分输出节流（`PARTIAL_EVERY_MS`）后没有“补发”：一阵连发的几行里，节流期内的行要等到下一行输出才会出现。`echo a; echo b; echo c; sleep 5` 时 b、c 5 秒内看不到。用例：`lines that arrive in a burst…`。
- **C（`org.onedesk.command`）**：超时和行数上限只读运行的 `input`（页面发的字段值），不读资源本身的 `body`；而主机、命令却两处都读。页面里点运行没问题，只用资源 id 运行（如被别的插件调用）时设置被忽略。
- **D（说明）**：同一时刻的 stdout 与 stderr 行在两根管道上，到达顺序不保证等于程序写出的顺序（截图里 `an-error` 排在 `first-line` 前）。按“流、行”表这是可接受的，但“终端样式”的使用者可能想要稳定顺序。
- **E（说明）**：文件树右键菜单没有“移到废纸篓”（只有永久删除）；废纸篓只在文件页按钮/资源动作里。需求写“删除默认进废纸篓”——若要求树菜单里的默认删除也是废纸篓，需要外壳/插件改。

## 其它
- `plugins/_testing/view-check.ts` 认识 X10 新字段（`lineTones`、`appearance`、`toneColumn`、`lineColumn`）和树节点的 `menu`、`draggable`、`accepts`。
- 中日译文：补全了外壳新键（含 `terminal.label`、`kernel.error.reason.unsafeOpen`、`kernel.error.denied.trashDenied`），`lang-check` 通过。
- 新截图：`docs/screenshots/round17-terminal.png`、`round17-folder-picker.png`、`round17-delete-permanently.png`。基准截图已还原（`git checkout -- docs/screenshots` 后只留这三张）。
- 假程序只在清单声明了 `ssh`/`scp`/`docker` 的插件里生效；e2e 从不碰真的 `~/.Trash`、真服务器、真容器。

---

# 缺陷修复后的复核（合并了集成分支的修复）

`round17.spec.ts` 跑两次都是 **44 通过、0 失败、0 fixme**；`round16.spec.ts` 两次都是 25 通过。缺陷 A、B 的两条 `test.fixme` 改回 `test` 并通过（A 的现象是 B 造成的，B 修了就好）；缺陷 C 已由运维会话修。
- I4 按 D435：命令非零退出 → 运行状态 error，输出保留，历史里有这次运行。
- 新增：文件树右键菜单有“移到废纸篓”和“永久删除”，移到废纸篓不弹确认，文件进了测试用的废纸篓目录。
- 说明 D（stdout/stderr 到达顺序）仍是说明，不是缺陷。
