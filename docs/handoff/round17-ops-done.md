# 第十七轮：运维插件（r17-ops）完成情况

分支 `claude/r17-ops-a1b548`。插件提交 `5dea204`（三块功能）、`24089dc`（改用内核公布的按行输出 X17）；本文件在其后单独提交。
只改了 `plugins/org.onedesk.command/**`（新）、`plugins/org.onedesk.script/**`（新）、`plugins/org.onedesk.datasource/**`。

检查：`pnpm test`（80 个文件 827 条）、`pnpm lint`、`pnpm typecheck` 全部通过。三个清单另用内核自己的 `manifest::load_package_opts` 加载过（临时程序，未入库），都被接受。
**没有**在真沙箱里跑过：内核的 X10/X17/X18 在 `claude/r17-kernel-6cb08c`，还没合到这里。合并后需要 e2e 验一遍（见第 4 节给测试会话的说明）。测试只用假 host，不连任何服务器或容器。

## 1. 逐行结果

| # | 结果 | 怎么做的 | 怎么验证 |
|---|---|---|---|
| I1 | 通过 | 类型 `org.onedesk.command:command`，放在资源树（`draggable`），分组用框架的文件夹（B2）；页面：服务器、超时、行数上限、参数条、命令编辑器；`:name` 参数，可用 `# @param NAME [type=number\|enum] [required] [max=N] [values=a\|b] [-- 说明]` 声明；没填的值取环境变量（同 SQL 插件） | `command/main.test.ts`“page”“parameters”组 |
| I2 | 通过 | 值一律写成单引号词（`'` 写成 `'\''`），任何值都是一个词，不展开；只有 shell 不加引号读的地方才算参数——`'…'`、`"…"`、`\:`、`#` 注释、here-document 正文里不算（`"…"`和 here-doc 里 shell 仍会展开 `$(…)`，所以值不放进去）；`user:group`、URL、路径里的 `:x`、`${x:-y}`、`::` 也不算。命令经 ssh 的 stdin 交给远端 `bash -s`，远端登录 shell 不再解析一遍 | 18 种恶意值逐个“加引号再按 sh 规则读回”等于原值；渲染结果逐字比对 |
| I3 | 通过 | 资源字段 `body.host`：ssh 别名或 `user@host`，只许 `A-Za-z0-9._@:-`、不以 `-` 开头（防 `-oProxyCommand=`）；参数前还有 `--` | `safeHost` 测试、坏主机名在 ssh 启动前就拒绝 |
| I4 | 通过 | 清单声明系统程序 `ssh`；`ssh -T -o BatchMode=yes -o ConnectTimeout=10 -- <host> "bash -s"`，用 `~/.ssh/config`、密钥和 agent，不问密码；255（ssh 自己失败，且 stdout 没有内容）→ 运行失败并带 ssh 的话 | `sshSpec` 精确比对；255 / 找不到 ssh / 取消 三种测试 |
| I5 | 通过 | 输出是表 `stream`、`line` 两列（内置表格：导出、保留、历史都是框架的）；超时和行数上限时保留已有的行，摘要写明“N 行 · 退出码/超时/行数上限”；非零退出码不算失败，只写进摘要；另有“发出的命令”结果页（从运行快照重建，已打码） | “running”组 |
| I6 | 通过（按内核协议） | 表输出带 `appearance: "terminal"`、`toneColumn: "stream"`、`lineColumn: "line"`（X10），stderr 行按 `stderr` 语气上色由外壳做；运行中用 `ctx.host.runs.partial(…)` 推已有的行（至多每 300 ms 一次） | 输出键逐个比对；partial 测试（含节流） |
| I7 | 通过 | 每行打码后才离开插件（结果、部分输出、“发出的命令”）：名字含 `password/passwd/pass/pwd/secret/token/api_key/access_key/private_key/credential(s)` 的 `NAME=值`、`NAME: 值`、`"name": "值"`、`--name=值`；`Authorization: Bearer x`；URL 里的 `user:密码@`。值换成 `***`（保留引号）。终端颜色码先去掉 | 10 条应打码、7 条不应打码的样例 |
| I8 | 通过 | 新插件 `org.onedesk.script`，类型 `script`：系统 `bash --noprofile --norc -s`，脚本走 stdin；`:name` 参数、超时（1–600 秒，默认 60）、行数上限（1–10000，默认 5000）；输出、打码、终端样式同 I5–I7（两个插件里的 shell 辅助代码逐字相同，有测试比对） | `script/main.test.ts` |
| I9 | 通过 | 动作 `exportAll`（页面按钮“全部导出为 .sh”）：页面参数选一个授权文件夹（只有一个时直接用），所有脚本写成 `<名称>.sh`；文件名只留字母数字和 `._-`，不会是隐藏文件、不会出文件夹，忽略大小写去重（`-2`）；没有 `#!` 的加 `#!/usr/bin/env bash`；结果是“脚本、文件”表 | 写入路径与内容逐个比对；无授权/多个未选/已撤销/没有脚本 都在写之前停下 |
| J1 | 通过 | 数据源动作 `backup`（ssh 数据源的页面上多一组参数：本机新库名、本机容器、端口、用户）。六步，每步 `ctx.progress(i/6, "第 i/6 步：…")`：① `process.ready("docker")`、本机容器里查库是否存在 ② 服务器上 `docker exec <容器> pg_dump -Fc` 经 `transfer.capture` 直接写进备份文件夹（带已下载字节数） ③ `docker cp` 进本机容器 ④ `createdb` ⑤ `pg_restore --no-owner --no-acl` ⑥ 新建直连数据源（localhost:端口），结果是它的链接。任一步失败即停，并说明停在哪一步；容器里的临时副本无论成败都删掉 | “backup to this Mac”组：成功时调用顺序与进度文字逐条比对；每一步失败各一条测试，确认后面的步骤都没发生 |
| J2 | 通过（插件侧） | 清单 `docker` 为系统程序，`searchPaths` 加 `/Applications/Docker.app/Contents/Resources/bin`、`/Applications/OrbStack.app/Contents/MacOS/xbin`（`/usr/local/bin`、`/opt/homebrew/bin` 内核本来就查）；找不到时说明原因 | 清单测试；内核加载清单通过 |
| J3 | 通过 | 新库名只许 `^[a-z_][a-z0-9_]{0,62}$`，容器名、端口、用户都校验；**库已存在 → 第 1 步就停，服务器还没碰**；中途出现同名库时 `createdb` 自己拒绝，也停；从不发 `dropdb`、`DROP`、`--clean`、`--create`，dump 文件 `overwrite: false` | 名字测试；“exists”“createdb refusing”测试；全部调用里搜不到这些词 |
| J4 | 通过 | 转储存在插件自己的目录 `plugin-data/org.onedesk.datasource/backups/<库>-<UTC 时间>.dump`（先 `files.mkdir("backups")`，已存在 `conflict/exists` 视为正常）；摘要给出路径和大小；pg_dump 失败时说明已收到的部分留在哪个文件 | capture 参数与摘要比对 |

