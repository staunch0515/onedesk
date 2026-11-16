# 第六轮 插件与测试 · 第一阶段完成记录

## 做了什么
- `e2e/fixtures/plugins/com.example.command/0.1.0/`：`manifest.json`、`main.js`、`locales/{en-US,zh-CN}.json`、`bin/hello.sh`（0755，打印参数和 `GREETING`）。
  - `requires.programs`：`echo`、`sleep`、`sh`（system）、`hello`（plugin，`bin/hello.sh`）；`contributes.events: ["resource.changed","run.ended"]`。
  - 类型 `command`（body：`program` 枚举、`args` 每行一个、`env` 每行 `名=值`，`fields.env = {type: longtext, secrets: true}`）；动作 `run`；页面 `editor`（顶部两行：最近一次运行、命令数）。
  - `run`：`host.process.run({program,args,env,onOutput})`，`onOutput` 里 `ctx.progress(0, text)`；输出 = stdout + `--- stderr ---` + stderr；摘要 `exit <code> · <ms> ms`（信号结束写信号名）；宿主错误不捕获，原样抛出。
  - 事件：`run.ended` → 存储 `lastRun = {status, at}`；`resource.changed` → `host.resources.list({kind:"command"})` 的个数写入 `count`。
- `e2e/fixtures/plugins/bad-programs/`：`echo` 为 `system` 却带 `path`，安装应以 `badPrograms` 被拒。
- `plugins/_testing/command-fixture.test.ts`：清单、locale 对齐、可执行位、参数/环境解析、摘要（退出码/信号）、流式进度、错误透传、两个事件、页面。

## 结果
`pnpm test`（34 文件 227 例）、`pnpm lint`、`pnpm typecheck` 均通过。JSON 已用 `python3 -m json.tool` 校验。

## 我做的假设（合并后对真内核核对）
1. 事件处理函数签名为 `handler(ctx, payload)`，`ctx.host` 与页面事件同；`host.events.on` 在 `activate` 里调用。
2. `ctx.progress(fraction, message)`：流式输出用 `progress(0, 文字块)`，是否需要别的形式要看外壳/内核实际如何显示。
3. 页面 `usesEnv: false`；`program` 枚举的 `options` 直接写在视图里（类型字段声明里没写 `fields.program`）。
4. `requires` 里没写 `secrets`；若 `env` 里 `{{secret:名}}` 要求清单声明密钥名，则需补。
5. `at` 用 `new Date().toISOString()`，耗时用 `Date.now()`；沙箱里 `Date` 是否可用未验证。
6. `bin/hello.sh` 的可执行位靠 git 保存（100755）；复制/安装时是否保留未验证。`bad-programs` 的 id 为 `com.example.bad-programs`，只有 `en-US`。

## 没验证的
没有在真内核/真沙箱里跑过（本阶段只用假 host）；`e2e/round6.spec.ts` 按任务书留到第二阶段。
