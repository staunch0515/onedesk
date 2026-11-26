import { useEffect, useState } from "react";
import { Badge, Banner, Button, DiffView, LoadingState, Pane, Section, Text, Textarea, valueText, type DiffLayout } from "../../design";
import { useI18n } from "../i18n";
import type { PageDescriptor } from "../protocol";
import type { JsonValue } from "../protocol/generated/serde_json/JsonValue";
import type { ProposalDecision, ProposalFieldView, ProposalItemView, ProposalView } from "../protocol/generated";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

type Edits = Record<number, Record<string, string>>;

/** Who made a proposal, in words: an AI client by name, the user, a plugin. */
export function proposerText(t: ReturnType<typeof useI18n>["t"], who: string): string {
  if (who.startsWith("ai:")) return t("proposal.byAi", { name: who.slice(3) });
  if (who.startsWith("plugin:")) return t("proposal.byPlugin", { name: who.slice(7).split("@")[0] ?? "" });
  return t("proposal.byUser");
}

/** A field's name: the page's label, else the shell's word for name, description, tags. */
function fieldName(t: ReturnType<typeof useI18n>["t"], tx: ReturnType<typeof useI18n>["tx"], f: ProposalFieldView): string {
  if (f.label) return tx(f.label);
  if (f.path === "name") return t("proposal.field.name");
  if (f.path === "description") return t("proposal.field.description");
  if (f.path === "tags") return t("proposal.field.tags");
  return f.path;
}

/** One value as the editor holds it: texts as they are, tags one per line. */
const editText = (v: JsonValue | undefined) => (Array.isArray(v) ? v.map((x) => valueText(x)).join("\n") : valueText(v));
const fromEdit = (f: ProposalFieldView, text: string): JsonValue => (f.path === "tags" ? text.split("\n").map((s) => s.trim()).filter(Boolean) : text);

/** D487 §29.2: one item of a proposal — what it changes, compared with what is there now; accept, reject, edit. */
function ItemBlock({ item, open, edits, setEdits, layout, setLayout, onDecide, busy }: {
  item: ProposalItemView;
  open: boolean;
  edits: Record<string, string> | undefined;
  setEdits: (e: Record<string, string> | undefined) => void;
  layout: DiffLayout;
  setLayout: (l: DiffLayout) => void;
  onDecide: (d: ProposalDecision) => void;
  busy: boolean;
}) {
  const { t, tx } = useI18n();
  const { actions } = useWorkbench();
  const pending = !item.result;
  const canAct = open && pending && !item.gone;
  const canEdit = canAct && item.op !== "delete";
  const where = item.location.filter(Boolean).join(" / ");
  const opWord = item.op === "update" ? t("proposal.op.update") : item.op === "create" ? t("proposal.op.create") : t("proposal.op.delete");
  const resultBadge =
    item.result === "accepted" ? <Badge tone="success" icon="check">{t("proposal.result.accepted")}</Badge>
    : item.result === "rejected" ? <Badge tone="neutral" icon="x">{t("proposal.result.rejected")}</Badge>
    : item.result === "void" ? <Badge tone="warning" icon="circle-slash">{t("proposal.result.void")}</Badge>
    : null;
  const diffLabels = { before: item.op === "update" ? t("proposal.now") : t("proposal.before"), after: t("proposal.proposed"), split: t("diff.split"), stacked: t("diff.stacked"), empty: t("diff.empty"), added: t("diff.added"), removed: t("diff.removed"), same: t("diff.same") };
  const decide = (decision: ProposalDecision["decision"]) => {
    const values: Record<string, JsonValue> = {};
    for (const f of item.fields) if (edits && edits[f.path] !== undefined) values[f.path] = fromEdit(f, edits[f.path]!);
    onDecide({ index: item.index, decision, values: decision === "accept" && Object.keys(values).length > 0 ? values : undefined, basis: item.currentRev ?? undefined });
  };
  const target = item.op === "create" ? item.created : item.resourceId;
  return (
    <Section
      title={
        <Pane direction="row" gap="xs" align="center" wrap>
          <Text weight="semibold">{`${item.index + 1}. ${opWord} · ${item.name}`}</Text>
          {resultBadge}
          {pending && item.stale && <Badge tone="warning" icon="git-compare">{t("proposal.stale")}</Badge>}
          {pending && item.gone && <Badge tone="warning" icon="circle-slash">{t("proposal.gone")}</Badge>}
        </Pane>
      }
      description={[item.kindLabel ? tx(item.kindLabel) : "", where, item.op !== "create" && item.rev ? t("proposal.revs", { rev: item.rev, now: item.currentRev ?? "—" }) : ""].filter(Boolean).join(" · ")}
      actions={
        <Pane direction="row" gap="xs">
          {target && !item.gone && (
            <Button size="sm" variant="ghost" icon="external-link" onClick={() => actions.open(`resource:${target}`)}>
              {t("proposal.openTarget")}
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" icon="pencil" aria-pressed={edits !== undefined} onClick={() => setEdits(edits ? undefined : Object.fromEntries(item.fields.map((f) => [f.path, editText(f.proposed)])))}>
              {t("proposal.edit")}
            </Button>
          )}
          {canAct && (
            <>
              <Button size="sm" variant="ghost" icon="x" disabled={busy} onClick={() => decide("reject")}>
                {t("proposal.reject")}
              </Button>
              <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => decide("accept")}>
                {edits ? t("proposal.acceptEdited") : t("proposal.accept")}
              </Button>
            </>
          )}
        </Pane>
      }
    >
      <Pane gap="md">
        {pending && item.stale && <Banner tone="warning" title={t("proposal.staleTitle")}>{t("proposal.staleBody")}</Banner>}
        {item.op === "delete" && <Text size="sm" tone="muted">{t("proposal.deleteNote")}</Text>}
        {item.fields.map((f) => {
          const before = item.op === "update" ? f.current : item.op === "delete" ? f.current : null;
          const after = item.op === "delete" ? null : edits && edits[f.path] !== undefined ? fromEdit(f, edits[f.path]!) : f.proposed;
          const name = fieldName(t, tx, f);
          const kind = f.kind === "rows" ? "rows" : f.path === "name" || f.path === "tags" ? "value" : "text";
          return (
            <Pane key={f.path} gap="xs">
              <Text size="sm" weight="medium">{name}</Text>
              <DiffView label={name} kind={kind} before={before} after={after} layout={layout} onLayoutChange={setLayout} labels={diffLabels} />
              {edits && edits[f.path] !== undefined && (
                <Textarea aria-label={t("proposal.editField", { field: name })} rows={f.path === "name" ? 1 : 6} value={edits[f.path]} onChange={(e) => setEdits({ ...edits, [f.path]: e.target.value })} />
              )}
            </Pane>
          );
        })}
      </Pane>
    </Section>
  );
}

