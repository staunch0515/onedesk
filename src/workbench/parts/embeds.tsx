import { useCallback, useContext, useEffect, useState } from "react";
import { Button, Checkbox, EmbedBlock, FormField, Input, MarkdownText, MultiSelect, Pane, Select, Text, Textarea, useToast, type CallValue, type ReferenceState } from "../../design";
import { useI18n } from "../i18n";
import type { EmbedResult, RefInfo, ViewField, ViewNode } from "../protocol";
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
  // D487 §23: shown inside a stamped resource, a reference shows what it showed then.
  const within = useContext(BlobScope);
  const callValue = useCallback(
    async (text: string): Promise<CallValue> => {
      const ref = refOf(refs, text);
      const target = ref?.state === "ok" ? ref.target : undefined;
      const params = paramsOf(text);
      if (!target || !client.refs.embed) return { text: text.replace(/^=\s*/, "").split("|")[0]!.trim(), error: true, title: t("embed.missing") };
      const title = params ? `${target.name}（${params}）` : target.name;
      const e = await client.refs.embed({ id: target.id, params, inline: true, envId, within });
      if (e.badParams) return { text: t("call.badParams"), error: true, title };
      if (e.text === undefined || e.text === null) return { text: target.name, error: true, title: t("call.cannot") };
      return { text: e.text, error: e.error ?? undefined, title: e.error ? `${title} — ${e.text}` : title };
    },
    [refs, client, envId, t, within],
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
  const within = useContext(BlobScope);
  const ref = refOf(refs, text);
  const target = ref?.state === "ok" ? ref.target : undefined;
  const params = paramsOf(text);
  const [, written] = splitMark(text.split("|")[0]!.trim());
  const section = ref?.section ?? written;
  const shown = target !== undefined && depth < MAX_EMBED_DEPTH && !chain.includes(target.id);
  const q = useQuery(
    (c) => (shown && c.refs.embed ? c.refs.embed({ id: target.id, section, envId, params, within }) : Promise.resolve(null)),
    [shown, target?.id, section, envId, params, within],
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
      <EmbedBody e={e} section={section} params={params} place={inner} />
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

/**
 * What an embedded resource shows (D481), and (D487 §19, K11) its forms and buttons: the fields' values stay with this
 * embed; a button sends `resource.embedAct` and the answer replaces the view. Images inside are read for the embedded
 * resource (D484 §16).
 */
export function EmbedBody({ e, section, params, args, place, headingShift }: { e: EmbedResult; section?: string; params?: string; args?: unknown; place: Place; headingShift?: number }) {
  const { client } = useWorkbench();
  const { tx } = useI18n();
  const { toast } = useToast();
  const [shown, setShown] = useState<{ view: EmbedResult["view"]; actions: EmbedResult["actions"] }>({ view: e.view, actions: e.actions });
  const [values, setValues] = useState<Record<string, string>>(e.values ?? {});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setShown({ view: e.view, actions: e.actions });
    setValues(e.values ?? {});
  }, [e]);
  const act = async (action: string) => {
    if (!client.refs.embedAct) return;
    setBusy(true);
    try {
      const r = await client.refs.embedAct({ id: e.id, section, params, args, envId: place.envId, action, values });
      if (r.view) setShown({ view: r.view, actions: r.actions ?? undefined });
      else if (r.actions) setShown((s) => ({ ...s, actions: r.actions }));
      if (r.values) setValues(r.values);
      if (r.message) toast({ tone: "neutral", title: tx(r.message) });
    } catch {
      toast({ tone: "danger", title: tx({ "en-US": "?" }) });
    } finally {
      setBusy(false);
    }
  };
  const set = (name: string, v: string) => setValues((x) => ({ ...x, [name]: v }));
  return (
    <BlobScope.Provider value={e.id}>
      {shown.view
        ? shown.view.map((n, i) =>
            n.type === "text" && n.format === "markdown" && !n.mono ? (
              <RefMarkdown key={i} source={n.text} headingShift={headingShift} refLabels={n.refLabels ?? undefined} {...place} />
            ) : n.type === "form" ? (
              <EmbedForm key={i} node={n} values={values} onChange={set} />
            ) : (
              <ViewNodes key={i} nodes={[n]} />
            ),
          )
        : e.description && <Text tone="muted">{e.description}</Text>}
      {shown.actions && shown.actions.length > 0 && (
        <Pane direction="row" gap="xs" justify="end">
          {shown.actions.map((a) => (
            <Button key={a.id} size="sm" icon={a.icon ?? undefined} disabled={busy} onClick={() => void act(a.id)}>
              {tx(a.label)}
            </Button>
          ))}
        </Pane>
      )}
    </BlobScope.Provider>
  );
}

/** D487 §19 (K11): a form inside an embed — bound to nothing; its values are the embed's. */
function EmbedForm({ node, values, onChange }: { node: Extract<ViewNode, { type: "form" }>; values: Record<string, string>; onChange: (name: string, v: string) => void }) {
  const { tx } = useI18n();
  return (
    <Pane direction={node.layout === "strip" ? "row" : "column"} gap="sm" wrap align={node.layout === "strip" ? "end" : undefined}>
      {node.label && <Text tone="muted">{tx(node.label)}</Text>}
      {node.fields.map((f) => (
        <FormField key={f.name} label={tx(f.label)} description={f.hint ? tx(f.hint) : undefined}>
          <EmbedControl field={f} value={values[f.name] ?? ""} onChange={(v) => onChange(f.name, v)} />
        </FormField>
      ))}
    </Pane>
  );
}

function EmbedControl({ field: f, value, onChange }: { field: ViewField; value: string; onChange: (v: string) => void }) {
  const { tx } = useI18n();
  const disabled = f.readOnly ?? false;
  const options = (f.options ?? []).map((o) => ({ value: o.value, label: tx(o.label) }));
  switch (f.kind) {
    case "enum":
      return <Select size="sm" options={options} value={value || undefined} onValueChange={onChange} disabled={disabled} placeholder={f.placeholder ? tx(f.placeholder) : undefined} aria-label={tx(f.label)} />;
    case "multi":
      return <MultiSelect size="sm" options={options} value={value ? value.split(",") : []} onValueChange={(v) => onChange(v.join(","))} disabled={disabled} aria-label={tx(f.label)} />;
    case "boolean":
      return <Checkbox checked={value === "true"} onCheckedChange={(c) => onChange(c ? "true" : "false")} disabled={disabled} aria-label={tx(f.label)} />;
    case "longtext":
      return <Textarea value={value} onChange={(ev) => onChange(ev.target.value)} disabled={disabled} placeholder={f.placeholder ? tx(f.placeholder) : undefined} aria-label={tx(f.label)} />;
    default:
      return <Input size="sm" value={value} onChange={(ev) => onChange(ev.target.value)} disabled={disabled} placeholder={f.placeholder ? tx(f.placeholder) : undefined} aria-label={tx(f.label)} />;
  }
}
