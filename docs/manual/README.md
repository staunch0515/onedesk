# OneDesk 用户手册

给第一次用 OneDesk 的同事。不需要懂开发。版本 1.0（仅 macOS 11.3 及以上）。

OneDesk 是一个桌面工作台：左边是一棵树，放你的笔记、网址、提示词、保存的 SQL、数据源……每一类东西由“插件”提供。你在这里写的东西都存在你自己的电脑上。

| 章节 | 什么时候看 |
|---|---|
| [1. 安装与首次打开](01-install.md) | 拿到应用之后 |
| [2. 数据目录、备份与恢复](02-data-and-backup.md) | 想知道东西存在哪、怎么备份 |
| [3. 工作区](03-workspaces.md) | 想分开存放不同项目的内容 |
| [4. 数据源（PostgreSQL）](04-datasource.md) | 要连数据库 |
| [5. 保存的 SQL 与查询目录](05-queries.md) | 要写、存、跑查询 |
| [6. AI 设置（Anthropic 与 Ollama）](06-ai.md) | 要让 AI 帮你分析结果或写 SQL |
| [7. MCP：让 Claude Desktop 用 OneDesk](07-mcp.md) | 要让外部 AI 客户端只读地用你的查询 |
| [8. 常见问题](08-faq.md) | 出了问题 |
| [English summary](en-summary.md) | One page in English |

## 图和“待确认”

- 本手册暂时没有截图；截图在手测后单独补。
- 写“待确认”的是写手册时源码里查不到、或其他会话还在改的事，不是已核实的结论；清单见 `docs/handoff/round20-docs-done.md`。
- 手册里提到的界面文字以中文界面为准（设置里可切换中文、英语、日语）。
