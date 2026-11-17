/**
 * Demo mode only (no kernel, so no language plugins to load): the shell texts of the built-in language plugins, read straight
 * from their packages. With a kernel the same files arrive through `i18n.shell`; the shell keeps no copy of them (round 11).
 * `import.meta.glob` rather than `import … from "plugins/…"`: the architecture check forbids the shell importing plugin
 * code, and these are data files; the rule's wording is in docs/handoff/round11-shell-done.md.
 */
const files = import.meta.glob<{ default: Record<string, string> }>("../../../plugins/org.onedesk.lang.*/shell/*.json", { eager: true });

const NAMES: Record<string, string> = { "zh-CN": "简体中文", "ja-JP": "日本語" };

export const DEMO_LANGUAGES: Array<{ locale: string; name: string; texts: Record<string, string> }> = Object.entries(files)
  .map(([path, module]) => {
    const locale = /\/([A-Za-z-]+)\.json$/.exec(path)?.[1] ?? "";
    return { locale, name: NAMES[locale] ?? locale, texts: module.default };
  })
  .filter((l) => l.locale !== "")
  .sort((a, b) => a.locale.localeCompare(b.locale));
