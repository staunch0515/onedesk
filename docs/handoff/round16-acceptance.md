# 第十六轮验收（2026-11-21，第六个协调会话）

范围：`sqlpool-parity.md` A（查询目录）、E（历史与保存的结果）、G（环境里的数据源）、H（表）；D418–D424、D431（D431 的实现在第十七轮）。协调分支 `claude/onedesk-coord-6`，验收时 `67df016`。

## 结论：通过

| 检查 | 结果 |
|---|---|
| `pnpm check:types`、`typecheck`、`lint` | 通过 |
| `pnpm test`（vitest） | 768/768 |
| `cargo test --workspace`、`pnpm clippy` | 589/0、无警告（`ec7d281` 上跑；之后协调分支没有 Rust 变动，`git diff 42d219f..67df016` 无 `crates/`） |
| `pnpm e2e`（真内核 + PostgreSQL 17） | 284 通过、1 按条件跳过、0 失败；其中 `round16.spec.ts` 25 条全过、无 `test.fixme` |

e2e 用单独构建的第十六轮 devhost（scratchpad 下 `target16`），因为共享的 `target/` 已是第十七轮的构建。

## 协调会话亲自验收（真内核 devhost + 临时 PostgreSQL 17，`ONEDESK_SECRET_STORE=memory`，数据目录在 scratchpad）

| 行 | 怎么验 | 结果 |
|---|---|---|
| A1/A5/A9 | 授权文件夹建索引：2 条进目录、2 条不合格文件列出原因；树按 id 前两段分组 | 通过 |
| A2 | 条目页带文件里的 SQL、只读 | 通过 |
| A6 | 在界面上选参数运行 `{{order.*}}` 查询，3 行结果正确 | 通过（截图 `catalog-run.jpg`） |
| A7 | “截至时间” 2 月 → pen、cup；4 月 → pen；现在 → pen v2；“实际 SQL”是 DISTINCT ON 子查询 | 通过 |
| A4 | 删掉文件后重新索引：树里留着并标“失效”，搜索不到，运行记录保留 | 通过（D422） |
| A10 | “另存为保存的 SQL”打开的新标签页带上 `paid`、`3`，占位符已展开 | 通过（截图 `save-as-sql-params.jpg`） |
| E1–E6 | 最近运行、复用参数、保留并命名、保留结果整页分页、删除前确认 | 通过（截图 `run-history.jpg`） |
| H1/H3 | 刷新后按前缀分组；`no_such_table` 标“缺失”，`item_ver` 不标 | 通过（截图 `table-tree-missing.jpg`） |
| H5 | 当前、某条记录历史、某一时刻、一段时间变化、已删除五种查询结果都对 | 通过 |
| G1–G4、G6、G7 | 由 e2e 覆盖；工作区默认数据源在上面各项里实际生效 | 通过 |

验收中途发现的环境坑：devhost 不认 `ONEDESK_BUILTIN_PLUGINS` 环境变量，要用 `--plugins`，否则加载 `target/bundle-inputs` 里的旧插件。

## 审查与修正

`round16-review.md`：18 条 + e2e 发现 5 条，全部处理（D421–D423、D432 之前的各项）。最后发现的 `round16.spec.ts:562` 超时经查是测试写法（不是重绘循环），测试已改，另加 D431（已保留结果排前，在第十七轮实现）。

## 没验证的

- 桌面窗口里的画面（只在浏览器面板里看过）、打包的 `.app`、真钥匙串。
- 经 ssh 的数据源只测了失败路径（第十五轮起的限制）。

## 留到以后（已在 `todo.md` 或第十七轮）

- 运行记录里表插件的运行显示原始动作名（如 `org.onedesk.tab…`），不是可读标题。
- 中文界面里运行状态（success/error）与部分吐司仍是英文。
- `round11.spec.ts:343` 笔记阅读视图曾偶发失败一次。
