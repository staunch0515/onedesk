# 插件开发、测试与发布流程（workflow）

本文说明在哪里写插件、怎么在本机跑起来、怎么测试、检查、打包、安装、发新版本和回退。规范本身见 [spec.md](spec.md)，验收清单见 [acceptance.md](acceptance.md)。

## 1. 准备环境

| 需要 | 版本 | 用途 |
|---|---|---|
| macOS | 11.3+ | 只支持 macOS |
| Node | 22（仓库 `.nvmrc`） | vitest、检查脚本 |
| pnpm | `package.json` 的 `packageManager` | 命令入口 |
| Rust stable | — | 只有要真实运行插件（devhost / 桌面应用）时需要 |

```bash
git clone <OneDesk 仓库> && cd onedesk/repo
pnpm setup          # 安装依赖（含 Playwright 的浏览器）
```

插件检查、打包和测试都依赖这个仓库里的脚本与测试辅助（`plugins/_testing/`），所以**即使是第三方插件，也在一份 OneDesk 仓库检出里运行这些命令**，插件目录可以在仓库外。

## 2. 插件放在哪里

| 插件 | 位置 |
|---|---|
| 随应用打包的内置插件（最小一组，由协调会话决定） | `plugins/<id>/` |
| 其他官方插件（本仓库开发、测试，不随应用打包，以包文件发布） | `plugins-external/<id>/` |
| 第三方插件 | 自己的文件夹，布局相同：`<任意路径>/<id>/` |

文件夹名必须等于清单的 `id`。布局见 spec.md §2。

新建骨架：在 Claude Code 里运行 `/new-plugin <插件 id> <kind id>`，默认生成到 `plugins-external/<id>/`；也可以照 spec.md §14 的示例手写。

## 3. 开发循环

1. 写 `manifest.json`，立即 `python3 -m json.tool manifest.json` 校验 JSON。
2. 写 `locales/en-US.json`、`locales/zh-CN.json`（同样校验），清单里用到的每个键都要有。
3. 写 `main.js`（只 import 包内文件），把纯逻辑写成导出的小函数，方便测试。
4. 写 `main.test.ts`（§4），跑测试：

   ```bash
   pnpm exec vitest run plugins-external/<id>     # 或 plugins/<id>
   ```

5. 跑 `pnpm plugin:check <插件目录>`（§5），全部通过再在真实应用里看。

## 4. 写测试

测试与源码同目录：`main.js` ↔ `main.test.ts`（多个源文件就各配一个）。测试用 vitest，**只用假宿主**：不连真实服务、不碰真实数据目录和钥匙串（D440）。

测试辅助在 `plugins/_testing/view-check.ts`（从 `plugins-external/<id>/` 引用写 `../../plugins/_testing/view-check`，从 `plugins/<id>/` 写 `../_testing/view-check`）：

| 辅助 | 用途 |
|---|---|
| `registry(plugin)` | 用假宿主跑 `activate`，返回注册的 `{ pages, actions, commands, trees, kinds }` |
| `t` | `ctx.t` 的替身：返回 `{ "en-US": key, "zh-CN": "zh:" + key }` |
| `checkView(view)` | 与内核同样严格地检查视图树，返回问题列表（空 = 合法） |
| `onlyKeys(obj, allowed)` | 检查返回值没有多余的键 |
| `RENDER_KEYS`、`EVENT_RESULT_KEYS`、`SAVE_KEYS`、`TREE_PAGE_KEYS`、`TREE_NODE_KEYS`、`CRUMB_KEYS` | 各种返回值允许的键 |
| `checkActionResult(res)` | 检查动作返回值的键和输出形状 |
| `hostError(code, params)` | 造一个宿主错误（带 `code`、`params`），用来测失败路径 |

其他：`plugins/_testing/fake-ai/` 和 `transfer-server.test.ts` 有本机假服务器（SSE/NDJSON、文件传输）的写法，需要测网络流程时照着在 `127.0.0.1` 起假服务器。

宿主用 `vi.fn` 做假对象，只放用到的方法，例如：

```ts
const host = { ui: { openExternal: vi.fn(async () => undefined) }, storage: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) } };
const ctx = { target: "resource:r1", locale: "en-US", host, t, resource: { id: "r1", body: {} } };
```

**必须覆盖**（acceptance.md 的“测试”一组逐条检查）：

