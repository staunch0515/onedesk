import { useCallback } from "react";
import { EmbedBlock, MarkdownText, Text, type CallValue, type ReferenceState } from "../../design";
import { useI18n } from "../i18n";
import type { RefInfo } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import { useOpenHere, ViewNodes } from "./view-nodes";
import { BlobScope, useBlobUrl, useImageLabels } from "./blobs";

/**
 * D481 (docs/redesign/embed-book.md §3): `![[name]]` / `![[name#section]]` in Markdown shows the other resource's
 * content in place — what its plugin's embed view gives, in the tab's environment, read only. Embeds inside embeds go
 * at most `MAX_EMBED_DEPTH` deep, and a resource already being shown above is not shown again (a loop): both are links.
 */
export const MAX_EMBED_DEPTH = 3;

/** `name#section` → [name, section]; a `#` at the start or the end is part of the name (as the kernel reads it). */
export function splitMark(text: string): [string, string | undefined] {
  const i = text.indexOf("#");
  return i > 0 && i < text.length - 1 ? [text.slice(0, i), text.slice(i + 1)] : [text, undefined];
}

/** The reference a mark stands for: as written, or as shown after its target was renamed (D321). */
export function refOf(refs: RefInfo[], text: string): RefInfo | undefined {
  // D487 §17: a call's parameters may have been filled in (`{{room}}` → 25) before the text is shown: then the name
  // part decides, among the calls (or the embeds) with that name.
  const base = (t: string) => t.replace(/^=\s*/, "").split("|")[0]!.split("#")[0]!.trim();
  const isCall = /^=\s*\S/.test(text);
  return (
    refs.find((r) => r.text === text) ??
    refs.find((r) => r.target && `${r.target.name}${r.section ? `#${r.section}` : ""}` === text) ??
    refs.find((r) => r.target && r.target.name === text) ??
    (text.includes("|") ? refs.find((r) => r.target && /^=\s*\S/.test(r.text) === isCall && (base(r.text) === base(text) || r.target.name === base(text))) : undefined)
  );
}

interface Place {
  refs: RefInfo[];
  envId: string | null;
  depth: number;
  /** Ids of the resources being shown around this point, outermost first. */
  chain: string[];
}

/** Markdown with its `[[links]]` and `![[embeds]]` resolved against `refs` (the references of the resource it comes from). */
/** D487 §17: what follows the first unescaped `|` of a mark's text (its parameters), trimmed; undefined without. */
export function paramsOf(text: string): string | undefined {
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc) esc = false;
    else if (c === "\\") esc = true;
    else if (c === "|") return text.slice(i + 1).trim() || undefined;
  }
  return undefined;
}

export function RefMarkdown({ source, headingShift, refLabels, ...place }: Place & { source: string; headingShift?: number; refLabels?: Record<string, string> }) {
  const { actions, client } = useWorkbench();
  const { t } = useI18n();
  const openHere = useOpenHere();
  const { refs } = place;
  const referenceState = useCallback((name: string): ReferenceState => refOf(refs, name)?.state ?? "missing", [refs]);
  const renderEmbed = useCallback((text: string) => <Embed text={text} {...place} />, [place]);
  // D487 §17: `[[=name | …]]` shows what the target computes, in the tab's environment.
  const envId = place.envId;
  const callValue = useCallback(
    async (text: string): Promise<CallValue> => {
      const ref = refOf(refs, text);
      const target = ref?.state === "ok" ? ref.target : undefined;
      const params = paramsOf(text);
      if (!target || !client.refs.embed) return { text: text.replace(/^=\s*/, "").split("|")[0]!.trim(), error: true, title: t("embed.missing") };
      const title = params ? `${target.name}（${params}）` : target.name;
      const e = await client.refs.embed({ id: target.id, params, inline: true, envId });
      if (e.badParams) return { text: t("call.badParams"), error: true, title };
      if (e.text === undefined || e.text === null) return { text: target.name, error: true, title: t("call.cannot") };
      return { text: e.text, error: e.error ?? undefined, title: e.error ? `${title} — ${e.text}` : title };
    },
    [refs, client, envId, t],
  );
  const imageUrl = useBlobUrl();
  const imageLabels = useImageLabels();
  return (
    <MarkdownText
      source={source}
      blobUrl={imageUrl}
      imageLabels={imageLabels}
      callValue={callValue}
      headingShift={headingShift}
      referenceLabels={refLabels}
      referenceState={referenceState}
      renderEmbed={renderEmbed}
      onLinkClick={(href) => void actions.openExternal(href)}
      onReferenceClick={(name) => {
        const to = refOf(refs, name)?.target;
        if (to) openHere(`resource:${to.id}`);
      }}
    />
  );
}

export function Embed({ text, refs, envId, depth, chain }: Place & { text: string }) {
  const { t, tx } = useI18n();
  const openHere = useOpenHere();
  const ref = refOf(refs, text);
  const target = ref?.state === "ok" ? ref.target : undefined;
  const params = paramsOf(text);
  const [, written] = splitMark(text.split("|")[0]!.trim());
  const section = ref?.section ?? written;
  const shown = target !== undefined && depth < MAX_EMBED_DEPTH && !chain.includes(target.id);
  const q = useQuery(
    (c) => (shown && c.refs.embed ? c.refs.embed({ id: target.id, section, envId, params }) : Promise.resolve(null)),
    [shown, target?.id, section, envId, params],
    target ? [`resource:${target.id}`] : [],
  );
  if (!target) return <EmbedBlock title={text} icon="unlink" broken note={t("embed.missing")} />;
  // D487 §17: a call says its parameters after the name.
  const withParams = (name: string) => (params ? `${name}（${params}）` : name);
  const title = withParams(section ? `${target.name} › ${section}` : target.name);
  const open = () => openHere(`resource:${target.id}`);
  if (!shown) return <EmbedBlock title={title} icon="link" onOpen={open} note={t("embed.tooDeep")} />;
  const e = q.data;
  if (!e) return <EmbedBlock title={title} icon="loader" onOpen={open} note={q.error ? t("embed.failed") : t("common.loading")} />;
  const inner: Place = { refs: e.refs, envId, depth: depth + 1, chain: [...chain, e.id] };
  return (
    <EmbedBlock
      title={withParams(section ? `${e.name} › ${section}` : e.name)}
      icon={e.icon}
      kind={e.kindLabel ? tx(e.kindLabel) : undefined}
      onOpen={open}
      place={e.path.length > 0 ? e.path.join(" › ") : undefined}
      note={e.badParams ? t("call.badParams") : e.sectionMissing ? t("embed.sectionMissing", { section: section ?? "" }) : undefined}
    >
      {/* D484 §16: images inside are read for the embedded resource. */}
      <BlobScope.Provider value={e.id}>
        {e.view
          ? e.view.map((n, i) =>
              n.type === "text" && n.format === "markdown" && !n.mono ? <RefMarkdown key={i} source={n.text} refLabels={n.refLabels ?? undefined} {...inner} /> : <ViewNodes key={i} nodes={[n]} />,
            )
          : e.description && <Text tone="muted">{e.description}</Text>}
      </BlobScope.Provider>
    </EmbedBlock>
  );
}

/** The active tab's environment (where the page is drawn): embeds are filled from it. */
export function useTabEnv(): string | null {
  return useUi((s) => {
    const tab = s.tabs.find((x) => x.id === s.activeTabId);
    return tab?.usesEnv ? (tab.envId ?? null) : null;
  });
}
