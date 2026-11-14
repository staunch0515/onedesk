---
description: 按接口模板生成一个新插件的骨架和测试
argument-hint: <文件夹名> <插件 id，如 org.onedesk.todo> <kind id>
---
参数：$ARGUMENTS

1. 先读 CLAUDE.md、docs/architecture.md 第 4 节、src/plugin-api/types.ts，以及一个已有插件（src/plugins/note/）作为模板。
2. 在 `src/plugins/<文件夹名>/` 下创建：
   - `manifest.json`：id、name、version "0.1.0"、description、icon（lucide 图标名）、apiVersion "1"、provides、requires、settings。写完立即运行 `python3 -m json.tool` 校验。
   - `index.ts`：`export default definePlugin({ activate(host) { ... } })`，只 import `@onedesk/plugin-api`。
   - `index.test.ts`：用 `src/kernel/testing` 的测试内核加载插件，覆盖：清单校验通过、kind 注册、每个动作的成功和失败路径、每个视图的视图树通过校验。
3. 在 `src/plugins/index.ts` 的内置插件列表中登记。
4. 运行 `pnpm lint` 和 `pnpm exec vitest run src/plugins/<文件夹名>`，全部通过后报告。
不要修改内核、外壳或其他插件。