- 注册的页面/动作/命令/树与清单声明一一对应。
- 每个页面的 `render`：`checkView(out.view)` 为空、`onlyKeys(out, RENDER_KEYS)` 为空；各种状态（空、有数据、出错、未配置、运行结果页只读）各一例。
- 每个 `onEvent` 事件：返回值只含 `changes`/`params`/`message`；未知事件抛错。
- 每个动作：成功一例（`checkActionResult` 为空，输出类型与清单一致）、每种失败一例（输入不合法、宿主拒绝 `hostError("denied", …)` 的传递或改写）。
- 每个命令：返回的效果；目标不存在时的处理。
- 用到 `{占位}` 的文字：在非英语 `locale` 下替换正确。
- 语言文件：`en-US` 与其他语言键相同、`{占位}` 相同。
- 有 `migrate` 的：从每个 `upgradesFrom` 覆盖的旧 body 迁移一例，以及“不变”一例。
- 涉及密钥的：断言请求里只出现 `{{secret:…}}` 占位符，输出和错误文字里没有密钥。

## 5. 检查：`pnpm plugin:check <插件目录>`

```bash
pnpm plugin:check plugins-external/org.example.wordcount
pnpm plugin:check /Users/me/src/org.example.wordcount     # 仓库外的第三方插件
```

它检查（失败即非零退出）：

1. 布局：文件夹名等于 `id`；有 `manifest.json`、`main`、`locales/en-US.json`。
2. 清单：先做基本检查（id、版本、apiVersion、入口文件），再由**内核自己的严格校验**检查一遍——工具会构建并运行 `target/debug/onedesk-plugin check <目录>`（需要 Rust 工具链）。`onedesk-plugin check <文件.odplugin>` 也可以直接检查一个包文件。
3. 语言文件：`en-US` 必须有；其他语言与 `en-US` 键完全相同；清单用到的键都在 `en-US` 里。
4. 包里没有 CSS/SCSS/LESS、TSX/JSX、HTML；JS 里没有 `style`、`className`、`innerHTML`、写死的颜色或像素（`scripts/check-ui.mjs` 同款规则）。
5. 架构规则：只 import 包内文件；不用沙箱里没有的全局对象（`console`、`setTimeout`、`fetch`、`require`、`process`、`window`、`document`、`localStorage` …）（`scripts/check-arch.mjs` 同款规则）。
6. 跑该插件的 vitest 测试；没有任何测试文件即失败。`--skip-tests` 只跳过这一步（打包 CI 等测试已另跑的场合）。

官方插件还要过仓库级的 `pnpm check`（协调会话在合并前跑，作者不必自己跑整套）。

## 6. 在真实应用里运行

插件只在真实内核里才能看到完整行为（视图被外壳画出来、权限、网络、程序）。**开发时不要用正式数据目录**，用临时目录和内存钥匙串：

### 6.1 devhost + 浏览器（推荐）

```bash
cargo build -p onedesk-worker -p onedesk-host        # 或 pnpm devhost 的前半段
mkdir -p /tmp/od-dev/plugins-src && cp -R plugins-external/org.example.wordcount /tmp/od-dev/plugins-src/
ONEDESK_SECRET_STORE=memory target/debug/onedesk-devhost \
  --data-dir /tmp/od-dev/data --port 7801 --token dev --plugins /tmp/od-dev/plugins-src
# 另一个终端
pnpm dev
# 浏览器打开 http://localhost:1420/workbench.html?kernel=ws://127.0.0.1:7801&token=dev
```

- `--plugins <目录>` 里的每个 `<id>/` 被当作内置插件复制进数据目录并直接确认权限。想同时看内置插件，把 `plugins/` 下需要的也复制进去。
- 改了插件代码：重新复制到 `--plugins` 目录，再重启 devhost（启动时内容有变化的包会被重新复制进数据目录，版本号不变也会更新）。
- 必须设 `ONEDESK_SECRET_STORE=memory`，绝不碰真钥匙串；数据目录用临时目录，绝不用 `~/Library/Application Support/onedesk/`。
- 加 `&lang=zh-CN`、`&theme=dark` 检查中文与深色外观。

### 6.2 桌面应用

`pnpm start` 启动 Tauri 桌面应用，用的是**正式数据目录** `~/Library/Application Support/onedesk/`。只在装包验收（§8）时用；装进去的插件可以在插件页删除（移到 `plugins/.removed/`）。

