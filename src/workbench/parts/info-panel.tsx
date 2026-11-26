import { useEffect, useState } from "react";
import { Badge, Button, Dialog, DiffView, IconButton, InfoField, InfoPanel, Input, LoadingState, Pane, Popover, Select, Switch, Text, Textarea, Tooltip, useToast } from "../../design";
import type { HistoryEntry, InheritedEnv, PageDescriptor, RefInfo } from "../protocol";
import type { ResourceAt, StampLogEntry } from "../protocol/generated";
import { proposerText } from "../pages/proposal-page";
import { signedByText } from "../pages/identity-page";
import { useI18n } from "../i18n";
import { useQuery, useUi, useWorkbench } from "../state/context";

const CLIP = 40;
const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP)}…` : text);

/** A field of a resource (or of one revision of it) by path: `name`, `description`, `tags`, `body.<key>`. */
function fieldOf(r: { name: string; description: string; tags: string[]; body: Record<string, unknown> }, path: string): unknown {
  if (path === "name") return r.name;
  if (path === "description") return r.description;
  if (path === "tags") return r.tags;
  if (path.startsWith("body.")) return r.body[path.slice(5)];
  return undefined;
}

/** D487 §29.3: one field as one revision left it, against what it is now. */
function CompareDialog({ resourceId, entry, onClose }: { resourceId: string; entry: HistoryEntry | null; onClose: () => void }) {
  const { client } = useWorkbench();
  const { t } = useI18n();
  const [then, setThen] = useState<ResourceAt | null>(null);
  const now = useQuery((c) => c.resource.get(resourceId), [resourceId], [`resource:${resourceId}`]);
  useEffect(() => {
    setThen(null);
    if (!entry?.rev || !client.resource.at) return;
    let live = true;
    client.resource.at(resourceId, entry.rev).then((r) => live && setThen(r), () => undefined);
    return () => {
      live = false;
    };
  }, [client, resourceId, entry]);
  const labels = { before: t("history.thatVersion"), after: t("history.now"), split: t("diff.split"), stacked: t("diff.stacked"), empty: t("diff.empty"), added: t("diff.added"), removed: t("diff.removed"), same: t("diff.same") };
  const kind = entry?.field === "name" || entry?.field === "tags" ? "value" : "text";
  return (
    <Dialog open={entry !== null} onOpenChange={(o) => !o && onClose()} size="lg" title={t("history.compareTitle", { field: entry?.field ?? "" })} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
      {!then || !now.data || !entry ? (
        <LoadingState layout="inline" label={t("common.loading")} />
      ) : (
        <DiffView label={entry.field} kind={kind} before={fieldOf(then, entry.field)} after={fieldOf(now.data, entry.field)} labels={labels} />
      )}
    </Dialog>
  );
}

/** D487 §29.5: proposals still to be decided that are about this resource. */
function ProposalsField({ resourceId }: { resourceId: string }) {
  const { actions } = useWorkbench();
  const { t } = useI18n();
  const q = useQuery((c) => (c.proposal ? c.proposal.count(resourceId) : Promise.resolve({ pending: 0, ids: [] as string[] })), [resourceId], ["tree:proposals", `resource:${resourceId}`]);
  if (!q.data || q.data.pending === 0) return null;
  return (
    <InfoField label={t("info.proposals")}>
      <Button size="sm" variant="ghost" icon="git-pull-request" onClick={() => actions.open(`resource:${q.data!.ids[0]}`)}>
        {t("info.proposalsPending", { count: q.data.pending })}
      </Button>
    </InfoField>
  );
}

/** Collapsible change history of a resource, newest first, with restore per entry (§4.2). Read only while open. */
function HistorySection({ resourceId, readOnly, stampLog }: { resourceId: string; readOnly: boolean; stampLog?: StampLogEntry[] }) {
  const { client, actions } = useWorkbench();
  const { t, dateTime } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [compare, setCompare] = useState<HistoryEntry | null>(null);
  const history = useQuery((c) => (open ? c.resource.history(resourceId) : Promise.resolve([] as HistoryEntry[])), [resourceId, open], [`resource:${resourceId}`]);
  const entries = history.data ?? [];
  // D487 §23: the change each stamp was put on after (what was signed) is marked.
  const stampedAt = new Map<number, string>();
  for (const s of stampLog ?? []) {
    if (s.action !== "stamp") continue;
    const at = entries.filter((h) => h.at <= s.at).reduce((m, h) => Math.max(m, h.at), -1);
    if (at >= 0) stampedAt.set(at, s.label ?? "");
  }
  return (
    <InfoField label={t("history.title")}>
      <Pane gap="sm">
        <Button size="sm" variant="ghost" icon={open ? "chevron-down" : "chevron-right"} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t("info.historyHide") : t("info.historyShow")}
        </Button>
        {open &&
          (history.data === undefined ? (
            <LoadingState layout="inline" label={t("common.loading")} />
          ) : entries.length === 0 ? (
            <Text size="sm" tone="muted">
              {t("info.historyEmpty")}
            </Text>
          ) : (
            entries.map((h) => (
              <Pane key={h.id} gap="xs">
                <Text size="xs" tone="muted" tabular>{`${dateTime(h.at)} · ${h.actor}`}</Text>
                <Pane direction="row" gap="xs" align="center" wrap>
                  <Text size="sm" weight="medium">{h.field}</Text>
                  {h.restoredFrom && <Badge icon="undo-2">{t("history.restored")}</Badge>}
                  {stampedAt.has(h.at) && <Badge icon="stamp">{t("history.stamped", { label: stampedAt.get(h.at) ?? "" })}</Badge>}
                  {h.proposal && <Badge icon="git-pull-request">{t("history.fromProposal", { title: h.proposal.title, by: proposerText(t, h.proposal.proposer) })}</Badge>}
                </Pane>
                <Text size="xs" mono truncate>{`${clip(h.before)} → ${clip(h.after)}`}</Text>
                <Pane direction="row" gap="xs">
                  {h.rev !== undefined && client.resource.at && (
                    <Button size="sm" variant="ghost" icon="git-compare" onClick={() => setCompare(h)}>
                      {t("history.compare")}
                    </Button>
                  )}
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="undo-2"
                      onClick={() => client.resource.restore(resourceId, h.id).then(() => toast({ tone: "success", title: t("history.restoredToast", { field: h.field, value: clip(h.before) }) }), actions.fail)}
                    >
                      {t("history.restore")}
                    </Button>
                  )}
                </Pane>
              </Pane>
            ))
          ))}
      </Pane>
      <CompareDialog resourceId={resourceId} entry={compare} onClose={() => setCompare(null)} />
    </InfoField>
  );
}

/** One reference: the other side opens on click; a deleted or broken one says so instead of disappearing (§10). */
function RefRow({ info, side, seq }: { info: RefInfo; side: "outgoing" | "incoming"; seq: number }) {
  const { actions, client } = useWorkbench();
  const { toast } = useToast();
  const { t, tx } = useI18n();
  const fieldLabel = info.fieldLabel;
  const other = side === "outgoing" ? info.target : info.source;
  const label = other?.name ?? info.text;
  return (
    <Pane direction="row" gap="xs" align="center" wrap>
      {other && info.state !== "missing" ? (
        <Button size="sm" variant="ghost" icon="arrow-up-right" aria-label={t("refs.open", { name: label })} onClick={() => actions.open(`resource:${other.id}`)}>
          {label}
        </Button>
      ) : (
        <Text size="sm" mono>{`[[${info.text}]]`}</Text>
      )}
      {info.state === "deleted" && (
        <Tooltip content={t("refs.deletedHint", { name: label })}>
          <span tabIndex={0}>
            <Badge tone="warning" icon="trash-2">{t("refs.deleted")}</Badge>
          </span>
        </Tooltip>
      )}
      {info.state === "missing" && (
        <Tooltip content={t("refs.missingHint", { text: info.text })}>
          <span tabIndex={0}>
            <Badge tone="danger" icon="unlink">{t("refs.missing")}</Badge>
          </span>
        </Tooltip>
      )}
      {/* D481: an embed shows the content where it is written; links only point. */}
{/* D487 §17: a call computes with its parameters. */}
      {info.call ? (
        <Badge tone="accent" icon="calculator">{info.params ? t("refs.callWith", { params: info.params }) : t("refs.call")}</Badge>
      ) : (
        info.embed && <Badge tone="accent" icon="layers">{t("refs.embedded")}</Badge>
      )}
      {info.section && <Text size="xs" tone="muted">{`› ${info.section}`}</Text>}
      {/* D482: what is written means several resources, or its path no longer leads there: offer the unique writing. */}
      {side === "outgoing" && (info.ambiguous || info.stale) && (
        <Pane direction="row" gap="xs" align="center" wrap>
          <Tooltip
            content={t(info.ambiguous ? "refs.ambiguousHint" : "refs.staleHint", {
              count: info.ambiguous ?? 0,
              place: info.place && info.place.length > 0 ? info.place.join(" › ") : t("refs.topLevel"),
            })}
          >
            <span tabIndex={0}>
              <Badge tone="warning" icon="copy">{info.ambiguous ? t("refs.ambiguous", { count: info.ambiguous }) : t("refs.stale")}</Badge>
            </span>
          </Tooltip>
          {client.refs.rewrite && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                client.refs.rewrite!(info.source.id, info.field, seq).then((r) => toast({ tone: "success", title: t("refs.rewritten", { text: r.text }) }), actions.fail)
              }
            >
              {t("refs.rewrite")}
            </Button>
          )}
        </Pane>
      )}
      {fieldLabel && <Text size="xs" tone="muted">{t("refs.field", { field: tx(fieldLabel) })}</Text>}
    </Pane>
  );
}

/** What this resource refers to and who refers to it (§10); refreshed by `resource:<id>` events (both sides get one). */
function RefsSection({ resourceId }: { resourceId: string }) {
  const { t } = useI18n();
  const topics = [`resource:${resourceId}`];
  const outgoing = useQuery((c) => c.refs.outgoing(resourceId), [resourceId], topics);
  const incoming = useQuery((c) => c.refs.incoming(resourceId), [resourceId], topics);
  const group = (title: string, rows: RefInfo[] | undefined, side: "outgoing" | "incoming") => (
    <Pane gap="xs">
      <Text size="xs" tone="muted" weight="medium">{title}</Text>
      {rows === undefined ? (
        <LoadingState layout="inline" label={t("common.loading")} />
      ) : rows.length === 0 ? (
        <Text size="sm" tone="subtle">{t("refs.none")}</Text>
      ) : (
        rows.map((r, i) => <RefRow key={`${r.source.id}-${r.field}-${i}`} info={r} side={side} seq={rows.slice(0, i).filter((x) => x.field === r.field).length} />)
      )}
    </Pane>
  );
  return (
    <InfoField label={t("refs.title")}>
      <Pane gap="sm">
        {group(t("refs.outgoing"), outgoing.data, "outgoing")}
        {group(t("refs.incoming"), incoming.data, "incoming")}
      </Pane>
    </InfoField>
  );
}

/** Round 19: whether AI clients (MCP) may see this resource. Off by default; on a group the switch covers everything below it. */
function AiVisibleSection({ id, visible, group, disabled }: { id: string; visible: boolean; group: boolean; disabled: boolean }) {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const { toast } = useToast();
  return (
    <InfoField label={t("info.ai")}>
      <Switch
        checked={visible}
        disabled={disabled}
        label={group ? t("info.aiVisibleGroup") : t("info.aiVisible")}
        description={group ? t("info.aiHintGroup") : t("info.aiHint")}
        onCheckedChange={(next) =>
          client.resource.setAiVisible(id, next, group || undefined).then((r) => group && toast({ tone: "success", title: t("info.aiChanged", { count: r.changed }) }), actions.fail)
        }
      />
    </InfoField>
  );
}

/** D473: a resource of a resource tree (any of them, its groups and the trees themselves). */
export const inResourceTree = (tree: string) => tree === "resources" || tree.startsWith("resources.");

/** The `Select` value standing for "as the place above says" (a Select item cannot have an empty value). */
const FOLLOW = "__follow";

/**
 * D473: the environment pages of this resource (and of everything below a group or tree) open in. Empty = as the place
 * above says (its group, its tree); the field says which one that is and where it is set.
 */
function DefaultEnvField({ value, inherited, inheritedName, disabled, onChange }: { value: string | null | undefined; inherited?: InheritedEnv; inheritedName?: string; disabled?: boolean; onChange: (env: string) => void }) {
  const { t, tx, pageTitle } = useI18n();
  const envs = useQuery((c) => c.params.envOptions(), [], ["env", "tree:environments"]);
  const follow = inherited
    ? t("info.envFollow", { env: inherited.envName, from: inherited.fromName ? inherited.fromName : tx("resources") })
    : inheritedName
      ? t("info.envFollowOnly", { env: inheritedName })
      : t("info.envFollowNone");
  const options = [{ value: FOLLOW, label: follow }, ...(envs.data ?? []).map((e) => ({ value: e.id, label: pageTitle(e.name), depth: e.depth }))];
  return (
    <InfoField label={t("info.defaultEnv")}>
      <Select size="sm" aria-label={t("info.defaultEnv")} options={options} value={value || FOLLOW} disabled={disabled} onValueChange={(v) => onChange(v === FOLLOW ? "" : v)} />
    </InfoField>
  );
}

/** D473: icons a resource tree can be given (lucide names). */
const TREE_ICONS = ["library", "folder-kanban", "briefcase", "building-2", "factory", "store", "database", "server", "cloud", "hard-drive", "network", "boxes", "package", "layers", "layout-dashboard", "globe", "rocket", "flask-conical", "wrench", "shield", "users", "graduation-cap", "heart-pulse", "landmark"];

function TreeIconField({ icon, disabled, onPick }: { icon: string; disabled?: boolean; onPick: (icon: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <InfoField label={t("info.icon")}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        title={t("info.iconPick")}
        trigger={<IconButton icon={icon} variant="secondary" label={t("info.iconPick")} disabled={disabled} />}
      >
        <Pane direction="row" gap="xs" wrap>
          {TREE_ICONS.map((name) => (
            <IconButton
              key={name}
              icon={name}
              label={name}
              variant={name === icon ? "secondary" : "ghost"}
              aria-pressed={name === icon}
              onClick={() => {
                setOpen(false);
                if (name !== icon) onPick(name);
              }}
            />
          ))}
        </Pane>
      </Popover>
    </InfoField>
  );
}

/** Frame-owned info about a resource (§9.3): name, location, description, tags, created / modified. */
export function InfoPanelPart({ resourceId, side }: { resourceId: string; side?: "left" | "right" }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx, dateTime } = useI18n();
  const { data: res } = useQuery((c) => c.resource.get(resourceId), [resourceId], [`resource:${resourceId}`, "plugins"]);

  const update = (patch: Record<string, unknown>) => client.page.save(`resource:${resourceId}`, patch).catch(actions.fail);
  const body = !res ? (
    <LoadingState layout="inline" label={t("common.loading")} />
  ) : (
    <>
      <InfoField label={t("info.name")}>
        <Input
          key={`name-${res.rev}`}
          size="sm"
          aria-label={t("info.name")}
          defaultValue={res.name}
          // The default resource tree starts without a name: the shell's word for it (D473).
          placeholder={res.kind === "core:tree" ? tx("resources") : undefined}
          readOnly={res.readOnly}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            if (name && name !== res.name) void update({ name });
          }}
        />
      </InfoField>
      <InfoField label={t("info.location")}>
        <Pane direction="row" align="center" gap="xs">
          <Pane grow>
            {/* In a resource tree the place starts with the tree; the unnamed default one is the shell's word (D473). */}
            <Text size="sm">{(inResourceTree(res.tree) && res.location.length > 0 ? res.location.map((n) => n || tx("resources")) : [t("info.root"), ...res.location]).join(" / ")}</Text>
          </Pane>
          <IconButton icon="locate" size="sm" label={t("info.reveal")} onClick={() => void actions.reveal(res.tree, res.id)} />
        </Pane>
      </InfoField>
      <InfoField label={t("info.kind")}>
        <Pane direction="row" gap="xs" align="center" wrap>
          <Badge icon={res.icon}>{tx(res.kindLabel)}</Badge>
          {res.pluginVersion && <Text size="xs" tone="muted" mono>{`v${res.pluginVersion}`}</Text>}
          {res.favorite && <Badge tone="accent" icon="star">{t("info.favorite")}</Badge>}
        </Pane>
      </InfoField>
      <InfoField label={t("info.description")}>
        <Textarea
          key={`desc-${res.rev}`}
          rows={3}
          aria-label={t("info.description")}
          defaultValue={res.description}
          readOnly={res.readOnly}
          placeholder={res.readOnly ? undefined : t("info.descriptionPlaceholder")}
          onBlur={(e) => {
            if (e.currentTarget.value !== res.description) void update({ description: e.currentTarget.value });
          }}
        />
      </InfoField>
      <InfoField label={t("info.tags")}>
        <Pane gap="xs">
          <Input
            key={`tags-${res.rev}`}
            size="sm"
            aria-label={t("info.tags")}
            defaultValue={res.tags.join(", ")}
            readOnly={res.readOnly}
            placeholder={t("info.tagsPlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => {
              const tags = e.currentTarget.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
              if (tags.join("\n") !== res.tags.join("\n")) void update({ tags });
            }}
          />
          {res.tags.length > 0 && (
            <Pane direction="row" gap="xs" wrap>
              {res.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </Pane>
          )}
        </Pane>
      </InfoField>
      {res.kind === "core:tree" && <TreeIconField icon={res.icon} disabled={res.readOnly} onPick={(icon) => void update({ "body.icon": icon })} />}
      {inResourceTree(res.tree) && <DefaultEnvField value={res.defaultEnv} inherited={res.inheritedEnv} disabled={res.readOnly || res.deleted} onChange={(env) => void update({ defaultEnv: env })} />}
      {res.kind !== "core:env" && res.kind !== "core:config" && res.kind !== "core:proposal" && res.kind !== "core:contact" && <AiVisibleSection id={resourceId} visible={Boolean(res.aiVisible)} group={res.kind === "core:group" || res.kind === "core:tree"} disabled={res.readOnly || res.deleted} />}
      {res.origin !== "original" && (
        <InfoField label={t("info.origin")}>
          <Text size="sm">
            {res.copy
              ? t(res.copy.variant === "teacher" ? "info.copyFromTeacher" : "info.copyFrom", { publisher: res.copy.publisherName, edition: res.copy.edition, printing: res.copy.printing })
              : res.origin === "subscribed"
                ? t("info.subscribedFrom", { source: res.originRef ?? "" })
                : t("info.copied")}
          </Text>
        </InfoField>
      )}
      {res.stampLog && res.stampLog.length > 0 && (
        <InfoField label={t("info.stamps")}>
          <Pane gap="xs">
            {res.stampLog.map((s, i) => (
              <Text key={i} size="sm" tone={s.action === "unstamp" ? "muted" : undefined}>
                {s.action === "unstamp"
                  ? t("info.unstamped", { reason: s.reason ?? "", at: dateTime(s.at) })
                  : t("info.stamped", { label: s.label ?? "", signer: s.signer ?? "", at: dateTime(s.at) })}
              </Text>
            ))}
            {/* D487 §33: whether each stamp in force is signed, and by whom. */}
            {(res.stamps ?? []).map((s, i) => (
              <Pane key={`sig${i}`} gap="xs">
                <Pane direction="row" gap="xs" align="center" wrap>
                  <Text size="sm">{s.label}</Text>
                  {s.verified === "valid" ? (
                    <Badge tone="success" icon="shield-check">{t("stamp.valid")}</Badge>
                  ) : s.verified === "invalid" ? (
                    <Badge tone="danger" icon="shield-x">{t("stamp.invalid")}</Badge>
                  ) : (
                    <Badge tone="neutral" icon="shield">{t("stamp.unsigned")}</Badge>
                  )}
                </Pane>
                {s.signedBy && (
                  <Text size="xs" tone="muted">
                    {`${signedByText(t, s.signedBy)} · ${s.signedBy.fingerprint}`}
                  </Text>
                )}
              </Pane>
            ))}
            {res.stamps && <Text size="xs" tone="muted">{t("info.stampedNote")}</Text>}
          </Pane>
        </InfoField>
      )}
      <InfoField label={t("info.modified")}>
        <Text size="sm" tabular>{`${dateTime(res.updatedAt)} · ${res.updatedBy}`}</Text>
      </InfoField>
      <InfoField label={t("info.created")}>
        <Text size="sm" tabular>{`${dateTime(res.createdAt)} · ${res.createdBy}`}</Text>
      </InfoField>
      <InfoField label={t("info.revision")}>
        <Text size="sm" tabular>{String(res.rev)}</Text>
      </InfoField>
      <ProposalsField resourceId={resourceId} />
      <RefsSection resourceId={resourceId} />
      <HistorySection resourceId={resourceId} readOnly={res.readOnly} stampLog={res.stampLog} />
    </>
  );

  return (
    <InfoPanel side={side} title={t("info.title")} label={t("info.title")} closeLabel={t("info.hide")} onClose={() => store.set({ infoOpen: false })}>
      {body}
    </InfoPanel>
  );
}

const splitTags = (text: string): string[] => text.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

/**
 * The info panel of a resource that is not saved yet (`new:<kind>`, D466: everything is a resource, so its basic
 * information is there from the start). Name, description and tags go into the tab's draft and are written with the
 * first save (the kernel takes `name`, `description` and `tags` from the changes when it creates the resource).
 */
export function NewInfoPanelPart({ tabId, descriptor, side }: { tabId: string; descriptor: PageDescriptor; side?: "left" | "right" }) {
  const { store, actions } = useWorkbench();
  const { t, tx, pageTitle } = useI18n();
  const draft = useUi((s) => s.drafts[tabId]);
  const name = typeof draft?.name === "string" ? draft.name : pageTitle(descriptor.title);
  const description = typeof draft?.description === "string" ? draft.description : "";
  const tags = Array.isArray(draft?.tags) ? (draft.tags as string[]) : [];
  const defaultEnv = typeof draft?.defaultEnv === "string" ? draft.defaultEnv : "";
  const envs = useQuery((c) => c.params.envOptions(), [], ["env", "tree:environments"]);
  const location = descriptor.breadcrumb.slice(0, -1).map((c) => pageTitle(c.label));
  return (
    <InfoPanel side={side} title={t("info.title")} label={t("info.title")} closeLabel={t("info.hide")} onClose={() => store.set({ infoOpen: false })}>
      <Text size="sm" tone="muted">
        {t("info.unsaved")}
      </Text>
      <InfoField label={t("info.name")}>
        <Input size="sm" aria-label={t("info.name")} value={name} onChange={(e) => actions.setDraft(tabId, "name", e.target.value, undefined)} />
      </InfoField>
      <InfoField label={t("info.location")}>
        <Text size="sm">{[t("info.root"), ...location].join(" / ")}</Text>
      </InfoField>
      {descriptor.kindLabel && (
        <InfoField label={t("info.kind")}>
          <Badge icon={descriptor.icon}>{tx(descriptor.kindLabel)}</Badge>
        </InfoField>
      )}
      <InfoField label={t("info.description")}>
        <Textarea rows={3} aria-label={t("info.description")} value={description} placeholder={t("info.descriptionPlaceholder")} onChange={(e) => actions.setDraft(tabId, "description", e.target.value, undefined)} />
      </InfoField>
      <InfoField label={t("info.tags")}>
        <Pane gap="xs">
          <Input
            key={tags.join("\n")}
            size="sm"
            aria-label={t("info.tags")}
            defaultValue={tags.join(", ")}
            placeholder={t("info.tagsPlaceholder")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => {
              const next = splitTags(e.currentTarget.value);
              if (next.join("\n") !== tags.join("\n")) actions.setDraft(tabId, "tags", next, undefined);
            }}
          />
          {tags.length > 0 && (
            <Pane direction="row" gap="xs" wrap>
              {tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </Pane>
          )}
        </Pane>
      </InfoField>
      {/* D473: chosen now, kept with the first save; empty = as its group or tree says. */}
      <DefaultEnvField
        value={defaultEnv}
        inheritedName={descriptor.defaultEnv ? envs.data?.find((e) => e.id === descriptor.defaultEnv)?.name : undefined}
        onChange={(env) => actions.setDraft(tabId, "defaultEnv", env === "" ? undefined : env, undefined)}
      />
    </InfoPanel>
  );
}
