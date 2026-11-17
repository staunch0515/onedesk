# 第十一轮独立审查（只读的 Opus 子代理，2026-11-18；协调会话整理）

范围 `git diff 6bbc59c..d7a5b52`。结论：没有发现可被利用的注入或协议绕过。每条修改都要补测试；处理结果写进各自 `round11-*-done.md` 的“审查后的修改”一节。

| # | 级别 | 问题 | 位置 | 处理人 | 处理 |
|---|---|---|---|---|---|
| 1 | 必须修 | `markdown-it` 带进来的子依赖 `argparse@2.0.1` 是 Python-2.0 许可证，不在允许清单里（规则 9）。 | `pnpm-lock.yaml`；D381 | 外壳 | D385：换成 `marked`（MIT，没有子依赖）；保持同样的安全做法（原始 HTML 一律转义成文字、链接白名单、图片只出替代文字、`[[名称]]` 转义），锁文件里不得再有 `argparse` |
| 2 | 应修 | `openExternal` 的长度检查用的是解析前的字符数，发出去的是规范化后的网址（中文路径百分号编码后变长）；内核审计记成成功而外壳拒绝打开。 | `crates/kernel/src/host.rs:46-50,488`；`crates/host/src/external.rs:27`；`src/workbench/state/context.tsx:58` | 内核 | 按规范化后的长度检查；补非 ASCII 网址的测试 |
| 3 | 应修 | 工作区配置页的“界面语言”没有列出 `i18n.languages`（只有状态栏和命令面板做了），在配置页只是一个文字参数；假数据模式写死了英、中两项，没有日语。 | `src/workbench/pages/`；`src/workbench/protocol/mock/index.ts:95` | 外壳 | 配置页里 `ui.language` 用下拉，选项来自 `i18n.languages`；假数据模式补日语 |
| 4 | 应修 | 测试缺口：Markdown 的绕过用例（大小写、`&#106;avascript:` 实体、`<javascript:…>` 自动链接、引用式链接与引用式图片）；内核 `migrate`、树处理函数里调 `openExternal`；切换插件版本时的 `languages` 主题。 | `src/design/components/markdown-text.test.tsx`；`crates/kernel/tests/round11.rs` | 外壳 / 内核 | 补 |
| 5 | 应修 | `openExternal` 没有次数上限：一次运行里调 100 次就开 100 个浏览器标签页。 | `host.rs:479-492` | 内核 | D386：一次调用（一次运行或一次页面事件）里最多 5 次，超出 `denied/tooMany` |
| 6 | 只记录 | Markdown 的链接校验只看前缀，`[x](http:foo)` 渲染成可点、点了才被拒；Markdown 里的链接点击不经过内核，不留审计。 | `markdown-text.tsx:22,32` | — | 换库时让两处用同一个判断函数 |
| 7 | 只记录 | `[[名称]]` 按当前活动标签页里已保存的引用解析：草稿里新写的引用在阅读态显示成失效。 | `src/workbench/parts/view-nodes.tsx:15-22` | — | 记 `todo.md` |
| 8 | 只记录 | 语言插件可以覆盖任何键（含安装确认、权限说明），没有受保护的键；译文少了 `{name}` 确认框就丢掉插件名。翻译只进文本节点，不会注入 HTML。 | `src/workbench/i18n/index.tsx:63-80` | — | 记 `todo.md` |
| 9 | 应修 | 主进程用 `/usr/bin/open -- <url>` 打开：不确定 macOS 的 `open` 认不认 `--`；spawn 的结果被丢弃。 | `crates/host/src/external.rs:49` | 外壳 | 去掉 `--`（网址已校验以 http/https/mailto 开头，不会被当成选项）；检查 spawn 结果，失败时把错误交回界面 |
| 10 | 应修 | 笔记页改成了 `recompute: true`，编辑时每次停顿都让内核重新渲染。 | `plugins/org.onedesk.note/manifest.json` | 测试 | 改成不依赖重算（切换阅读态走页面事件即可）；做不到写明原因 |

没有问题的检查点：原始 HTML 已关闭、链接判断在解码规范化之后、图片不发请求、`[[名称]]` 转义、CSS 只在 `src/design`；内核按解析出的协议判断、主进程不经 shell、审计只记主机名、只在运行和页面事件里可调用；清单 `contributes.languages` 的各种拒绝、`i18n.shell` 重新校验路径、1 MB 上限、不激活插件、缺键回退英语；启动页只接受独立页面、只在启动时判断一次；`legacyKinds` 没有任何路径按它改数据；新插件只通过宿主接口、只返回视图树、提示词的正则线性且不二次展开；内核与主进程没有插件名或语言特例、协议只增、没有新迁移、文字都在 i18n。
