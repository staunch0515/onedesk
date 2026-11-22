# 第二十轮独立审查（只读 Opus 子代理，头 255f5df）

结论：**可以发布 1.0，没有阻塞项。** 规则 1、3、4 守住；内核 D453/D454、数据源 NULL 哨兵、外壳改动均核对无误；.app 内插件与 HEAD 一致，无 `_testing`/fake-ai。

## 应修（1.0 标签前）及处理

| # | 问题 | 处理 |
|---|---|---|
| 1 | parity 脚本混在 `pnpm e2e` 里，失败不变红、覆盖证据、写死临时目录 | r20-tests：testIgnore + 独立命令 |
| 2 | week1 K1 断言被删，约 1/5 开出关不掉的 docs 页签未分诊 | r20-tests：恢复为 fixme + 缺陷记录，再派修 |
| 3 | 手册 24 处“待确认/待补截图” | r20-docs 落实已有答案，余者列最终清单；截图手测后补 |
| 4 | build-app.sh 资源路径是合并不是替换 | r20-package |
| 9 | `without_stack` 会多截含 "  at " 的正文行 | r20-kernel |
| 10 | plugins/README.md transfer/storage 漏项 | r20-docs |
| 8 | release 二进制含本机路径 | r20-package（--remap-path-prefix） |

## 记入 post-1.0
D453 多一次渲染与嵌套表单、NULL 哨兵撞值、迁移升级只造空库（见 `post-1.0.md`）。
