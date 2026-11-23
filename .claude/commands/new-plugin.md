---
description: 按接口模板生成一个新插件的骨架和测试
argument-hint: <插件 id，如 org.onedesk.todo> <kind id> [目标目录，默认 plugins-external]
---
参数：$ARGUMENTS

1. 先读 CLAUDE.md、docs/plugins/spec.md（全文，§14 是完整示例）、docs/plugins/workflow.md §4，以及一个已有插件作为模板（plugins/org.onedesk.link，或页面事件/命令多的 plugins/org.onedesk.note）。
2. 在 `<目标目录>/<插件 id>/` 下创建（目标目录默认 `plugins-external`；只有协调会话决定随应用打包的插件才放 `plugins`）：
   - `manifest.json`：id、version "0.1.0"、apiVersion "2"、name/description（语言键）、icon（lucide 图标名）、main "main.js"、author、license "MIT"、requires（只申请用到的）、contributes（一个 kind、它的 editor 页面、必要的动作、menus.new、locales）。只用 spec.md §3–4 列出的字段。写完立即运行 `python3 -m json.tool` 校验。
   - `main.js`：`export default { activate(host) { ... } }`，只注册清单里声明的处理函数，只 import 包内文件，一切外部操作经 `ctx.host`。
   - `locales/en-US.json`、`locales/zh-CN.json`（放在 `plugins/` 的还要 `ja-JP.json`），键完全相同。写完同样校验 JSON。
   - `main.test.ts`：用 `plugins/_testing/view-check.ts`（从 plugins-external 引用写 `../../plugins/_testing/view-check`，从 plugins 写 `../_testing/view-check`）覆盖：注册与清单一致、每个视图的视图树通过 `checkView`、`RENDER_KEYS`、每个动作的成功和失败路径、语言文件键一致。
   - `CHANGELOG.md`：写 0.1.0。
3. 运行 `pnpm exec vitest run <目标目录>/<插件 id>` 和 `pnpm plugin:check <目标目录>/<插件 id>`，全部通过后报告，并按 docs/plugins/acceptance.md 列出需要人工看的项。
不要修改内核、外壳、检查脚本或其他插件。
