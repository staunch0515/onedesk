# 第二十轮内核两处缺陷（D453）

提交：见本文件所在提交（`git log -1 -- docs/handoff/round20-kernel-done.md`）。

## 缺陷 3：`page.save` 对只读页的未绑定字段
- `crates/kernel/src/pages.rs` `save()` 的 `Target::Resource` 分支：changes 含 `body.*` 键时先 `resolve` 当前页；`read_only` 的页只接受它表单绑定的 `body.*`，否则 `denied` / `reason: readOnlyField` / `field`。`name/description/tags`、`new:`、`params.*` 不受影响。
- 查询目录插件的同步走宿主接口，不经 `page.save`，不受影响（未跑真插件，只在通用测试页上验证）。
- 外壳没有 `readOnlyField` 的文字（只有协议客户端能触发）；若要配，按 code 加到 `src/workbench/i18n/`。

## 缺陷 4：配置页引用型参数
- `param_form` 对 `ParamType::Ref` 输出 `FieldKind::Ref` + `options`（同 kind 的资源，按名字；当前值必含）；空值/悬空值仍是 Text。无协议字段变化，无需 `gen:types`。
- 外壳在 `c771eaf` 的兜底（文本框下显示名字）对 `ref` 字段不再触发，可以删；不删也不冲突。

## 测试（`crates/kernel/tests/round20_kernel.rs`，修之前都失败）
- `read_only_page_refuses_unbound_body_fields`
- `config_page_keeps_a_reference_with_named_candidates`

`cargo test --workspace`、`pnpm clippy`、`pnpm lint` 通过。
