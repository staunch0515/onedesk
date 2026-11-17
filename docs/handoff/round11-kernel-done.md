# 第十一轮：内核交付（分支 `claude/r11-kernel-21a765`）

按 `round11-kernel.md` 的先后做完了全部三项（§3 语言插件；§4 `openExternal`、`text.format`、启动页；`legacyKinds`）。另外补了 §4 需要但内核此前没有的一块：**`page:<插件id>/<页面id>` 目标的解析**（见“我做的决定” 1）。

## 测试结果（实际跑过）

见文末“检查”。新测试：
- `crates/kernel/tests/round11.rs`（12 个，全部临时目录、生成的插件包）：语言顺序与同 `locale` 取 id 靠前者、停用/启用/移除/安装后的变化与 `languages` 主题、无关插件变化不发 `languages`、`i18n.shell` 的内容/未知语言/`en-US`/过大/嵌套/数组/数字值/坏 JSON 给空表、文件改了按现在的读、不激活插件（`activation_count() == 0`）、清单坏的语言插件不加载（`badLanguages`）、`ui.language` 在 `params.known`；`openExternal` 允许的三种协议、拒绝的协议与长度（2048 正好可以，2049 不行）、运行与页面事件里可以、渲染/命令/事件处理函数里 `denied/notInteractive`、`ui` 主题效果、审计只有主机名（成功和拒绝都是）；`text.format` 的 `plain`/`markdown` 通过、`html` → `pluginError`；`startupPages`（排序、随停用启用变化、`hello` 里也有）、独立页面解析（标题、图标、动作、运行项能跑；类型的页面/未知页面/格式不对 → `found: false`；停用 → `state: disabled`）；`legacyKinds` 进 `plugin.get`、坏的不加载（`badLegacyKinds`）。
- `manifest.rs` 单元测试 3 个：`contributes.languages` 的每种拒绝（含软链接逃出包）、`startup`（两个、类型的页面、树的页面、非布尔）、`legacyKinds` 的每种拒绝。
- `crates/protocol` 单元测试 1 个：`openExternal` 效果、`format`、`LanguageInfo`、旧 `WorkspaceInfo` 的线上形状。

## 清单新增部分（manifest v2，只增）

```jsonc
{
  "legacyKinds": ["link"],                 // 顶层；字符串数组，各项 [A-Za-z0-9._-]{1,64}，不重复，最多 64 项
  "contributes": {
    "languages": [                          // 最多 64 项
      { "locale": "zh-CN", "name": "简体中文", "shell": "shell/zh-CN.json" }
    ],
    "pages": [ { "id": "welcome", "startup": true } ]
  }
}
```
- `languages` 每项只能有 `locale`、`name`、`shell` 三个字段，都必填、都是字符串。`locale`：字母、数字、`-`，1–35 个字符，不以 `-` 开头或结尾、不含 `--`。`name`：非空白、最多 100 个字符。`shell`：以 `.json` 结尾、在包内（不是绝对路径、没有 `..`、软链接解开后仍在包内）、是已存在的文件。同一插件里 `locale` 不分大小写重复 → 拒绝。任何一条不对 → 清单不加载，原因 `badLanguages`。文件**内容**在加载时不检查（见下 `i18n.shell`）。
- `startup`：布尔，缺省 `false`。一个插件最多一个；该页面不能被本插件的任何类型（`kinds[].page`）或树（`trees[].page`）使用 → 否则 `badStartup`。
- `legacyKinds`：不对 → `badLegacyKinds`。只校验、保存、出现在 `plugin.get`；不接管（D383）。

## 协议只增的类型与字段（`crates/protocol`，已 `pnpm gen:types`）

