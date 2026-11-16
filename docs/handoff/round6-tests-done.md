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

---

# 第二阶段：`e2e/round6.spec.ts` 连真内核

合并了协调分支（内核、外壳第六轮）后做的。devhost、worker 需先 `cargo build -p onedesk-host --bin onedesk-devhost` 和 `cargo build -p onedesk-worker`（`target/debug` 里没有 worker 时 devhost 起不来）。

## 结果（本会话实际运行）
- `E2E_PORT=1435 pnpm exec playwright test e2e/round6.spec.ts`：**14 通过，0 fixme**，约 1.4 分钟；跑完 `pgrep` 没有残留的标记 `sleep`（用例里还有最后一条“没有残留”和 afterAll 兜底清理）。
- `e2e/round5.spec.ts` 单独分段跑：去掉 `test.fixme` 后“永久删除确认写明被引用数”通过（那条用例结尾的断言原本错了：软删除的资源 `resource.get` 返回 null，改为先 `resource.undelete` 再查）；“添加已知参数”用例的名单加上 `process.allow`（内核新增）后通过。整个 round5 文件的 13 + 1 条在上面两次运行里都过了，**没有完整跑一遍 round5、round4、workbench.spec.ts 等其余 e2e**。
- 截图：`docs/screenshots/round6-{install-programs,install-more-programs,events-page,switch-failure,reference-field-label}.png`（只在跑过的用例里生成）。

## 用例（对应任务书逐项）
安装确认框的外部程序单独一段 + 程序名 + “from the plugin”、`bad-programs` 被拒（`badPrograms`）；echo（`;`、`$()` 原样）；hello + `{{secret:名}}`（输出 `***`；`run.get`、审计、数据目录里没有明文；只写在草稿里的密钥名被拒 `secretNotAllowed`）；退出码非 0 仍是成功的运行（stderr 排在后面并标出）；流式（运行中 `progress.message` 已有前几行）；取消后 `pgrep` 找不到子进程和孙进程；`fire` 动作（不等 `process.run`）运行结束后程序不在；未声明的程序 `undeclaredProgram`；`DYLD_INSERT_LIBRARIES` → `badEnv`；`process.allow` 名单外 `blockedByPolicy`、空名单全拒、环境层只影响带该环境的运行；事件（别的“标签页”〔协议里〕运行后页面“最近一次运行”自己更新、新建后“资源数”更新、未保存的输入不丢）；0.2.0 多一个程序（`cat`）：`addedPermissions` 含 `programs`，对话框标“New”；sample 0.3.0 自动升级失败：`switchFailure`、插件页提示、树节点 `switchFailed`；引用面板显示字段标签（`fieldLabel`，不显示 `body.args`）。

## 对第一阶段假设的核对结果
1. 事件处理函数 `(ctx, payload)`、`host.events.on`：对。
2. 流式输出 `ctx.progress(0, 文字块)`：对，`run.get().progress.message` 运行中就是最近一块。
3. `env` 的密钥：不需要在清单 `requires.secrets` 里声明，保存的资源里写了 `{{secret:名}}`（字段 `secrets: true`）就够；只在草稿里的被拒。
4. `Date`、可执行位（`fs::copy` 保留权限）：都对，hello 能直接运行。
5. 夹具改动：给 0.1.0 加了动作 `fire`（启动 `sleep` 不等待就返回，用来验证运行结束后无孤儿）、`args` 字段声明 `refs: true` 和 `label`（让引用面板有字段标签）；新增 `0.2.0`（同 0.1.0，多声明 `cat`）。`plugins/_testing/command-fixture.test.ts` 未改（仍过）。

## 与设计不一致 / 要留意的
- “升级多了程序要重新确认”：通过安装对话框安装时，安装本身就是确认（指纹是用户看到的那份），所以 0.2.0 装完就是 `confirmed: true` 并接管；“未确认”状态只在包被放进插件目录再 rescan 时出现，内核测试已覆盖，e2e 这边没有做。
- 已有资源绑定它创建时的版本：装了 0.2.0 之后，旧命令仍用 0.1.0 的程序清单（用 `cat` 要新建命令）。
- 测试里 `run.start` 必须把页面值放进 `input`。

## 发现的缺陷（不是我的范围，没改）
- `pnpm typecheck` 失败：`src/workbench/parts/round6.test.tsx(68)`，`fieldLabel?: {}` 不能赋给 `Label`（外壳会话的测试文件）。
- `pnpm test` 有 1 个失败：`src/workbench/i18n/kernel-texts.test.ts` “notices a new key in the kernel sources”——内核发出 `run.ended`（事件/主题名），`kernel-texts.ts` 和那条测试的名单里没有它（外壳会话）。
- 这两项在我合并的协调分支上就存在；`pnpm lint` 通过。

## 没验证的
没跑 `workbench.spec.ts`（假数据）、round2–4 的 e2e 和 `pnpm check` 全套；没做“未确认版本”的 e2e；`process.allow` 空名单用的是 `params.set` 值为空字符串（通过了，说明内核把它当空名单）。
