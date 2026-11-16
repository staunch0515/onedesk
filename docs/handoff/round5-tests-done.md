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

---

# 第二阶段：`e2e/round5.spec.ts` 连真内核

分支 `claude/r5-tests-e6bb36`，先合并了 `claude/onedesk-coord-2-91a88b`（内核、外壳第五轮均已在内）。

## 结果（本会话实际运行）
`E2E_PORT=1435 pnpm exec playwright test e2e/round5.spec.ts`：**17 通过、3 `test.fixme`、0 失败**（约 54 秒；devhost 用 `ONEDESK_SECRET_STORE=memory` 和临时数据目录）。截图 `docs/screenshots/round5-*.png`（9 张，新文件，没改任何已有截图）。没有重跑 `workbench.spec.ts` 等其他 spec。

## 夹具校正
- 用真内核导出一次（探针脚本，临时目录），把 `sample` 的字段名改成实际格式：`plugin`、`pluginVersion`、`parent`、`refs: [{field, seq, text, target}]`、`createdBy` 等；`revisions.json` 的 `resourceId/rev/op/fields/snapshot/restoredFrom`；`audit.json` 的 `seq/at/actor/op/object/summary/result`；`manifest.json` 加 `counts`、`appVersion`。
- 注意：夹具里自己带一个分组“Export sample”，导入后它在“新建的顶层分组（名字 = 来源工作区名）”里面，所以是两层。
- 新增 `malicious/`：`tree: "env"` 的分组、伪造的 `core:plugin-state`（`tree: "plugin-state"`）、一条授权 `evil.example.test:8080` 且引用密钥 `victim-token`（头）和 `victim-key`（令牌字段）的 HTTP 请求。
- `broken/wrong-format`、`broken/bad-version` 同步成真格式。

## 用例（全部按原因码/属性断言，只有少数界面检查用英文文字）
引用（三种状态、改名后显示新名且库里历史不增、改名后“保存看到的文字”不换目标且同分组同名诱饵不被选中、删除/恢复/永久删除、永久删除后同名不自动接上、来源被删不列入 incoming、信息面板“引用”一节）；导出（文件清单、无密钥值只有名字、无插件状态节点、`notEmpty/notAbsolute/noParent/insideDataDir`、设置菜单的路径对话框）；导入（预览 4 新建 + `unknownKind` 跳过、错指纹 `fingerprintChanged`、导入后引用按新 id 连着、`import` 历史、审计一行；再导入同外部键更新 1 条；设置菜单里的预览对话框与确认；`notExport/badVersion/unreadable`；恶意夹具：两条 `invalid`、`grantHosts`/`secretNames`、环境树没被污染、`network.grant` 审计；配置节点不导入且本地配置不变）；已知参数（配置页添加 `protection.no_export` 后生效）；只读（保存/新建/删除/改名/建分组/移动/运行/导入都 `denied/readonly` 且 `layer` = 配置节点；密钥、参数、收藏、导出放行；横幅与保存按钮禁用；环境层只读只影响带该环境的保存与运行）；CSV（BOM、CRLF、列数、`exists/notAbsolute/badFormat/insideDataDir`、结果区对话框写文件、非表格输出被拒）；`no_export`（两个导出入口 `denied/noExport`、`restrictions`、CSV 按钮禁用）。

## `test.fixme`（发现的缺陷，我没改）
1. **删除确认没有“被引用数”（外壳/内核）**：计划 §1 写“删除被引用的资源时，确认框写明有几处引用”。内核对普通删除不要求确认，只有永久删除；已删除页里永久删除的对话框是页面自己的（`deleted.purgeBody`），没有数；`CommandDialogs` 里的计数只服务命令确认，实际没有路径会触发。两条 fixme（普通删除、永久删除）。
2. **导入预览对话框不显示 `grantHosts`/`secretNames`（外壳）**：审查要求外壳列出。内核返回正确（用例直接断言了），界面没渲染。一条 fixme。

## 另外发现（不在我的范围，没改）
- `pnpm typecheck` 失败 3 处：`ImportPreview` 新增了必填的 `grantHosts`、`secretNames`，外壳的假实现 `protocol/mock/index.ts:1563`、`mixed-client.test.ts:14`、`transfer-dialogs.test.tsx:11` 没补。
- `pnpm test` 1 个失败：`kernel-texts.test.ts` “notices a new key”，内核源码里出现了 `run.export`（命令/审计名）但 `kernel-texts` 的清单里没有；内核审查后新增的原因码 `tooLarge`、`duplicateId`、`noOutput`、`otherTree` 也还没有文字（会话外壳在补，我没核对）。
- 内核行为备忘（与我最初的猜测不同，已按实际写进用例）：缺 `manifest.json` 或 manifest 不是 JSON → `notExport`；`resources.json` 坏了 → `unreadable`；同一字段里文字没变的 `[[X]]` 按文字保留原目标，所以“删掉再重新写上”才会重新按名称解析。

## 没验证
- 桌面（Tauri）下的系统文件夹/另存为对话框；浏览器模式的路径对话框已验证。
- 我只跑了 `round5.spec.ts`；`pnpm test`（1 个外壳侧失败，见上）、`typecheck`（3 处外壳侧错误）在合并后的树上**不是全绿**，非本会话改动引起。
- 没有写“导入时被接管版本”“只读下撤销升级”的用例。
