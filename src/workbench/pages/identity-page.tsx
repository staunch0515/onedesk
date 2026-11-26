import { useEffect, useState, type ReactNode } from "react";
import { Badge, Banner, Button, Dialog, FormField, Input, LoadingState, Pane, Section, Switch, Text } from "../../design";
import { useI18n } from "../i18n";
import type { PageDescriptor, Resource } from "../protocol";
import type { SignedBy } from "../protocol/generated";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

export const IDENTITY_TARGET = "shell:identity";

/** The frame wants a descriptor; this page belongs to the shell, so it makes its own. */
export function identityDescriptor(title: string): PageDescriptor {
  return { target: IDENTITY_TARGET, title, icon: "fingerprint", found: true, state: "ok", breadcrumb: [{ label: title, icon: "fingerprint" }], page: "view", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as PageDescriptor;
}

/** Who signed, in words: oneself, a contact (checked or not), or someone not in the contacts. */
export function signedByText(t: ReturnType<typeof useI18n>["t"], s: SignedBy): string {
  if (s.known === "self") return t("identity.bySelf", { name: s.name });
  if (s.known === "checked") return t("identity.byChecked", { name: s.name });
  if (s.known === "unchecked") return t("identity.byUnchecked", { name: s.name });
  return t("identity.byUnknown", { name: s.name });
}

/** A file path: the system dialog when there is one, else typed (the browser preview). */
function PathAsk({ open, title, onPath, onClose }: { open: boolean; title: string; onPath: (path: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!path.trim().startsWith("/")} onClick={() => onPath(path.trim())}>
            {t("identity.use")}
          </Button>
        </>
      }
    >
      <FormField label={t("identity.path")}>
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/…/card.odid" />
      </FormField>
    </Dialog>
  );
}

/** Asks for a path to write `name` to: the save dialog, else typed. */
function useSavePath(): { ask: (name: string, then: (path: string) => void) => void; dialog: ReactNode } {
  const { client } = useWorkbench();
  const { t } = useI18n();
  const [pending, setPending] = useState<((path: string) => void) | null>(null);
  const ask = (name: string, then: (path: string) => void) => {
    const pick = client.platform?.pickSaveFile;
    if (pick) void pick(name).then((p) => p && then(p));
    else setPending(() => then);
  };
  return {
    ask,
    dialog: (
      <PathAsk
        open={pending !== null}
        title={t("identity.saveTo")}
        onClose={() => setPending(null)}
        onPath={(p) => {
          pending?.(p);
          setPending(null);
        }}
      />
    ),
  };
}

/** Imports an identity card: the open dialog, else typed; then opens the contact. */
export function useImportCard(): { start: () => void; dialog: ReactNode } {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const go = (path: string) =>
    client.contact
      ?.importCard(path)
      .then((r) => actions.open(`resource:${r.id}`))
      .catch(actions.fail);
  return {
    start: () => {
      const pick = client.platform?.pickIdentityCard;
      if (pick)
        void pick().then((p) => {
          if (p) void go(p);
        });
      else setAsking(true);
    },
    dialog: (
      <PathAsk
        open={asking}
        title={t("identity.importCard")}
        onClose={() => setAsking(false)}
        onPath={(p) => {
          setAsking(false);
          void go(p);
        }}
      />
    ),
  };
}

