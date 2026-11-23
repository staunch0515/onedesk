# OneDesk

OneDesk 是个人和企业日常工作的统一桌面入口：一个“内核 + 插件”的框架。内核只认识**资源、插件、视图**；所有具体功能都由插件提供。它**不是**某个具体工具（不是笔记软件、不是 HTTP 客户端），也不是 Web 服务。

## 技术栈

Tauri 2（Rust stable）· React 19 · TypeScript 7 · Vite 8 · SQLite（rusqlite）· rquickjs（插件沙箱）· ts-rs（协议类型生成）· Radix UI + 自有 CSS token · lucide 图标 · vitest · Playwright。仅 macOS 11.3+。包管理 pnpm，Node 22（`.nvmrc`）。

设计在 `docs/redesign/`（内核 `kernel-design.md`、计划 `dev-plan.md`、AI 辅助 `ai-assist.md`）；协议约定见 `docs/handoff/week1-protocol.md`。插件开发、测试、打包、验收见 `docs/plugins/`。第二十一轮之前的交接、验收记录、截图和技术小样已清理，需要时看标签 `v0-r21-before-cleanup`。

## 命令

```bash
pnpm start                # 启动桌面应用（tauri dev）
pnpm prototype            # 浏览器里的纯假数据原型（外观基准）
pnpm gen:types            # 由 crates/protocol 生成 TS 协议类型
pnpm typecheck / lint / test
pnpm test:rust            # cargo test --workspace
pnpm clippy               # 警告即失败
pnpm e2e                  # Playwright
pnpm plugin:check <目录>   # 检查一个插件（清单、语言、规则、测试）
pnpm plugin:pack <目录>    # 检查后打包成 dist/plugins/<id>-<版本>.odplugin
pnpm check                # 以上全部，失败不得提交
```

## 目录

| 目录 | 职责 |
|---|---|
| `crates/protocol` | 协议类型，Rust 为准；TS 生成到 `src/workbench/protocol/generated/`（不手改） |
| `crates/kernel` | 内核库（不依赖 Tauri）：工作区、写入管线、资源与树、插件沙箱与宿主接口、页面 |
| `crates/worker` | 工作进程：一个工作区一个 |
| `crates/host`、`src-tauri` | 主进程：启动和监视工作进程、转发；`src-tauri` 只是窗口外皮 |
| `src/design/` | 设计系统：`tokens.css`（唯一定义数值的地方）+ 基础组件。所有 CSS 只能放这里 |
| `src/workbench/` | 外壳界面，只经 `ProtocolClient` 工作；`protocol/mock` 是演示数据 |
| `plugins/` | 随应用打包的基础插件（`manifest.json` + `main.js` + `locales/`）；`_testing/` 是共用测试工具 |
| `plugins-external/` | 其他官方插件：在这里开发和测试，不进安装包，以 `.odplugin` 包文件发布（D456） |
| `e2e/` | Playwright 界面检查 |
| `docs/` | `redesign/`、`plugins/`（插件作者文档）、`decisions.md`、`handoff/`（会话交接）、`manual/` |

## 硬性规则

1. 内核（`crates/kernel`、`crates/worker`、`crates/protocol`）和主进程不得出现任何具体插件的名字、kind 或逻辑（`pnpm lint` 检查）。
2. 内置插件只通过宿主接口工作，运行在沙箱里，与外部插件同一条加载路径；插件不含 CSS/TSX，只返回视图树。
3. 界面只用设计 token 和 `src/design` 的基础组件；页面不写一次性样式，不写死颜色/像素/时长（`pnpm lint` 检查）。
4. 外壳文字放 `src/workbench/i18n/`（英语为兜底）；内核不含界面文字；插件自带语言文件。
5. 占位符语法由插件定义，核心只提供按名字从当前环境取值（见 requirements.md I.0f）。
6. 数据库结构变更只能新增迁移文件，不改已发布的迁移；每个迁移都有升级测试（从第一个正式发布版起执行；之前不考虑已有数据，D460）。
7. 密钥只在钥匙串，数据库、清单、导出文件中不得出现明文。
8. 测试只用内存库或临时目录；重建数据的测试需 `ONEDESK_TEST_DB=1`，并拒绝正式库路径。
9. 新依赖先在 `docs/decisions.md` 写用途、替代方案、许可证（仅 MIT/Apache-2.0/BSD/ISC/Zlib/Unicode-3.0）。
10. 接口（`crates/protocol`、清单格式、宿主接口）的变更由主会话决定，并记入 decisions.md。

## 约定

- 命名：文件 kebab-case；React 组件 PascalCase；CSS 类名 `od-` 前缀。
- 错误：内核返回 `{code, params}`，不含文字；外壳按 code 配文字（D219）。
- 测试与源码同目录：`foo.ts` ↔ `foo.test.ts`；Rust 测试在模块内 `#[cfg(test)]`。
- 提交：`<范围>: <做了什么>` + 空行 + 为什么。范围如 `kernel`、`design`、`plugin/link`、`rust`、`docs`。先 `pnpm check` 再提交。
- 改完就编译、就跑对应测试；写完 JSON 立即 `python3 -m json.tool` 校验。路径写完整绝对路径（数据目录是 `~/Library/Application Support/onedesk/`，不是 `/Library/...`）。
- 仓库在 exFAT 盘上：macOS 会生成 `._*` 文件，已被 git、vitest、Playwright 和打包忽略；不要提交它们。界面测试的截图写到 `test-results/screenshots/`，不入库。
- 多会话：一个文件同一时间只有一个写入者；会话间只通过 `docs/handoff/` 交流；范围外的问题记到 `docs/handoff/todo.md`。

详细设计见 [docs/redesign/kernel-design.md](docs/redesign/kernel-design.md)，所有决定见 [docs/decisions.md](docs/decisions.md)。
