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
