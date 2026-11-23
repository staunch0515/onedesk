# 交给另一个 AI 写插件的提示词（ai-prompt）

用法：先填好 §1 的需求表，然后把 §2 整段（连同填好的表）贴给另一个 AI（需要能读写这个仓库、能运行命令）。它的最终报告格式在 §2 末尾。

## 1. 需求表（人填）

```text
插件 id：            org.onedesk.<名>        （第三方用自己的反向域名）
插件目录：           plugins-external/<id>/  （第三方：<绝对路径>/<id>/）
一句话用途：
资源类型（kinds）：  每个写：id、中文名、body 字段（名字、类型、是否密钥/网络地址/引用）、放在哪棵树
页面：               每个写：给哪个 kind 用、显示什么、有哪些按钮
动作（actions）：    每个写：id、做什么、输入从哪来、输出类型（table/text/link/none）、失败时说什么
命令（commands）：   （可选）
设置（settings）：   （可选）名字、类型、默认值
权限：               files？ network 的主机（写死的 / 来自资源字段）？ 密钥名字？ 外部程序（名字、来源）？
依赖/接口：          （可选）depends、exports、implements、uses
AI 辅助：           默认所有文本字段都有（外壳提供）；列出需要 hint/format 或要关闭（off）的字段
语言：               en-US + zh-CN（内置插件再加 ja-JP）
版本：               0.1.0（新插件）/ 新版本号 + upgradesFrom + body 有无变化
不要做的：
```

## 2. 提示词（整段复制）

````text
你是 OneDesk 的插件作者。OneDesk 是 macOS 上的“内核 + 插件”桌面应用：内核只认识资源、插件、视图，所有功能由插件提供。插件跑在 QuickJS 沙箱里，只能通过 ctx.host 与外界打交道，只返回视图树，由外壳用设计系统画出来。

你的任务：按文末“需求表”写一个插件，让它一次通过 `pnpm plugin:check` 和验收清单。

## 先读（按顺序，读完再动手）

1. CLAUDE.md（项目规则）
2. docs/plugins/spec.md（开发规范：清单每个字段、宿主接口、视图树、权限、多语言、错误、沙箱、版本；§14 是完整示例）
3. docs/plugins/workflow.md（目录、测试、检查、打包）
4. docs/plugins/acceptance.md（验收清单：交付前逐条自查）
5. 与需求最接近的真实插件（manifest.json、main.js、main.test.ts、locales/）：
   - 最小：plugins/org.onedesk.link
   - 页面事件、命令、页面参数：plugins/org.onedesk.note、plugins/org.onedesk.prompt
   - 程序、密钥、进度、长运行：plugins/org.onedesk.datasource
   - 网络（fromResources）、流式、接口实现：plugins/org.onedesk.ai.anthropic
   - 文件、provided 树、导出：plugins/org.onedesk.catalog
6. plugins/_testing/view-check.ts（测试辅助）
规范与代码不一致时以代码为准（crates/kernel/src/manifest.rs、crates/protocol/src/lib.rs、crates/kernel/src/sandbox.rs），并在报告里写出来。

## 硬性规则（违反任何一条即不验收）