/** D487 §33: this workspace's identity — make it, see its fingerprint, give its card, rename or delete it. */
export function IdentityPage({ tab }: { tab: TabState }) {
  const { client, actions } = useWorkbench();
  const { t, dateTime } = useI18n();
  const q = useQuery((c) => (c.identity ? c.identity.get() : Promise.resolve(null)), [], ["identity"]);
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [confirm, setConfirm] = useState(false);
  const save = useSavePath();
  const importer = useImportCard();
  const id = q.data;
  useEffect(() => {
    setName(id?.name ?? "");
    setOrg(id?.org ?? "");
  }, [id?.name, id?.org]);
  const descriptor = identityDescriptor(t("identity.title"));
  const run = (p: Promise<unknown> | undefined) => p?.then(() => q.reload(), actions.fail);

  return (
    <Frame tab={tab} descriptor={descriptor}>
      <Pane grow scroll pad="lg" gap="lg" width="form">
        {q.data === undefined ? (
          <LoadingState layout="inline" label={t("common.loading")} />
        ) : !id ? (
          <Section title={t("identity.none")} description={t("identity.noneHint")}>
            <Pane gap="md">
              <FormField label={t("identity.name")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </FormField>
              <FormField label={t("identity.org")}>
                <Input value={org} onChange={(e) => setOrg(e.target.value)} />
              </FormField>
              <Pane direction="row">
                <Button variant="primary" icon="fingerprint" disabled={!name.trim()} onClick={() => run(client.identity?.create({ name: name.trim(), org: org.trim() }))}>
                  {t("identity.create")}
                </Button>
              </Pane>
            </Pane>
          </Section>
        ) : (
          <Section title={t("identity.mine")} description={t("identity.mineHint")}>
            <Pane gap="md">
              <FormField label={t("identity.name")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== id.name && run(client.identity?.update({ name: name.trim() }))} />
              </FormField>
              <FormField label={t("identity.org")}>
                <Input value={org} onChange={(e) => setOrg(e.target.value)} onBlur={() => org.trim() !== id.org && run(client.identity?.update({ org: org.trim() }))} />
              </FormField>
              <FormField label={t("identity.fingerprint")} description={t("identity.fingerprintHint")}>
                <Text size="lg" mono>
                  {id.fingerprint}
                </Text>
              </FormField>
              <Text size="sm" tone="muted">
                {t("identity.since", { at: dateTime(id.createdAt) })}
              </Text>
              <Pane direction="row" gap="sm">
                <Button icon="download" onClick={() => save.ask(`${id.name}.odid`, (p) => void client.identity?.exportCard(p).catch(actions.fail))}>
                  {t("identity.exportCard")}
                </Button>
                <Button variant="ghost" icon="trash-2" onClick={() => setConfirm(true)}>
                  {t("identity.delete")}
                </Button>
              </Pane>
            </Pane>
          </Section>
        )}
        <Section title={t("identity.contacts")} description={t("identity.contactsHint")}>
          <Pane direction="row">
            <Button icon="user-plus" onClick={importer.start}>
              {t("identity.importCard")}
            </Button>
          </Pane>
        </Section>
      </Pane>
      <Dialog
        open={confirm}
        onOpenChange={(o) => !o && setConfirm(false)}
        size="sm"
        title={t("identity.deleteTitle")}
        description={t("identity.deleteBody")}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(false);
                run(client.identity?.delete());
              }}
            >
              {t("identity.delete")}
            </Button>
          </>
        }
      />
      {save.dialog}
      {importer.dialog}
    </Frame>
  );
}

/** D487 §33: one contact — whose card, its fingerprint to compare, whether it was checked. */
export function ContactPage({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const id = descriptor.resourceId ?? "";
  const q = useQuery((c) => c.resource.get(id), [id], [`resource:${id}`]);
  const [asking, setAsking] = useState(false);
  const save = useSavePath();
  const r = q.data as Resource | null | undefined;
  const body = (r?.body ?? {}) as Record<string, unknown>;
  const checked = body.checked === true;
  const fp = String(body.fingerprint ?? "");
  const set = (on: boolean) => client.contact?.setChecked(id, on).then(() => q.reload(), actions.fail);
  return (
    <Frame tab={tab} descriptor={descriptor}>
      <Pane grow scroll pad="lg" gap="lg" width="form">
        {!r ? (
          <LoadingState layout="inline" label={t("common.loading")} />
        ) : (
          <Section
            title={
              <Pane direction="row" gap="xs" align="center">
                <Text weight="semibold">{r.name}</Text>
                {checked ? <Badge tone="success" icon="badge-check">{t("contact.checked")}</Badge> : <Badge tone="warning">{t("contact.unchecked")}</Badge>}
              </Pane>
            }
            description={String(body.org ?? "")}
          >
            <Pane gap="md">
              <FormField label={t("identity.fingerprint")} description={t("contact.compareHint", { name: r.name })}>
                <Text size="xl" mono>
                  {fp}
                </Text>
              </FormField>
              <Text size="sm" tone="muted">
                {t(body.source === "package" ? "contact.fromPackage" : "contact.fromCard")}
              </Text>
              <Switch checked={checked} label={t("contact.checkedSwitch")} description={t("contact.checkedHint")} onCheckedChange={(on) => (on ? setAsking(true) : void set(false))} />
              {Boolean(body.card) && (
                <Pane direction="row">
                  <Button icon="download" onClick={() => save.ask(`${r.name}.odid`, (p) => void client.contact?.exportCard(id, p).catch(actions.fail))}>
                    {t("identity.exportCard")}
                  </Button>
                </Pane>
              )}
              {!checked && <Banner tone="info">{t("contact.whyCheck")}</Banner>}
            </Pane>
          </Section>
        )}
      </Pane>
      <Dialog
        open={asking}
        onOpenChange={(o) => !o && setAsking(false)}
        size="sm"
        title={t("contact.confirmTitle")}
        description={t("contact.confirmBody", { name: r?.name ?? "", fingerprint: fp })}
        footer={
          <>
            <Button onClick={() => setAsking(false)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                void set(true);
              }}
            >
              {t("contact.confirmOk")}
            </Button>
          </>
        }
      />
      {save.dialog}
    </Frame>
  );
}