### 6.3 `pnpm prototype`

纯假数据的浏览器原型，**不加载插件**，只作外观基准。插件开发用不上。

## 7. 打包：`pnpm plugin:pack <插件目录>`

```bash
pnpm plugin:pack plugins-external/org.example.wordcount
# → dist/plugins/org.example.wordcount-0.1.0.odplugin
```

`pnpm plugin:pack-all` 把 `plugins-external/` 下的每个插件都打包。`--out <目录>` 改输出位置。

先跑 `plugin:check`（不过就不打包），再把包写成 zip（条目排序、时间固定：同样的文件打出完全相同的字节，可以比对校验和）：`manifest.json` 在根目录；剔除 `*.test.*`、`._*`、`.DS_Store`；有符号链接或超过 200 MB 就失败。**不要手工 zip**。（应用也能装 Finder“压缩”出来的包：唯一的外层文件夹和 `__MACOSX`/`._*` 会被忽略；但文件名、测试文件、版本一致性都不会被检查。）

## 8. 安装

| 方式 | 做法 |
|---|---|
| 命令 | 应用里执行“安装插件…”（Install a plugin…），在系统对话框里选 `.odplugin` 文件 |
| 从文件夹 | “从文件夹安装插件…”（Install a plugin from a folder…），选一个解开的插件文件夹（开发时用） |
| 浏览器里（devhost） | 两个命令都显示路径框，填包文件或文件夹的绝对路径 |
| 插件市场 | 用户在市场里授权一个文件夹（“添加文件夹”），把 `.odplugin` 文件放在这个文件夹的**顶层**；市场按文件名列出，选中后点“安装”，同样弹出确认对话框（D461）。解开的插件文件夹也能列出 |

文件名形如 `<id>-<版本>.odplugin` 时，必须与包里清单的 id 和版本一致，否则拒绝（`nameMismatch`）。

安装时界面先显示插件的名字、版本和权限列表；用户确认后，主进程把包放进临时目录、再检查一遍，和确认时看到的 id、版本、权限指纹一致才放到 `plugins/<id>/<version>/`。同一版本已装过会被拒（`alreadyInstalled`）——内容改了必须升版本号。

装完检查：插件页里状态正常（不在“被拒”列表）；新建菜单里有你的类型；中英文、浅色/深色下页面都正常。

## 9. 发布新版本

1. 改代码，补测试。
2. 升 `version`（semver，见 spec.md §9）。
3. 设 `upgradesFrom`：能接管哪些旧版本的数据，如 `">=0.1.0 <0.3.0"`。body 结构变了就写 `migrate` 并测每个旧形状。不写 `upgradesFrom` 时旧资源留在旧版本上，不会被新版本处理。
4. 权限变了（`requires`、`uses`、外部 kind/页面）：在变更记录里写明，用户升级时要重新确认。
5. 在插件目录的 `CHANGELOG.md`（可选，但官方插件必须有）里写这个版本改了什么。
6. `pnpm plugin:check`，然后 `pnpm plugin:pack`。
7. 分发 `dist/plugins/<id>-<version>.odplugin`：官方插件按协调会话的安排放到发布位置；用户把文件放进市场授权的文件夹，或直接“安装插件…”。
8. 验证升级：在临时数据目录里先装旧版本、建几个资源，再装新版本，确认自动切换成功、资源被接管、`migrate` 结果正确、插件页没有“切换失败”。

## 10. 回退

- 插件页的版本表里可以把激活版本切回旧版本（会固定在那个版本，不再自动升级），或撤销某次升级批次（资源回到原版本）。
- 删除某个版本：插件页“删除版本”，文件移到数据目录 `plugins/.removed/<id>/<version>-<毫秒>`，不会真删；需要时可以把它当文件夹重新安装。
- 有启用的插件依赖某个版本时，删除或切换会被拒（`conflict/dependents`）。

## 11. 提交（官方插件）

- 一个文件同一时间只有一个写入者；会话间只通过 `docs/handoff/` 交流；范围外的问题记到 `docs/handoff/todo.md`。
- 提交信息：`plugin/<短名>: <做了什么>` + 空行 + 为什么。先 `pnpm plugin:check` 通过再提交。
- 需要新依赖、新清单字段、新宿主方法：不要自己加，写进 `docs/handoff/todo.md` 交给协调会话（规则 9、10）。