1. 只写插件目录里的文件。不改 crates/、src/、scripts/、其他插件、docs/decisions.md、CLAUDE.md、package.json。不加依赖。不 git commit。
2. 清单严格：不写 spec.md 没列的字段；apiVersion 是字符串 "2"；所有名字引用都要存在；所有文字都是语言键。写完每个 JSON 立即 `python3 -m json.tool <文件>`。
3. main.js 是 ES 模块，`export default { activate(host) { ... } }`；activate 里只注册处理函数，名字与清单一一对应。只 import 包内 ./x.js。不用 console、setTimeout、setInterval、fetch、XMLHttpRequest、window、document、localStorage、require、process。
4. 不写 CSS、TSX/JSX、HTML；JS 里不出现 style、className、innerHTML、颜色、像素、时长。视图只用 form、text、table、link 四种节点，字段只用 spec.md §6 列出的。
5. 每段给人看的文字来自 locales/*.json；en-US 与 zh-CN（内置插件再加 ja-JP）键完全相同、{占位} 相同。需要纯文字的地方用 spec.md §8 的 tr(ctx, key, vars)。
6. 权限只申请用到的。密钥用 type "secret" 字段 + {{secret:名字}} 占位符，绝不出现明文，不申请 secrets.plaintext。网络主机全部声明。外部程序参数用数组，不拼 shell。
7. 不写任何 AI 代码：不调 AI 服务商插件，不 uses "onedesk.ai.chat/1"，不画 AI 界面。AI 辅助由外壳统一提供，插件只在字段上写 assist: { hint, format, off }（spec.md §11）。
8. 抛给用户的错误：`throw new Error(tr(ctx, "error.xxx"))`，不带 code，不含密钥。宿主错误要让用户看到自己的说明时，捕获后改写。
9. 页面必须处理空状态、错误状态、前置条件未满足的状态（用 text 节点说明，tone muted/danger）；运行结果页（ctx.run 存在）表单只读。
10. 测试只用假宿主（vi.fn），不连任何真实服务，不碰真实数据目录和钥匙串。
11. 需要规范里没有的能力（新清单字段、新宿主方法）时：不要绕，写进报告的“需要协调会话决定”。

## 交付物（都在插件目录里）

- manifest.json
- main.js（以及它 import 的包内 .js，如有）
- locales/en-US.json、locales/zh-CN.json（内置插件加 ja-JP.json）
- main.test.ts（每个源文件一个同目录测试），至少覆盖 docs/plugins/acceptance.md 的 E1–E9 中适用的每一条：
  注册与清单一致；每个 render 的 checkView 与 RENDER_KEYS；空/正常/出错/运行结果页；每个事件；每个动作的成功与每种失败；每个命令；非英语 locale 的占位替换；语言文件键一致；migrate（如有）；网络/程序/文件调用参数与密钥占位符（如有）。
  测试辅助从 plugins-external/<id>/ 引用写 "../../plugins/_testing/view-check"，从 plugins/<id>/ 写 "../_testing/view-check"。
- CHANGELOG.md（写 0.1.0 或本版本的变化）
- 新版本时：升 version，写 upgradesFrom，body 有变化就写 kinds.handle(kind, { migrate }) 和对应测试。

## 自查步骤（必须都做，都通过才报告完成）

1. 每个 JSON：`python3 -m json.tool <文件>` 通过。
2. `pnpm exec vitest run <插件目录>` 全部通过。
3. `pnpm plugin:check <插件目录>` 通过（失败就改，直到通过；不要改检查脚本）。
4. `pnpm plugin:pack <插件目录>` 成功，记下产物路径；`unzip -l <产物>` 确认根目录是 manifest.json、没有测试文件和 ._*/.DS_Store。
5. 对照 docs/plugins/acceptance.md 逐条自查，[自动] 的看命令结果，[测试] 的指出是哪个测试，[手动] 的说明你怎么确认的或为什么需要人来看（例如界面外观、深色主题、真实安装）。

## 最终报告格式（不超过 400 字，加清单）

1. 结果：通过 / 未通过（一句话）。
2. 文件：插件目录里每个文件的完整路径。
3. 命令结果：plugin:check、vitest（测试数）、plugin:pack（产物完整路径）各一行。
4. 权限：最终的 requires/uses 列表，每项一句为什么需要。
5. 验收自查表：A1…H7 每条一行“编号 通过/不适用/需人工：理由”。
6. 需要人工看的：界面（浅色/深色、中英文）、真实安装、升级路径等。
7. 规范与代码的不一致、需要协调会话决定的事项（没有就写“无”）。

## 需求表

<把填好的需求表贴在这里>
````
