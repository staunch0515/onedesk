import { useCallback } from "react";
import { EmbedBlock, MarkdownText, Text, type ReferenceState } from "../../design";
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
  return (
    refs.find((r) => r.text === text) ??
    refs.find((r) => r.target && `${r.target.name}${r.section ? `#${r.section}` : ""}` === text) ??
    refs.find((r) => r.target && r.target.name === text)
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
export function RefMarkdown({ source, ...place }: Place & { source: string }) {
  const { actions } = useWorkbench();
  const openHere = useOpenHere();
  const { refs } = place;
  const referenceState = useCallback((name: string): ReferenceState => refOf(refs, name)?.state ?? "missing", [refs]);
  const renderEmbed = useCallback((text: string) => <Embed text={text} {...place} />, [place]);
  const imageUrl = useBlobUrl();
  const imageLabels = useImageLabels();
  return (
    <MarkdownText
      source={source}
      blobUrl={imageUrl}
      imageLabels={imageLabels}
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
  const [, written] = splitMark(text);
  const section = ref?.section ?? written;
  const shown = target !== undefined && depth < MAX_EMBED_DEPTH && !chain.includes(target.id);
  const q = useQuery(
    (c) => (shown && c.refs.embed ? c.refs.embed({ id: target.id, section, envId }) : Promise.resolve(null)),
    [shown, target?.id, section, envId],
    target ? [`resource:${target.id}`] : [],
  );
  if (!target) return <EmbedBlock title={text} icon="unlink" broken note={t("embed.missing")} />;
  const title = section ? `${target.name} › ${section}` : target.name;
  const open = () => openHere(`resource:${target.id}`);
  if (!shown) return <EmbedBlock title={title} icon="link" onOpen={open} note={t("embed.tooDeep")} />;
  const e = q.data;
  if (!e) return <EmbedBlock title={title} icon="loader" onOpen={open} note={q.error ? t("embed.failed") : t("common.loading")} />;
  const inner: Place = { refs: e.refs, envId, depth: depth + 1, chain: [...chain, e.id] };
  return (
    <EmbedBlock
      title={section ? `${e.name} › ${section}` : e.name}
      icon={e.icon}
      kind={e.kindLabel ? tx(e.kindLabel) : undefined}
      onOpen={open}
      place={e.path.length > 0 ? e.path.join(" › ") : undefined}
      note={e.sectionMissing ? t("embed.sectionMissing", { section: section ?? "" }) : undefined}
    >
      {/* D484 §16: images inside are read for the embedded resource. */}
      <BlobScope.Provider value={e.id}>
        {e.view
          ? e.view.map((n, i) =>
              n.type === "text" && n.format === "markdown" && !n.mono ? <RefMarkdown key={i} source={n.text} {...inner} /> : <ViewNodes key={i} nodes={[n]} />,
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
