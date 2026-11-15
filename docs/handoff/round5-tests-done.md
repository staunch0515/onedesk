# 第五轮 插件与测试 第一阶段：交接

## 做了什么
- 笔记插件 `manifest.json`：kind `note` 增加 `fields: { "text": { "type": "longtext", "refs": true } }`（原先没有 `fields`；字段名 `text` 对应 `body.text`）。页面结构未改。
- 占位提示加了 `[[Name]]` / `[[名称]]` 说明（en-US、zh-CN）。
- `main.test.ts` 新增两条：清单声明（且无 `grants`）；两种语言的占位提示含引用记号。
- 夹具 `e2e/fixtures/exports/`：
  - `sample/`：`manifest.json`、`resources.json`、`revisions.json`、`runs.json`（空）、`audit.json`、`blobs/`（`.gitkeep`）。内容：分组 `Export sample`；笔记 `Alpha`↔`Beta` 互相 `[[ ]]` 引用（Beta 还含一个失效的 `[[Nowhere]]`）；`com.example.missing:thing` 的 `Orphan thing`（本机无此插件，应 `unknownKind`）；笔记 `Shared note`，外部键 `fixture:shared-note`（第二阶段先在工作区建同外部键的）。
  - `broken/wrong-format/`（`format` 为 `something-else`）、`broken/bad-version/`（`version: 99`）。

## 测试结果
`pnpm test`（30 文件 199 条）、`pnpm lint`、`pnpm typecheck` 均通过。夹具 JSON 已逐个 `python3 -m json.tool` 校验。
未改 `plugins/_testing` 和 `scripts/check-*.mjs`（无需）。

## 假设
- 字段声明放在 kind 的 `fields` 下（与 http 插件一致）。
- 导出文件的具体字段名（`pluginId`、`pluginVersion`、`parentId`、`pos`、`externalKey`、`createdAt` 等；revisions 的 `resource/seq/op/fields/snapshot`；audit 的字段）是按计划与 kernel-design §3.3 猜的，内核会话未定。
- 坏夹具放在 `broken/` 下的两个子文件夹。

## 没验证
- **合并后要对着内核实际导出的文件校正 `sample/` 的全部字段名与结构**，再用 `workspace.importPreview` 实跑。
- `refs: true` 清单声明未经真内核清单校验器加载过（内核第五轮才加该校验）。
- `e2e/round5.spec.ts` 本阶段未写。