/** D487 §29.2, §29.5: a proposal of changes — each item against what is there now, accepted or rejected one by one. */
export function ProposalPage({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, actions } = useWorkbench();
  const { t, dateTime } = useI18n();
  const id = descriptor.resourceId ?? "";
  const q = useQuery((c) => (c.proposal ? c.proposal.get(id) : Promise.reject(new Error("unsupported"))), [id], [`resource:${id}`, "tree:resources", "tree:proposals"]);
  const [shown, setShown] = useState<ProposalView | null>(null);
  const [edits, setEditsAll] = useState<Edits>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState<DiffLayout>("split");
  // What the last review answered, until the proposal is read again.
  useEffect(() => setShown(null), [q.data]);
  const view = shown ?? q.data;

  const review = async (items: ProposalDecision[]) => {
    if (!client.proposal || items.length === 0) return;
    setBusy(true);
    try {
      const v = await client.proposal.review({ id, items, comment: note.trim() || undefined });
      setShown(v);
      setEditsAll((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !items.some((d) => d.index === Number(k)))));
    } catch (e) {
      actions.fail(e);
      q.reload();
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <Frame tab={tab} descriptor={descriptor}>
        <LoadingState label={t("common.loading")} />
      </Frame>
    );
  }
  const open = view.status === "pending" || view.status === "partial";
  const waiting = view.items.filter((i) => !i.result && !i.gone);
  const statusTone = view.status === "accepted" ? "success" : view.status === "pending" || view.status === "partial" ? "info" : "neutral";
  const all = (decision: ProposalDecision["decision"]) =>
    review(
      view.items
        .filter((i) => !i.result)
        .map((i) => {
          const values: Record<string, JsonValue> = {};
          const e = edits[i.index];
          for (const f of i.fields) if (e && e[f.path] !== undefined) values[f.path] = fromEdit(f, e[f.path]!);
          return { index: i.index, decision, values: decision === "accept" && Object.keys(values).length > 0 ? values : undefined, basis: i.currentRev ?? undefined };
        }),
    );

  return (
    <Frame tab={tab} descriptor={{ ...descriptor, title: view.title }}>
      <Pane gap="lg" grow scroll pad="lg">
        <Section
          title={
            <Pane direction="row" gap="xs" align="center" wrap>
              <Text weight="semibold">{view.title}</Text>
              <Badge tone={statusTone}>{t(`proposal.status.${view.status}` as "proposal.status.pending")}</Badge>
            </Pane>
          }
          description={`${proposerText(t, view.proposer)} · ${dateTime(view.at)} · ${t("proposal.itemCount", { count: view.items.length })}`}
          actions={
            open ? (
              <Pane direction="row" gap="xs">
                {view.status === "pending" && view.proposer === "user" && (
                  <Button size="sm" variant="ghost" icon="undo-2" disabled={busy} onClick={() => client.proposal?.withdraw(id).then(setShown, actions.fail)}>
                    {t("proposal.withdraw")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon="x" disabled={busy || waiting.length === 0} onClick={() => void all("reject")}>
                  {t("proposal.rejectAll")}
                </Button>
                <Button size="sm" variant="primary" icon="check-check" disabled={busy || waiting.length === 0} onClick={() => void all("accept")}>
                  {t("proposal.acceptAll")}
                </Button>
              </Pane>
            ) : undefined
          }
        >
          <Pane gap="sm">
            {view.comment && <Text as="p">{view.comment}</Text>}
            {view.reviewComment && <Text size="sm" tone="muted">{t("proposal.reviewNote", { note: view.reviewComment })}</Text>}
            {open && <Textarea aria-label={t("proposal.note")} placeholder={t("proposal.notePlaceholder")} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Pane>
        </Section>
        {view.items.map((item) => (
          <ItemBlock
            key={item.index}
            item={item}
            open={open}
            edits={edits[item.index]}
            setEdits={(e) => setEditsAll((all) => {
              const next = { ...all };
              if (e) next[item.index] = e;
              else delete next[item.index];
              return next;
            })}
            layout={layout}
            setLayout={setLayout}
            busy={busy}
            onDecide={(d) => void review([d])}
          />
        ))}
      </Pane>
    </Frame>
  );
}