## 2. 用到的内核名字（都已与 `round17-protocol.md` 对齐）

- X10：表输出的 `appearance`、`toneColumn`、`lineColumn`。
- X17：`process.run({ lines: true, maxLines, onOutput })`，结果的 `lines`、`stopped`（`timeout`/`maxLines`）；`ctx.host.runs.partial(output)`（插件里先判断它存在，旧内核下照常运行只是没有部分输出）。
- X18：`files.mkdir(path)`、`conflict/exists`。
- 已有：`process.ready`、`transfer.capture`（`onProgress` 的 `{ bytes }`、结果的 `path`/`bytes`）、`files.roots`、`files.writeText`、`resources.create/list`。

没有新依赖。

## 3. 发现内核缺的（没有在插件里绕过）

1. **`searchPaths` 不能写 `~`**：Docker Desktop 的用户安装方式把 docker 放在 `~/.docker/bin`（Rancher Desktop 是 `~/.rd/bin`），清单里声明不了。建议内核接受以 `~/` 开头的搜索路径（展开为当前用户的家目录）。
2. **单个程序最长 10 分钟**（`process.run` 的 `MAX_TIMEOUT_MS`）：大库的 `pg_restore`、`docker cp` 可能超过。`transfer.capture` 是 1 小时，所以下载没问题。建议给 `process.run` 也开到 1 小时（或按清单声明）。
3. **`files.writeText` 不能设可执行位**：导出的 `.sh` 是 0644，要 `chmod +x` 才能直接运行。建议 `writeText(path, text, { mode })` 或 `files.chmod`。
4. **`files.writeText` 没有同名处理**：导出会直接替换同名文件（页面提示里写明了）。X18 的 `copy/move` 已有 `conflict`，建议 `writeText` 也收 `{ conflict: "fail" | "overwrite" | "keepBoth" }`。
5. `plugins/_testing/view-check.ts` 的 `OUTPUT_KEYS`、`NODE_KEYS`、语气列表还不认识 X10 的新字段，所以这两个插件的测试里用自己列的键检查输出（属于测试会话的文件，没改）。

## 4. 给测试会话（e2e 假程序）的说明

- 假 `ssh`（服务器命令）：参数 `-T -o BatchMode=yes -o ConnectTimeout=10 -- <host> bash -s`，命令在 **stdin**；按脚本输出 stdout/stderr 的行和退出码（255 = 连不上）。
- 假 `ssh`（备份第 2 步，经 `transfer.capture`）：参数 `-T -o BatchMode=yes -o ConnectTimeout=10 <host> "docker exec <容器> pg_dump -Fc --no-password -U <用户> -d <库>"`，stdout 是转储内容（任意字节即可）。
- 假 `docker`（本机）：`exec <容器> psql -X -q -tA -U <用户> -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '<名>'"`（输出 `1` = 已存在）、`cp <文件> <容器>:/tmp/onedesk-restore-<时间>.dump`、`exec <容器> createdb -U <用户> <名>`、`exec <容器> pg_restore --no-owner --no-acl -U <用户> -d <名> <文件>`、`exec <容器> rm -f <文件>`。
- 假 `bash`：本机脚本是 `bash --noprofile --norc -s`，脚本在 stdin（也可以直接用系统 bash 跑无害脚本）。
- 导出 `.sh` 需要给 `org.onedesk.script` 授权一个临时目录。

## 5. 范围外 / 说明

- 服务器上用 `bash -s` 运行命令（不是登录 shell 的 `sh`），服务器需要有 bash；`"…"` 里的 `:name` 不是参数（为防注入），页面说明里写了“引号外的 :name 是参数”。
- 备份只支持 ssh 方式的数据源（“在服务器上 pg_dump”）；直连的数据源会提示需要 ssh。pg_dump 用的是服务器容器里的 pg_dump，本机容器的 PostgreSQL 版本须不低于服务器的（pg_restore 的限制），失败时会显示 pg_restore 的原话。
- `pg_restore` 只报“errors ignored on restore: N”时（常见于扩展属主）视为成功，并把这句写进摘要。
- pg_dump 中途失败时，已收到的部分文件留在备份文件夹里（摘要给路径），插件不删它。
- 清单不支持动作前确认（`confirm` 必须为 null），备份本身不改动任何已有的东西，所以没加确认。
