import { useState } from "react";
import { Badge, Button, IconButton, InfoField, InfoPanel, Input, LoadingState, Pane, Switch, Text, Textarea, Tooltip, useToast } from "../../design";
import type { HistoryEntry, RefInfo } from "../protocol";
import { useI18n } from "../i18n";
import { useQuery, useWorkbench } from "../state/context";

const CLIP = 40;
const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP)}…` : text);

/** Collapsible change history of a resource, newest first, with restore per entry (§4.2). Read only while open. */
function HistorySection({ resourceId, readOnly }: { resourceId: string; readOnly: boolean }) {
  const { client, actions } = useWorkbench();
  const { t, dateTime } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const history = useQuery((c) => (open ? c.resource.history(resourceId) : Promise.resolve([] as HistoryEntry[])), [resourceId, open], [`resource:${resourceId}`]);
  const entries = history.data ?? [];
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
                </Pane>
                <Text size="xs" mono truncate>{`${clip(h.before)} → ${clip(h.after)}`}</Text>
                {!readOnly && (
                  <Pane direction="row">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="undo-2"
                      onClick={() => client.resource.restore(resourceId, h.id).then(() => toast({ tone: "success", title: t("history.restoredToast", { field: h.field, value: clip(h.before) }) }), actions.fail)}
                    >
                      {t("history.restore")}
                    </Button>
                  </Pane>
                )}
              </Pane>
            ))
          ))}
      </Pane>
    </InfoField>
  );
}

/** One reference: the other side opens on click; a deleted or broken one says so instead of disappearing (§10). */
function RefRow({ info, side }: { info: RefInfo; side: "outgoing" | "incoming" }) {
  const { actions } = useWorkbench();
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
        rows.map((r, i) => <RefRow key={`${r.source.id}-${r.field}-${i}`} info={r} side={side} />)
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

/** Frame-owned info about a resource (§9.3): name, location, description, tags, created / modified. */
export function InfoPanelPart({ resourceId }: { resourceId: string }) {
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
            <Text size="sm">{[t("info.root"), ...res.location].join(" / ")}</Text>
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
      {res.kind !== "core:env" && res.kind !== "core:config" && <AiVisibleSection id={resourceId} visible={Boolean(res.aiVisible)} group={res.kind === "core:group"} disabled={res.readOnly || res.deleted} />}
      {res.origin !== "original" && (
        <InfoField label={t("info.origin")}>
          <Text size="sm">{res.origin === "subscribed" ? t("info.subscribedFrom", { source: res.originRef ?? "" }) : t("info.copied")}</Text>
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
      <RefsSection resourceId={resourceId} />
      <HistorySection resourceId={resourceId} readOnly={res.readOnly} />
    </>
  );

  return (
    <InfoPanel title={t("info.title")} label={t("info.title")} closeLabel={t("info.hide")} onClose={() => store.set({ infoOpen: false })}>
      {body}
    </InfoPanel>
  );
}
