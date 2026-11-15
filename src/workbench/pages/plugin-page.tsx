import { Badge, Banner, Button, DataGrid, FormField, Input, KeyValueList, LoadingState, Pane, Section, Select, Switch, Text, TextLink, useToast, type ActionBarItem, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { Label, PageDescriptor, PluginPermission, PluginVersion } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

/** Plugin page (ui-spec §4, I.6): description, versions, enable switch, settings, permissions, what it provides, load status. */
export function PluginPage({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, actions } = useWorkbench();
  const { t, tx, dateTime } = useI18n();
  const { toast } = useToast();
  const id = tab.target.slice("plugin:".length);
  const plugin = useQuery((c) => c.plugin.get(id), [id], ["plugins"]);
  const p = plugin.data;
  if (!p) return <Frame tab={tab} descriptor={descriptor}>{plugin.loading ? <LoadingState label={t("common.loading")} /> : null}</Frame>;

  const installed = p.load.state !== "not-installed";
  const notYet = () => toast({ tone: "warning", title: t("common.notInPrototype") });
  const active = p.versions.find((v) => v.active);
  const items: ActionBarItem[] = [
    { key: "toggle", label: p.enabled ? t("plugin.disable") : t("plugin.enable"), icon: p.enabled ? "circle-slash" : "circle-check", primary: !p.enabled && installed, disabled: !installed, onSelect: () => client.plugin.setEnabled(id, !p.enabled).catch(actions.fail) },
    { key: "reload", label: t("plugin.reload"), icon: "rotate-cw", disabled: !installed || !p.enabled, onSelect: () => client.plugin.reload(id).then(() => toast({ tone: "success", title: t("plugin.reloaded") }), actions.fail) },
    { key: "updates", label: t("plugin.checkUpdates"), icon: "cloud-download", onSelect: notYet },
    { key: "folder", label: t("plugin.openFolder"), icon: "folder-open", disabled: !installed, onSelect: notYet },
    { key: "uninstall", label: t("plugin.uninstall"), icon: "trash-2", danger: true, disabled: !installed || p.builtin, onSelect: notYet },
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
        </Pane>
      ),
    },
    { key: "installed", header: t("plugin.installedAt"), width: 160, value: (v) => v.installedAt, render: (v) => dateTime(v.installedAt) },
    { key: "notes", header: t("plugin.notes"), width: 380, value: (v) => v.notes },
    {
      key: "actions",
      header: "",
      width: 232,
      sortable: false,
      resizable: false,
      render: (v) => (
        <Pane direction="row" gap="xs" align="center" justify="end">
          {!v.active && (
            <Button size="sm" onClick={() => client.plugin.activateVersion(id, v.version).then(() => toast({ tone: "success", title: t("plugin.activated", { version: v.version }) }), actions.fail)}>
              {t("plugin.activate")}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={v.pinned ? "pin-off" : "pin"} onClick={() => client.plugin.setPinned(id, v.version, !v.pinned).catch(actions.fail)}>
            {v.pinned ? t("plugin.unpin") : t("plugin.pin")}
          </Button>
        </Pane>
      ),
    },
  ];

  const permissionColumns: Array<DataGridColumn<PluginPermission>> = [
    { key: "label", header: t("plugin.permission"), width: 300, value: (x) => tx(x.label) },
    { key: "detail", header: t("plugin.scope"), width: 360, mono: true, value: (x) => x.detail },
    { key: "required", header: t("plugin.required"), width: 120, value: (x) => (x.required ? 1 : 0), render: (x) => (x.required ? <Badge>{t("plugin.requiredYes")}</Badge> : <Text size="sm" tone="muted">{t("plugin.optional")}</Text>) },
    { key: "granted", header: t("plugin.granted"), width: 104, sortable: false, render: (x) => <Switch aria-label={tx(x.label)} checked={x.granted} onCheckedChange={(on) => client.plugin.setPermission(id, x.id, on).catch(actions.fail)} /> },
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

  return (
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
              <Banner tone="success" title={t("plugin.loadOk", { ms: p.load.ms ?? 0 })}>
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
  );
}
