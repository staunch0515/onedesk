import { useState } from "react";
import { Badge, Banner, Button, Checkbox, DataGrid, Dialog, FormField, Input, KeyValueList, LoadingState, Pane, Section, Select, Switch, Text, TextLink, useToast, type ActionBarItem, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { Label, NamedRef, PageDescriptor, PluginPermission, PluginVersion } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";
import { SECRETS_TARGET } from "./secrets-page";

/** What the page is asking the user right now (all confirmations of the version table live here). */
type Ask =
  | { kind: "permissions"; version: string }
  | { kind: "remove"; version: string; resources: number }
  | { kind: "uninstall"; resources: number }
  | { kind: "undo"; count: number }
  | { kind: "pick"; batch: string; modified: NamedRef[]; chosen: string[] };

/** Plugin page (ui-spec §4, I.6): description, versions, enable switch, settings, permissions, what it provides, load status. */
export function PluginPage({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, actions } = useWorkbench();
  const { t, tx, dateTime, permission } = useI18n();
  const { toast } = useToast();
  const [ask, setAsk] = useState<Ask | null>(null);
  const id = tab.target.slice("plugin:".length);
  const plugin = useQuery((c) => c.plugin.get(id), [id], ["plugins"]);
  const p = plugin.data;
  if (!p) return <Frame tab={tab} descriptor={descriptor}>{plugin.loading ? <LoadingState label={t("common.loading")} /> : null}</Frame>;

  // Kernel plugins have real versions (switch, pin, remove, undo an upgrade) and a main-process installer; the demo's are fake.
  const real = client.demo !== undefined && !client.demo.target(descriptor.target);
  const installed = p.load.state !== "not-installed";
  const notYet = () => toast({ tone: "warning", title: t("common.notInPrototype") });
  const active = p.versions.find((v) => v.active);
  const hasFiles = p.permissions.some((x) => x.id === "files");
  const done = (text: string) => toast({ tone: "success", title: text });
  const activate = async (v: PluginVersion, confirmed = false) => {
    if (real && v.confirmed === false && !confirmed) return setAsk({ kind: "permissions", version: v.version });
    try {
      if (real && v.confirmed === false) await client.plugin.confirmPermissions(id, v.version);
      const result = await client.plugin.activateVersion(id, v.version);
      done(result.upgraded > 0 || result.kept > 0 ? t("plugin.upgraded", { version: v.version, upgraded: result.upgraded, kept: result.kept }) : t("plugin.activated", { version: v.version }));
    } catch (error) {
      actions.fail(error);
    }
  };
  const removeVersion = async (version: string) => {
    try {
      await client.app?.removePlugin(id, version);
      done(t("plugin.removed", { version }));
    } catch (error) {
      actions.fail(error);
    }
  };
  const undo = async (batch: string, also: string[] = []) => {
    try {
      const result = await client.plugin.undoUpgrade(batch, also);
      if (result.modified.length > 0 && also.length === 0) setAsk({ kind: "pick", batch, modified: result.modified, chosen: [] });
      else done(t("plugin.undone", { count: result.restored }));
    } catch (error) {
      actions.fail(error);
    }
  };
  const boundTotal = p.versions.reduce((n, v) => n + (v.resources ?? 0), 0);
  const items: ActionBarItem[] = [
    { key: "toggle", label: p.enabled ? t("plugin.disable") : t("plugin.enable"), icon: p.enabled ? "circle-slash" : "circle-check", primary: !p.enabled && installed, disabled: !installed, onSelect: () => client.plugin.setEnabled(id, !p.enabled).catch(actions.fail) },
    { key: "reload", label: t("plugin.reload"), icon: "rotate-cw", disabled: !installed || !p.enabled, onSelect: () => client.plugin.reload(id).then(() => toast({ tone: "success", title: t("plugin.reloaded") }), actions.fail) },
    ...(real ? [] : [{ key: "updates", label: t("plugin.checkUpdates"), icon: "cloud-download", onSelect: notYet }]),
    ...(real && p.permissions.some((x) => x.id === "secrets") ? [{ key: "secrets", label: t("secrets.title"), icon: "key-round", onSelect: () => actions.open(SECRETS_TARGET) }] : []),
    ...(real
      ? hasFiles
        ? [{ key: "grant", label: t("plugin.grantFolder"), icon: "folder-plus", disabled: !installed || !p.enabled, onSelect: () => void actions.command("plugin.grantFolder", { args: { plugin: id } }) }]
        : []
      : [{ key: "folder", label: t("plugin.openFolder"), icon: "folder-open", disabled: !installed, onSelect: notYet }]),
    ...(real
      ? client.app
        ? [{ key: "uninstall", label: t("plugin.uninstall"), icon: "trash-2", danger: true, disabled: !installed, onSelect: () => setAsk({ kind: "uninstall", resources: boundTotal }) }]
        : []
      : [{ key: "uninstall", label: t("plugin.uninstall"), icon: "trash-2", danger: true, disabled: !installed || p.builtin, onSelect: notYet }]),
  ];

  const versionColumns: Array<DataGridColumn<PluginVersion>> = [
    {
      key: "version",
      header: t("plugin.version"),
      width: 240,
      value: (v) => v.version,
      render: (v) => (
        <Pane direction="row" gap="xs" align="center">
          <Text mono size="sm">
            {v.version}
          </Text>
          {v.active && (
            <Badge tone="success" dot>
              {t("plugin.active")}
            </Badge>
          )}
          {v.pinned && (
            <Badge tone="accent" icon="pin">
              {t("plugin.pinned")}
            </Badge>
          )}
          {v.confirmed === false && <Badge tone="warning">{t("plugin.unconfirmed")}</Badge>}
        </Pane>
      ),
    },
    { key: "installed", header: t("plugin.installedAt"), width: 160, value: (v) => v.installedAt, render: (v) => (v.installedAt ? dateTime(v.installedAt) : "—") },
    ...(real ? [{ key: "resources", header: t("plugin.boundResources"), width: 120, numeric: true, value: (v: PluginVersion) => v.resources ?? 0 }] : []),
    { key: "notes", header: t("plugin.notes"), width: 380, value: (v) => v.notes },
    {
      key: "actions",
      header: "",
      width: real ? 330 : 232,
      sortable: false,
      resizable: false,
      render: (v: PluginVersion) => (
        <Pane direction="row" gap="xs" align="center" justify="end">
          {!v.active && (
            <Button size="sm" onClick={() => void activate(v)}>
              {t("plugin.activate")}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={v.pinned ? "pin-off" : "pin"} onClick={() => client.plugin.setPinned(id, v.version, !v.pinned).catch(actions.fail)}>
            {v.pinned ? t("plugin.unpin") : t("plugin.pin")}
          </Button>
          {real && client.app && (
            <Button size="sm" variant="ghost" icon="trash-2" onClick={() => setAsk({ kind: "remove", version: v.version, resources: v.resources ?? 0 })}>
              {t("plugin.removeVersion")}
            </Button>
          )}
        </Pane>
      ),
    },
  ];

  const permissionColumns: Array<DataGridColumn<PluginPermission>> = [
    { key: "label", header: t("plugin.permission"), width: 300, value: (x) => (x.label ? tx(x.label) : permission(x.id)) },
    { key: "detail", header: t("plugin.scope"), width: 360, mono: true, value: (x) => x.detail },
    { key: "required", header: t("plugin.required"), width: 120, value: (x) => (x.required ? 1 : 0), render: (x) => (x.required ? <Badge>{t("plugin.requiredYes")}</Badge> : <Text size="sm" tone="muted">{t("plugin.optional")}</Text>) },
    { key: "granted", header: t("plugin.granted"), width: 104, sortable: false, render: (x) => <Switch aria-label={x.label ? tx(x.label) : permission(x.id)} checked={x.granted} disabled={real} onCheckedChange={(on) => client.plugin.setPermission(id, x.id, on).catch(actions.fail)} /> },
  ];

  const badges = (labels: Label[]) =>
    labels.length === 0 ? (
      <Text tone="subtle" size="sm">
        —
      </Text>
    ) : (
      <Pane direction="row" gap="xs" wrap>
        {labels.map((l) => (
          <Badge key={tx(l)}>{tx(l)}</Badge>
        ))}
      </Pane>
    );
  const missingGrant = p.permissions.some((x) => x.required && !x.granted);

  const askDialog = (
    <Dialog
      open={ask !== null}
      onOpenChange={(open) => !open && setAsk(null)}
      size="md"
      title={
        ask?.kind === "permissions" ? t("plugin.confirmPermsTitle", { version: ask.version }) : ask?.kind === "remove" ? t("plugin.removeTitle", { version: ask.version }) : ask?.kind === "uninstall" ? t("plugin.uninstallTitle") : ask?.kind === "undo" ? t("plugin.undoTitle") : t("plugin.pickTitle")
      }
      description={
        ask?.kind === "remove" ? (ask.resources > 0 ? t("plugin.removeBound", { count: ask.resources }) : t("plugin.removeFree")) : ask?.kind === "uninstall" ? (ask.resources > 0 ? t("plugin.removeBound", { count: ask.resources }) : t("plugin.removeFree")) : ask?.kind === "undo" ? t("plugin.undoBody", { count: ask.count }) : ask?.kind === "pick" ? t("plugin.pickBody") : undefined
      }
      footer={
        <>
          <Button onClick={() => setAsk(null)}>{t("common.cancel")}</Button>
          <Button
            variant={ask?.kind === "permissions" || ask?.kind === "pick" || ask?.kind === "undo" ? "primary" : "danger"}
            onClick={() => {
              const current = ask;
              setAsk(null);
              if (!current) return;
              if (current.kind === "permissions") void activate(p.versions.find((v) => v.version === current.version)!, true);
              else if (current.kind === "remove") void removeVersion(current.version);
              else if (current.kind === "uninstall") void (async () => { for (const v of p.versions) await removeVersion(v.version); })();
              else if (current.kind === "undo") void undo(p.lastUpgrade!.batch);
              else void undo(current.batch, current.chosen);
            }}
          >
            {ask?.kind === "permissions" ? t("plugin.confirmPermsOk") : ask?.kind === "remove" || ask?.kind === "uninstall" ? t("plugin.removeVersion") : ask?.kind === "undo" ? t("plugin.undoUpgrade") : t("plugin.pickOk")}
          </Button>
        </>
      }
    >
      {ask?.kind === "permissions" && (
        <Pane gap="xs">
          {p.permissions.map((x) => (
            <Pane key={x.id} direction="row" gap="sm" align="center" wrap>
              <Text size="sm" weight="medium">{x.label ? tx(x.label) : permission(x.id)}</Text>
              {x.detail && <Text size="xs" tone="muted" mono>{x.detail}</Text>}
            </Pane>
          ))}
        </Pane>
      )}
      {ask?.kind === "pick" && (
        <Pane gap="xs">
          {ask.modified.map((m) => (
            <Checkbox key={m.id} label={m.name} checked={ask.chosen.includes(m.id)} onCheckedChange={(on) => setAsk({ ...ask, chosen: on ? [...ask.chosen, m.id] : ask.chosen.filter((x) => x !== m.id) })} />
          ))}
        </Pane>
      )}
    </Dialog>
  );

  return (
    <>
    <Frame
      tab={tab}
      descriptor={descriptor}
      actions={items}
      meta={
        <>
          {active && <Badge>{`v${active.version}`}</Badge>}
          {p.builtin && <Badge tone="info">{t("plugin.builtin")}</Badge>}
          {p.load.state === "loaded" && (
            <Badge tone="success" dot>
              {t("plugin.loaded")}
            </Badge>
          )}
        </>
      }
    >
      <Pane grow scroll pad="md" gap="md">
        <Section title={t("plugin.about")}>
          <Pane gap="md">
            <Text as="p">{tx(p.description)}</Text>
            <KeyValueList
              items={[
                { key: "id", label: t("plugin.id"), value: <Text mono size="sm">{p.id}</Text> },
                { key: "author", label: t("plugin.author"), value: p.author },
                { key: "license", label: t("plugin.license"), value: p.license },
                { key: "home", label: t("plugin.homepage"), value: <TextLink href={p.homepage} external onOpen={notYet}>{p.homepage}</TextLink> },
                { key: "count", label: t("plugin.resources"), value: String(p.resourceCount) },
              ]}
            />
          </Pane>
        </Section>

        <Section title={t("plugin.status")}>
          <Pane gap="md">
            {p.load.state === "loaded" && (
              <Banner tone="success" title={p.load.ms === undefined ? t("plugin.loadOkPlain") : t("plugin.loadOk", { ms: p.load.ms })}>
                {missingGrant ? t("plugin.missingGrant") : undefined}
              </Banner>
            )}
            {p.load.state === "disabled" && <Banner tone="info" title={t("plugin.loadDisabled")}>{t("plugin.loadDisabledHint", { count: p.resourceCount })}</Banner>}
            {p.load.state === "error" && (
              <Banner tone="danger" title={t("plugin.loadError")} actions={<Button size="sm" onClick={() => client.plugin.reload(id).catch(actions.fail)}>{t("plugin.retry")}</Button>}>
                {p.load.message}
              </Banner>
            )}
            {p.load.state === "not-installed" && <Banner tone="warning" title={t("plugin.notInstalled")} actions={<Button size="sm" variant="primary" onClick={notYet}>{t("plugin.install")}</Button>}>{t("plugin.notInstalledHint", { count: p.resourceCount })}</Banner>}
            <Switch label={t("plugin.enabledSwitch")} description={t("plugin.enabledHint")} checked={p.enabled} disabled={!installed} onCheckedChange={(on) => client.plugin.setEnabled(id, on).catch(actions.fail)} />
          </Pane>
        </Section>

        {p.versions.length > 0 && (
          <Section title={t("plugin.versions")} description={t("plugin.versionsHint")}>
            {real && p.lastUpgrade && (
              <Banner tone="info" title={t("plugin.lastUpgrade", { count: p.lastUpgrade.count })} actions={<Button size="sm" onClick={() => setAsk({ kind: "undo", count: p.lastUpgrade!.count })}>{t("plugin.undoUpgrade")}</Button>} />
            )}
            <DataGrid label={t("plugin.versions")} size="regular" framed autoHeight columns={versionColumns} rows={p.versions} getRowKey={(v) => v.version} nullText="" />
          </Section>
        )}

        {p.settings.length > 0 && (
          <Section title={t("plugin.settings")} description={t("plugin.settingsHint")}>
            <Pane gap="md" width="form">
              {p.settings.map((s) =>
                s.kind === "boolean" ? (
                  <Switch key={s.name} label={tx(s.label)} description={s.hint ? tx(s.hint) : undefined} checked={s.value === "true"} onCheckedChange={(on) => client.plugin.setSetting(id, s.name, on ? "true" : "false").catch(actions.fail)} />
                ) : (
                  <FormField key={s.name} label={tx(s.label)} description={s.hint ? tx(s.hint) : undefined}>
                    {s.kind === "enum" ? (
                      <Select value={s.value} options={(s.options ?? []).map((o) => ({ value: o.value, label: tx(o.label) }))} onValueChange={(v) => client.plugin.setSetting(id, s.name, v).catch(actions.fail)} />
                    ) : (
                      <Input
                        key={s.value}
                        defaultValue={s.value}
                        inputMode={s.kind === "number" ? "decimal" : undefined}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        onBlur={(e) => {
                          if (e.currentTarget.value !== s.value) client.plugin.setSetting(id, s.name, e.currentTarget.value).catch(actions.fail);
                        }}
                      />
                    )}
                  </FormField>
                ),
              )}
            </Pane>
          </Section>
        )}

        {real && (
          <Section title={t("plugin.folders")} description={t("plugin.foldersHint")}>
            {p.folders.length === 0 ? (
              <Text size="sm" tone="muted">
                {t("plugin.foldersNone")}
              </Text>
            ) : (
              <Pane gap="xs">
                {p.folders.map((f) => (
                  <Pane key={f} direction="row" gap="sm" align="center">
                    <Pane grow>
                      <Text mono size="sm" truncate>
                        {f}
                      </Text>
                    </Pane>
                    <Button size="sm" variant="ghost" icon="x" onClick={() => client.plugin.revokeFolder(id, f).then(() => undefined, actions.fail)}>
                      {t("plugin.folderRemove")}
                    </Button>
                  </Pane>
                ))}
              </Pane>
            )}
          </Section>
        )}

        {p.permissions.length > 0 && (
          <Section title={t("plugin.permissions")} description={t("plugin.permissionsHint")}>
            <DataGrid label={t("plugin.permissions")} size="regular" framed autoHeight columns={permissionColumns} rows={p.permissions} getRowKey={(x) => x.id} nullText="" />
          </Section>
        )}

        <Section title={t("plugin.provides")}>
          <KeyValueList
            items={[
              { key: "kinds", label: t("plugin.kinds"), value: badges(p.provides.kinds) },
              { key: "actions", label: t("plugin.actions"), value: badges(p.provides.actions) },
              { key: "trees", label: t("plugin.trees"), value: badges(p.provides.trees) },
              { key: "tabs", label: t("plugin.resultTabs"), value: badges(p.provides.resultTabs) },
              { key: "other", label: t("plugin.other"), value: badges(p.provides.other) },
            ]}
          />
        </Section>
      </Pane>
    </Frame>
    {askDialog}
    </>
  );
}
