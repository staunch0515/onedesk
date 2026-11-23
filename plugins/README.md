# OneDesk plugins

This folder holds only the plugins bundled into the app. Other official plugins live in `plugins-external/<id>/`; `_testing/` has the shared test helpers (`view-check.ts`, locale checks, fake servers).

The plugin author documentation (in Chinese) is in [`docs/plugins/`](../docs/plugins/README.md):

- [`spec.md`](../docs/plugins/spec.md): the development standard: manifest, host interface, view tree, permissions, i18n, versions; a complete example.
- [`workflow.md`](../docs/plugins/workflow.md): develop, test, `pnpm plugin:check`, `pnpm plugin:pack`, install, upgrade.
- [`acceptance.md`](../docs/plugins/acceptance.md): the acceptance checklist.
- [`ai-prompt.md`](../docs/plugins/ai-prompt.md): a ready-to-paste prompt for having another AI write a plugin.

When the docs and the code disagree, the code wins: `crates/kernel/src/manifest.rs`, `crates/protocol/src/lib.rs`, `crates/kernel/src/sandbox.rs`, `crates/kernel/src/host.rs`.