| 名字 | 内容 |
|---|---|
| `method11::I18N_LANGUAGES` = `"i18n.languages"` | 无参数 → `LanguageInfo[]` |
| `method11::I18N_SHELL` = `"i18n.shell"` | `I18nShellParams { locale }` → `I18nShellResult { locale, texts: Record<string,string> }` |
| `topic11::LANGUAGES` = `"languages"` | 无载荷；`i18n.languages` 的结果变了时发 |
| `SHELL_LOCALE` = `"en-US"` | 外壳自带的语言 |
| `LanguageInfo` | `{ locale, name, plugin? }`（`en-US` 没有 `plugin`） |
| `TextFormat` | `"plain" \| "markdown"` |
| `ViewNode` 的 `text` | 只增 `format?: TextFormat`（缺省按 `plain`） |
| `CommandEffect` | 只增 `{ type: "openExternal", url }`（注意：其他效果的 `type` 是 kebab-case，这一个按计划定死的名字是 `openExternal`，用 `#[serde(rename)]` 固定） |
| `WorkspaceInfo` | 只增 `startupPages?: string[]`（内核总是给；`hello` 的 `workspace` 里也有） |
| `PluginDetail` | 只增 `legacyKinds?: string[]`（内核总是给；清单被拒的包给 `[]`） |

方法和主题常量不生成 TS（与前几轮一样，外壳按字符串写）。

## 宿主接口（确切签名）

```ts
ctx.host.ui.openExternal(url: string): Promise<null>
```
- 只在**运行**（`actions` 处理函数）和**页面事件**（`pages.onEvent`）里可用；渲染、事件订阅、`migrate`、树/子节点处理函数、命令处理函数 → `denied`，原因 `notInteractive`（与 `plugins.requestInstall` 同一规则、同一原因码）；`migrate` 里照旧先被 `denied/pureCall` 拦下。
- `url`：1–2048 个字符；协议只能是 `http`、`https`（必须有主机）、`mailto`（必须有地址）；其余 → `invalid`，原因 `badUrl`。`url` 不是字符串 → `invalidParams`。
- 成功：先写审计，再向调用的客户端发 `ui` 主题 `{ type: "openExternal", url }`（`url` 是解析后规范化的形式，例如主机名小写）。

## 新增错误原因码与审计操作名（全部）

- 清单拒绝原因：`badLanguages`、`badStartup`、`badLegacyKinds`。
- 宿主错误：`invalid/badUrl`（新）；`denied/notInteractive`（沿用）。
- 审计操作：`ui.openExternal`。成功：执行者 `plugin:<id>@<版本>`，对象 = 主机名（小写；`mailto:` 为 `@` 后的邮件域名，不含 `@` 前面的部分），摘要 `{ "scheme": "https" }`，结果 `ok`。被拒（`denied`）：沿用“拒绝也审计”的路径，对象同样只取主机名（之前那条路径会记下第一个参数原文，这里专门改成主机名）。`invalid/badUrl` 与以往一样不审计。
- 方法：`i18n.languages`、`i18n.shell`。主题：`languages`。

## 内核行为

- `i18n.languages`：第一项固定 `{ locale: "en-US", name: "English" }`；其后是**已启用**插件（活动版本）的 `contributes.languages`，按 `locale` 排序；同一 `locale`（不分大小写）由多个插件提供时取插件 id 靠前的；插件声明的 `en-US` 一律忽略（外壳自带的英语不被替换）。
- `i18n.shell { locale }`：按 `i18n.languages` 找到提供者（不分大小写），读包里的文件：大于 1 MB、不是 JSON 对象、值不全是字符串、读不出来 → 空表（并在标准错误输出一行原因），不报错——外壳按“没有这门语言的文字”回退英语。`en-US`、没有这门语言 → 空表。返回的 `locale` 是提供者写的那个（找不到时原样返回请求的）。每次都现读文件（不缓存）。读语言列表和文件都不激活插件。
- `languages` 主题：内核每次发 `plugins` 主题后重新计算语言列表，与上次发过的不同才发 `languages`（启用、停用、安装、移除、切换版本都会发 `plugins`，所以都覆盖到）。打开工作区时记下初始列表，不发。
- `ui.language`：第五轮起就在 `params.known` 里（类型 `text`、合并 `plain`、层 `config`），这轮只加了测试。值是否可用由外壳判断（内核不检查值）。
- `startupPages`：已启用插件、活动版本里 `startup: true` 的页面，`page:<插件id>/<页面id>`，按插件 id 排序。
- `text.format`：协议枚举，`render`/结果页签等返回的视图里出现别的值 → 照旧 `pluginError`（`badOutput`）。

