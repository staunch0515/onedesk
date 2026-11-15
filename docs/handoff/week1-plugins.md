# 任务：插件与测试（分支 `week1/plugins`，Sonnet）

## 目标

两个真正的内置插件（运行在沙箱里、只经宿主接口工作），以及连真内核的界面检查和架构检查。

内核和外壳由另外两个会话同时在写。第一阶段你按 `week1-protocol.md` §6–§7 写插件，用一个假的 `host` 在 vitest 里测插件代码；界面检查先写好但跑不了。三块合并后，协调会话会通知你进入第二阶段：在合并后的分支上把界面检查跑通。

## 允许修改

`plugins/**`、`e2e/**`、`playwright.config.ts`、`scripts/check-arch.mjs`、`scripts/check-ui.mjs`、`docs/screenshots/`；自己的交接文件；`docs/handoff/todo.md`（只追加）。`vite.config.ts` 不归你改（vitest 已包含 `plugins/**/*.test.ts`）。

## 只读依赖

`docs/handoff/week1-protocol.md`（§3–§7）、`crates/protocol/src/lib.rs`、`src/workbench/protocol/generated/`（视图、节点的类型）、`src/workbench/protocol/mock/`（原型里笔记页、文件树的样子，照着做）、`e2e/workbench.spec.ts`（现有检查的写法）。

## 要做的

1. `plugins/org.onedesk.note/`：类型 `note`（放在 `resources` 树，body 为 `{ text }`）；页面 `editor`：与原型的笔记页一样——占满高度的正文（`longtext`，`bind: "body.text"`，`fill`）；操作区“保存”；“新建”下拉里有“笔记”；右键命令“创建副本”（`commands.handle("duplicate")`：用 `ctx.host.resources` 读原笔记、建副本，用 `ctx.host.ui.open` 打开）。英、中两份文字。
2. `plugins/org.onedesk.files/`：`requires.files: true`；提供树 `files`：顶层是各授权文件夹，下面是文件和子文件夹（文件夹在前、按名字排序、隐藏文件不列、分批）；没有授权文件夹时顶层为空（工具栏有“添加文件夹”= `plugin.grantFolder`）；节点 `key` 用绝对路径；页面 `text`（`node:` 目标）：文本文件显示为占满高度的 `code` 字段（`bind: "content"`，按扩展名给 `language`），`save` 用 `writeText` 并带 `basis`；不是文本或太大时显示一个 `muted` 的文字节点说明原因；文件夹节点没有页面（没有 `target`）。面包屑是从授权文件夹起的路径。
3. 两个插件都是纯 JS（ES 模块，无构建步骤，不 `import` 包外的东西，不用 `console`/`setTimeout`/`fetch`——沙箱里没有）。每个插件一个 `*.test.ts`，用假 `host` 测处理函数：返回的视图符合 `ViewNode` 类型；文件插件对 `denied`/`invalid`/`conflict` 错误的处理。清单写完用 `python3 -m json.tool` 校验。
4. `scripts/check-arch.mjs` 改为新结构的规则：`crates/kernel`、`crates/worker`、`crates/protocol`、`crates/host`、`src-tauri` 的源码（不含 `tests/fixtures`）里不得出现 `plugins/` 下任何插件的 id 及其类型名，也不得出现 note、markdown、sql、postgres、ssh、docker、psql、video、ffmpeg（按词匹配，避免误伤）；`src/workbench` 不得 import `plugins/`，除 `main.tsx` 外不得 import `protocol/mock`；`crates/kernel` 不得依赖 tauri。`scripts/check-ui.mjs` 把检查范围改到 `src/workbench`、`src/design`、`plugins`（插件里不得有 CSS、TSX、内联样式）。
5. `e2e/week1.spec.ts`（连真内核，D266）：启动 `onedesk-devhost`（临时数据目录、随机端口和令牌；`playwright.config.ts` 或 spec 里起进程，等 `READY`），浏览器打开 `workbench.html?kernel=ws://127.0.0.1:<端口>&token=<令牌>`。检查：新建分组、新建笔记并保存、改名、拖动、删除，重启 devhost 后都还在；授权一个临时文件夹后文件树列出其中的文件和子文件夹；打开文本文件、编辑、未保存标记、保存后硬盘上的内容变了、有未保存修改时关闭会询问；授权文件夹之外的路径打不开；杀掉工作进程后界面恢复且数据还在。每一步截图到 `docs/screenshots/week1-*.png`（浅色、深色各一组主要画面）。`e2e/workbench.spec.ts`（纯假数据，外观基准）保持通过；两个 spec 都由 `pnpm e2e` 运行。

## 完成标准

- 第一阶段：`pnpm test`（插件的 vitest）、`pnpm lint`、`pnpm typecheck` 通过；`e2e/week1.spec.ts` 写完（未运行，如实写明）。
- 第二阶段（合并后，协调会话通知）：`pnpm e2e` 全过，截图入库。发现内核或外壳的问题不要自己改它们的文件，写进交接文件，由协调会话处理。

## 交付物

分支 `week1/plugins` 上的提交；交接文件 `docs/handoff/week1-plugins-done.md`。

## 共同规则

- 先读：`CLAUDE.md`、`docs/redesign/week1-slice.md`、`docs/handoff/week1-protocol.md`（协议与约定，必须逐条遵守）、本文件。按需读 `docs/redesign/kernel-design.md` 的相关小节。
- 只改“允许修改”里的文件；范围外的问题追加到 `docs/handoff/todo.md` 的末尾（只追加）。不清楚的地方自行按内核设计决定，并写进交接文件的“我做的决定”，不要停下来问。
- 改完就编译、就跑对应测试；`cargo clippy -p <你的包> --all-targets -- -D warnings` 无警告。测试只用临时目录，绝不碰 `~/Library/Application Support/onedesk*`。
- 小步提交到自己的分支，提交信息 `<范围>: <做了什么>` + 空行 + 为什么。不推送、不合并。
- 省额度：不做范围外的事；不重读已读过的大文件；长时间的构建放后台。
- 结束时写交接文件 `docs/handoff/<分支名把/换成->.md`（模板见 `docs/handoff/README.md`，另加“我做的决定”“新依赖”“协议变更”三节），如实写出没做、没验证的地方。
