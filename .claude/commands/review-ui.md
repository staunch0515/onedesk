---
description: 检查界面是否只用了设计 token 和基础组件
---
1. 运行 `node scripts/check-ui.mjs`，列出所有违规。
2. 人工补查（脚本查不到的）：
   - src/shell 中是否有直接写的原生控件（`<button>`、`<input>`、`<select>`、`<table>`）而不是 src/design 的组件；
   - 是否有不在 src/shell/i18n 中的界面文字（JSX 中直接写的中文/英文）；
   - 是否混用了 lucide 以外的图标；
   - 每个页面是否都有加载中、空状态、错误状态；
   - 动效时长是否只用 --duration-* token，是否有弹跳/渐变/大面积强调色。
3. 如能启动浏览器预览（`pnpm preview:web`），浅色和深色各看一遍主要页面。
输出：违规列表（文件:行、问题、建议），不要直接修改代码。