## 我做的决定

1. **`page:` 目标此前内核不解析**（`parse_target` 不认、`page.resolve` 给 `found: false`），而启动页要靠它打开。按 kernel-design §9.1 补上：`page:<插件id>/<页面id>`（页面 id 里不能再有 `/`）。只认**独立页面**：本插件的类型和树都没用到的页面（与 `startup` 的条件一致，不要求声明了 `startup`）。解析：插件不存在或页面不是独立页面 → `found: false`；插件停用 → `state: disabled`、`read_only`；否则调用 `pages.<页面>.render(ctx)`，`ctx = { target, draft, locale, envId, params }`（没有 `resource`、`node`），标题/图标默认用插件名和插件图标，动作、结果页签、`recompute`、`usesEnv` 照页面声明。`page.event` 和页面里的运行项（`run.start` 用页面动作项 id）也支持这种目标；`page.save` → `notFound`（独立页面没有要保存的东西）。子节点处理函数里插件给出 `page:` 目标时，只保留自己插件的（与 `plugin:` 一样）。
2. `openExternal` 不能在命令处理函数里用：命令和树处理函数在内核里是同一种调用，分不开；与 `requestInstall` 保持一致。需要的话下一轮可以给命令单独标记。
3. 语言文件内容不在加载清单时检查（只查路径），而在 `i18n.shell` 时检查，坏了给空表：这样一个语言文件写坏不会让整个插件消失，外壳也不会因为一个错误码而显示键名。
4. `CommandEffect::OpenExternal` 的线上 `type` 是 `openExternal`（计划定死的名字），与其他效果的 kebab-case 不同。
5. 欢迎页“对应插件没启用时不显示那一项”：内核没有给渲染上下文加“哪些插件启用”的信息（计划说没有现成接口就全部显示）。

## 给外壳和插件会话的要点

- 外壳：`i18n.languages`、`i18n.shell`、`languages` 主题、`workspace.info.startupPages`、`ui` 主题效果 `{ type: "openExternal", url }`、`text` 节点的 `format`；打开启动页就是打开 `page:<插件id>/<页面id>` 目标（现在能解析了）。
- 插件：语言插件的 `main.js` 照现有校验仍必须存在且以 `.js` 结尾（可以是 `export default {};`）；`shell` 文件路径须以 `.json` 结尾；`legacyKinds` 写在清单顶层。

## 没做 / 没验证

- 没有跑外壳、e2e 和真实桌面里的打开浏览器（那是外壳和测试会话的事）。
- `pnpm check` 全套没跑（只跑了任务书列的内核检查和 `pnpm lint`）。
- 用真实的 `plugins/org.onedesk.lang.*` 包加载没有验证（插件会话在另一个分支上写，合并后由测试会话的 e2e 覆盖）。

## 检查（2026-11-18 实际运行）

- `cargo test -p onedesk-kernel -p onedesk-worker -p onedesk-protocol`：全部通过（内核单元 53、协议 140、各轮集成测试全过，`round11` 12 个）。
- `cargo clippy -p onedesk-kernel -p onedesk-worker -p onedesk-protocol --all-targets -- -D warnings`：无警告。
- `sh scripts/gen-types.sh --check`：协议类型是最新的。
- `node scripts/check-ui.mjs`：通过。
- **`node scripts/check-arch.mjs`（`pnpm lint` 的前半）：失败 1 处**——`crates/protocol/src/lib.rs` 的 `TextFormat::Markdown`。架构检查把 `markdown` 列为内核侧禁用的工具词，而计划 §4 / D381 把 `format: "plain" | "markdown"` 定死在协议里，两者冲突。不改名字就过不了，换个写法躲开检查（例如拼接字符串、手写序列化）等于绕过检查，我没有这样做；`scripts/check-arch.mjs` 不在我允许修改的文件里（且测试会话可写 `scripts/check-*.mjs`）。**请协调会话决定**，建议：在 `check-arch.mjs` 里对 `crates/protocol` 放行这一个词（它现在是协议里的文字格式名，不是某个插件），或在 `decisions.md` 记一条例外。修好之前 `pnpm lint` / `pnpm check` 在这个分支上是红的。
