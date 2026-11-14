# OneDesk

OneDesk 是个人和企业日常工作的统一桌面入口：一个“内核 + 插件”的框架。内核只认识**资源、插件、视图**；所有具体功能都由插件提供。它**不是**某个具体工具（不是笔记软件、不是 HTTP 客户端），也不是 Web 服务。

## 技术栈

Tauri 2（Rust stable）· React 19 · TypeScript 7 · Vite 8 · SQLite（rusqlite，Rust 侧）· zod 4 · Radix UI + 自有 CSS token · lucide 图标 · cmdk · vitest + sql.js · Playwright。仅 macOS 11+。包管理 pnpm，Node 22（`.nvmrc`）。

## 命令

```bash
./scripts/dev.sh          # 首次安装并启动（检查工具链 → pnpm install → pnpm tauri dev）
pnpm start                # 启动桌面应用（tauri dev）
pnpm preview:web          # 浏览器预览模式（sql.js，用于界面测试与截图）
pnpm build                # 前端构建；pnpm tauri build 打包 .app/.dmg
pnpm typecheck            # tsc
pnpm lint                 # 架构边界检查 + 界面规范检查
pnpm test / pnpm coverage # vitest（内核覆盖率 ≥ 80%）
pnpm test:rust            # cargo test（迁移测试等）
pnpm clippy               # cargo clippy --all-targets，警告即失败
pnpm e2e                  # Playwright 界面测试 + docs/screenshots/
pnpm check                # 以上全部（= /check），失败不得提交
```

## 目录

| 目录 | 职责 |
|---|---|
| `src/plugin-api/` | 对插件公开的接口：zod 校验 + 类型。插件只能 import `@onedesk/plugin-api` |
| `src/kernel/` | 内核：资源库、搜索、集合、插件宿主、注册表、动作执行、事件、存储。契约见 `contracts.ts`。无 UI、无平台代码 |
| `src/platform/` | 平台适配（Tauri 命令 / 浏览器预览 sql.js）。Rust 命令契约见 `contract.ts` |
| `src/design/` | 设计系统：`tokens.css`（唯一定义数值的地方）+ 基础组件。所有 CSS 只能放这里 |
| `src/shell/` | 外壳：布局、菜单、页面、视图渲染器、命令面板接线、设置页、文案 `i18n/` |
| `src/plugins/` | 内置插件，每个一个文件夹（`manifest.json` + `index.ts` + 测试） |
| `src-tauri/` | Rust：数据库与迁移（`migrations/NNNN_*.sql`）、快照、钥匙串、插件扫描、导出导入 |
| `e2e/` | Playwright 界面测试 |
| `docs/` | `architecture.md`、`decisions.md`、`handoff/`（会话交接）、`screenshots/` |

## 硬性规则

1. 内核不得出现任何具体插件的名字、kind 或逻辑；不得 import `plugins/ shell/ design/ platform/`（`pnpm lint` 检查）。
2. 内置插件只通过公开接口工作，与外部插件同一条加载路径；插件不含 CSS/TSX，只返回视图树。
3. 界面只用设计 token 和 `src/design` 的基础组件；页面不写一次性样式，不写死颜色/像素/时长（`pnpm lint` 检查）。
4. 界面文字放 `src/shell/i18n/zh-CN.ts`，动词开头、简短。
5. 占位符语法全项目统一 `{{name}}`。
6. 数据库结构变更只能新增迁移文件，不改已发布的迁移；每个迁移都有升级测试。
7. 密钥只在钥匙串，数据库、清单、导出文件中不得出现明文。
8. 测试只用内存库或临时目录；重建数据的测试需 `ONEDESK_TEST_DB=1`，并拒绝正式库路径。
9. 新依赖先在 `docs/decisions.md` 写用途、替代方案、许可证（仅 MIT/Apache-2.0/BSD/ISC）。
10. 接口（`src/plugin-api`、`src/kernel/contracts.ts`、`src/platform/contract.ts`）里程碑内冻结，只有主会话可改并记入 decisions.md。

## 约定

- 命名：文件 kebab-case；React 组件 PascalCase；CSS 类名 `od-` 前缀。
- 错误：内核抛出带中文用户可读信息的 `Error`；动作失败转为 `ActionResult{status:"error"}`，不冒泡。
- 测试与源码同目录：`foo.ts` ↔ `foo.test.ts`；Rust 测试在模块内 `#[cfg(test)]`。
- 提交：`<范围>: <做了什么>` + 空行 + 为什么。范围如 `kernel`、`design`、`plugin/link`、`rust`、`docs`。先 `pnpm check` 再提交。
- 改完就编译、就跑对应测试；写完 JSON 立即 `python3 -m json.tool` 校验。路径写完整绝对路径（数据目录是 `~/Library/Application Support/onedesk/`，不是 `/Library/...`）。
- 多会话：一个文件同一时间只有一个写入者；会话间只通过 `docs/handoff/` 交流；范围外的问题记到 `docs/handoff/todo.md`。

详细设计见 [docs/architecture.md](docs/architecture.md)，所有决定见 [docs/decisions.md](docs/decisions.md)。
