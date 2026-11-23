# 第二十一轮 1.0.1 加固：完成记录

分支 `claude/onedesk-r21-fix`（未 push、未合并）。决定见 D455。

## 根因
exFAT 上的 `.app` 副本带 `._locales`、`._main.js` 等 AppleDouble 二进制文件。内置包复制（`crates/host/src/plugins.rs` 的 `collect`）把它们装进数据目录；内核 `read_js_files`（`crates/kernel/src/kernel.rs`）对所有 `.js` 做 `read_to_string`，读到 `._main.js` 就报 `stream did not contain valid UTF-8`，整个插件无法激活（页面失败、`workspace.opened` 事件失败）。

## 改了什么
1. `onedesk_kernel::util::is_junk_name`（`._*`、`.DS_Store`）。用在：内核读包 `.js`；主进程内置包复制与比较（`plugins.rs`）；手动安装复制 `copy_package`（`install.rs`）。语言文件和清单按清单里的路径读，本来不会读到 `._*`。旧副本不迁移，加载时忽略。
2. 页面失败显示原因：`detail` 本来就随错误下发（协议无变更）；`useQuery` 增加 `errorDetail`（仅 `pluginError`，首行、≤200 字符），`page-host.tsx` 的失败状态用 `ErrorState.resolution` + `Text` 显示；`page.errorDetail` 加进 `en-US.ts`、`zh-CN.json`、`ja-JP.json`。

## 测试（均已先看到失败）
- `kernel::tests::package_reading_skips_appledouble_and_ds_store`（失败原文即用户的 UTF-8 错误）
- `plugins::tests::junk_files_are_not_copied_and_do_not_make_an_old_copy_stale`
- `install::tests::copy_leaves_appledouble_and_ds_store_behind`
- `round14-shell.test.tsx`：“a page the plugin could not produce”

## 怎么验证
带 `._*` 的数据目录启动 devhost，`page.resolve target new:org.onedesk.command:command` 应返回页面而非 `pluginError`；`pnpm check` 全绿（结果见提交说明/协调会话回报）。
