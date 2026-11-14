import type { Kernel } from "../kernel/contracts";
import type { ResourceDraft } from "../plugin-api";
import { t } from "./i18n";

export const SEEDED_PREF = "shell.previewSeeded";

/** One resource per built-in kind in two groups, plus a collection (browser preview only, first start). */
export function sampleDrafts(): ResourceDraft[] {
  const work = t("sample.groupWork");
  const personal = t("sample.groupPersonal");
  return [
    {
      kind: "link",
      name: t("sample.link.name"),
      group: work,
      tags: [t("sample.tagDocs")],
      description: t("sample.link.description"),
      body: { url: "https://example.com/" },
    },
    {
      kind: "http-request",
      name: t("sample.http.name"),
      group: work,
      tags: [t("sample.tagApi")],
      description: t("sample.http.description"),
      body: { method: "GET", url: "https://httpbin.org/get?from=onedesk", headers: "Accept: application/json" },
    },
    {
      kind: "prompt",
      name: t("sample.prompt.name"),
      group: personal,
      tags: [t("sample.tagWriting")],
      description: "",
      body: {
        template: t("sample.prompt.template"),
        parameters: [
          { name: "content", label: t("sample.prompt.paramContent"), required: true },
          { name: "tone", label: t("sample.prompt.paramTone"), default: t("sample.prompt.paramToneDefault") },
        ],
      },
    },
    {
      kind: "note",
      name: t("sample.note.name"),
      group: personal,
      tags: [t("sample.tagReading")],
      description: "",
      body: { content: t("sample.note.content") },
    },
  ];
}

/** Seeds once: skipped when already done or when the database has resources. Kinds that are not loaded are skipped. */
export async function seedSampleData(kernel: Kernel): Promise<void> {
  if (await kernel.prefs.get(SEEDED_PREF)) return;
  await kernel.prefs.set(SEEDED_PREF, true);
  if ((await kernel.resources.list({ includeDisabled: true, limit: 1 })).length > 0) return;
  for (const draft of sampleDrafts()) {
    if (kernel.registry.kind(draft.kind)) await kernel.resources.create(draft);
  }
  await kernel.collections.create({ name: t("sample.collectionName"), rule: { type: "tag", value: t("sample.tagApi") } });
}
