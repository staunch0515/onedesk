# OneDesk 插件文档

OneDesk 的所有功能都是插件。内核只认识**资源、插件、视图**，不认识任何具体插件；内置插件与外部插件走同一条加载路径、同一个沙箱、同一套宿主接口。这里的文档写给插件作者（人或 AI）。

## 文档

| 文档 | 用途 | 什么时候读 |
|---|---|---|
| [spec.md](spec.md) | 开发规范：包结构、清单全部字段与拒收原因、contributes、处理函数、视图树、宿主接口与权限、多语言、错误、AI 辅助的过渡规则、沙箱限制、版本与 `upgradesFrom`、命名；附一个能通过测试的完整示例 | 写代码前通读；写的时候当参考手册 |
| [workflow.md](workflow.md) | 环境与流程：插件放哪、怎么跑测试、`plugin:check`、在 devhost 里实际运行、`plugin:pack`、安装、发新版本、回退 | 开始动手时 |
| [acceptance.md](acceptance.md) | 验收清单：每条通过/不通过，写明是自动检查、测试还是人工看 | 交付前自查；验收时逐条打勾 |
| [ai-prompt.md](ai-prompt.md) | 交给另一个 AI 写插件的提示词，和人填的需求表 | 让 AI 写插件时 |

阅读顺序：README（本文）→ spec.md → workflow.md → acceptance.md。让 AI 写插件时只需把 ai-prompt.md 的提示词和填好的需求表交给它。

## 生命周期

**开发**：在 `plugins-external/<id>/`（官方插件）或自己的文件夹（第三方）里写 `manifest.json`、`main.js`、`locales/`；`plugins/` 只放随应用打包的最小一组内置插件。**测试**：同目录写 `main.test.ts`，用 `plugins/_testing/view-check.ts` 的假宿主和视图校验，绝不连真实服务；需要看真实效果时用 devhost + 临时数据目录。**检查**：`pnpm plugin:check <插件目录>` 校验布局、清单、语言文件、无 CSS/TSX/HTML、架构规则，并跑该插件的测试。**打包**：`pnpm plugin:pack <插件目录>` 先检查，再生成 `dist/plugins/<id>-<version>.odplugin`（zip，清单在根目录，不含测试和 `._*`/`.DS_Store`/链接，≤ 200 MB）。**安装**：在应用里“安装插件…”选这个文件，或由市场插件 `org.onedesk.market` 从用户授权的文件夹列出并安装；用户确认权限后放进数据目录。**升级**：发一个版本号更高的包，用 `upgradesFrom` 声明能接管哪些旧版本的数据，必要时写 `migrate`；确认过权限的新版本自动接管，用户可以撤销或切回旧版本，删除的版本移到 `plugins/.removed/`。**发布**：按 acceptance.md 验收通过后分发 `.odplugin` 文件，并在 `CHANGELOG.md` 写明变化。

## 规则的来源

本文档以代码为准：`crates/kernel/src/manifest.rs`（清单）、`crates/protocol/src/lib.rs`（视图与协议）、`crates/kernel/src/sandbox.rs` 与 `host.rs`（宿主接口与沙箱）、`scripts/check-arch.mjs` 与 `scripts/check-ui.mjs`（自动规则）。清单格式、宿主接口、协议的变更由协调会话决定并记入 `docs/decisions.md`；插件作者需要新能力时写到 `docs/handoff/todo.md`。
