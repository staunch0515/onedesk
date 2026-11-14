/**
 * Plugins: one row per plugin (icon, name, version, origin, resource count, enable switch), settings drawer,
 * uninstall (external only, D16) with the secret question (D53), reinstall (D90), and load errors.
 */
import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  Drawer,
  EmptyState,
  Icon,
  Page,
  PageBody,
  PageHeader,
  Section,
  Stack,
  Switch,
  Table,
  Text,
  useToast,
  type TableColumn,
} from "../../design";
import type { PluginInfo, PluginLoadError } from "../../kernel/contracts";
import { errorInfo } from "../format";
import { useAsync, useKernelTick } from "../hooks";
import { t } from "../i18n";
import { initialValues, validateValues, valuesToData, type FormValue, type FormValues } from "../schema-form";
import { SchemaFields } from "../schema-fields";
import { useShell } from "../shell-context";

export function PluginLoadErrors({ errors }: { errors: PluginLoadError[] }) {
  const columns: Array<TableColumn<PluginLoadError & { key: string }>> = [
    {
      key: "origin",
      header: t("plugins.col.origin"),
      width: "sm",
      render: (e) => <Badge>{e.origin === "builtin" ? t("plugins.origin.builtin") : t("plugins.origin.external")}</Badge>,
    },
    { key: "location", header: t("plugins.col.location"), mono: true, render: (e) => (e.pluginId ? `${e.pluginId} · ${e.location}` : e.location) },
    { key: "reason", header: t("plugins.col.reason"), render: (e) => <Text tone="danger">{e.reason}</Text> },
  ];
  return (
    <Table
      columns={columns}
      rows={errors.map((e, i) => ({ ...e, key: `${i}` }))}
      getRowKey={(e) => e.key}
      label={t("plugins.errorsTitle")}
      empty={<EmptyState layout="inline" icon="circle-check" message={t("plugins.errorsEmpty")} />}
    />
  );
}

function SettingsDrawer({ plugin, onClose }: { plugin: PluginInfo | null; onClose: () => void }) {
  const { kernel } = useShell();
  const { toast } = useToast();
  const fields = plugin?.manifest.settings ?? [];
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!plugin) return;
    setErrors({});
    setLoadError(null);
    kernel.plugins.getSettings(plugin.manifest.id).then(
      (stored) => setValues(initialValues(plugin.manifest.settings, stored, true)),
      (e: unknown) => setLoadError(errorInfo(e).message),
    );
  }, [plugin, kernel]);

  const save = async () => {
    if (!plugin) return;
    const next = validateValues(fields, values);
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      await kernel.plugins.setSettings(plugin.manifest.id, valuesToData(fields, values));
      toast({ title: t("plugins.settingsSaved"), tone: "success" });
      onClose();
    } catch (e) {
      const info = errorInfo(e);
      if (info.fields) setErrors(info.fields);
      else setLoadError(info.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={plugin !== null}
      onOpenChange={(open) => !open && onClose()}
      title={plugin ? t("plugins.settingsTitle", { name: plugin.manifest.name }) : ""}
      description={plugin?.manifest.description || undefined}
      closeLabel={t("common.close")}
      footer={
        fields.length ? (
          <>
            <DialogClose>
              <Button disabled={saving}>{t("common.cancel")}</Button>
            </DialogClose>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </>
        ) : undefined
      }
    >
      <Stack gap="md">
        {loadError && <Banner tone="danger">{loadError}</Banner>}
        {fields.length === 0 ? (
          <EmptyState layout="inline" message={t("plugins.noSettings")} />
        ) : (
          <SchemaFields fields={fields} values={values} errors={errors} onChange={(n: string, v: FormValue) => setValues((s) => ({ ...s, [n]: v }))} />
        )}
      </Stack>
    </Drawer>
  );
}

function UninstallDialog({ plugin, onClose }: { plugin: PluginInfo | null; onClose: () => void }) {
  const { kernel } = useShell();
  const { toast } = useToast();
  const [deleteSecrets, setDeleteSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secretNames, setSecretNames] = useState<string[]>([]);

  useEffect(() => {
    if (!plugin) return;
    setDeleteSecrets(false);
    // Only names this plugin declared that no other installed plugin declares (D53), and that exist.
    const others = new Set(kernel.plugins.list().filter((p) => p.manifest.id !== plugin.manifest.id).flatMap((p) => p.manifest.requires.secrets));
    void kernel.secrets.list().then(
      (stored) => setSecretNames(plugin.manifest.requires.secrets.filter((n) => !others.has(n) && stored.includes(n))),
      () => setSecretNames([]),
    );
  }, [plugin, kernel]);

  const uninstall = async () => {
    if (!plugin) return;
    setBusy(true);
    try {
      const { declaredSecrets } = await kernel.plugins.uninstall(plugin.manifest.id);
      if (deleteSecrets) for (const name of declaredSecrets.filter((n) => secretNames.includes(n))) await kernel.secrets.delete(name);
      toast({ title: t("plugins.uninstalled", { name: plugin.manifest.name }), tone: "success" });
      onClose();
    } catch (e) {
      const info = errorInfo(e);
      toast({ title: info.message, description: info.hint, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={plugin !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={plugin ? t("plugins.uninstallTitle", { name: plugin.manifest.name }) : ""}
      description={t("plugins.uninstallBody")}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <DialogClose>
            <Button disabled={busy}>{t("common.cancel")}</Button>
          </DialogClose>
          <Button variant="danger" loading={busy} onClick={() => void uninstall()}>
            {t("plugins.uninstall")}
          </Button>
        </>
      }
    >
      {secretNames.length > 0 ? (
        <Checkbox label={t("plugins.uninstallSecrets", { names: secretNames.join("、") })} checked={deleteSecrets} onCheckedChange={setDeleteSecrets} />
      ) : undefined}
    </Dialog>
  );
}

export function PluginsPage() {
  const { kernel, services } = useShell();
  const { toast } = useToast();
  const tick = useKernelTick(kernel, ["plugin.changed", "resource.created", "resource.deleted"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<PluginInfo | null>(null);
  const [uninstalling, setUninstalling] = useState<PluginInfo | null>(null);
  const status = useAsync(() => services.status(), [services]);
  // Plugin state is synchronous in the kernel; the tick re-renders on changes.
  void tick;
  const plugins = kernel.plugins.list();
  const loadErrors = kernel.plugins.loadErrors();
  const uninstalled = kernel.plugins.uninstalled();

  const toggle = async (p: PluginInfo, enable: boolean) => {
    setBusy(p.manifest.id);
    try {
      if (enable) await kernel.plugins.enable(p.manifest.id);
      else await kernel.plugins.disable(p.manifest.id);
      toast({ title: t(enable ? "plugins.enabledToast" : "plugins.disabledToast", { name: p.manifest.name }), tone: "success" });
    } catch (e) {
      const info = errorInfo(e);
      toast({ title: t("plugins.toggleFailed", { name: p.manifest.name }), description: info.message, tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const reinstall = async (id: string, name: string) => {
    try {
      await kernel.plugins.reinstall(id);
      toast({ title: t("plugins.reinstalled", { name }), tone: "success" });
    } catch (e) {
      const info = errorInfo(e);
      toast({ title: info.message, description: info.hint, tone: "danger" });
    }
  };

  const columns: Array<TableColumn<PluginInfo>> = [
    {
      key: "name",
      header: t("plugins.col.name"),
      render: (p) => (
        <Stack direction="row" gap="sm" align="center">
          <Icon name={p.manifest.icon} size="md" />
          <Text weight="medium" tone={p.state === "disabled" ? "subtle" : "default"}>
            {p.manifest.name}
          </Text>
          {p.activationError ? (
            <Text size="sm" tone="danger" truncate>
              {t("plugins.activationError", { reason: p.activationError })}
            </Text>
          ) : (
            <Text size="sm" tone="muted" truncate>
              {p.manifest.description || p.manifest.id}
            </Text>
          )}
        </Stack>
      ),
    },
    { key: "version", header: t("plugins.col.version"), width: "sm", numeric: true, render: (p) => p.manifest.version },
    {
      key: "origin",
      header: t("plugins.col.origin"),
      width: "sm",
      render: (p) => <Badge>{p.origin === "builtin" ? t("plugins.origin.builtin") : t("plugins.origin.external")}</Badge>,
    },
    {
      key: "resources",
      header: t("plugins.col.resources"),
      width: "md",
      numeric: true,
      render: (p) => (p.state === "disabled" && p.resourceCount > 0 ? t("plugins.kept", { count: p.resourceCount }) : String(p.resourceCount)),
    },
    {
      key: "state",
      header: t("plugins.col.state"),
      width: "md",
      render: (p) => (
        <Stack direction="row" gap="sm" align="center">
          <Switch
            aria-label={t("plugins.toggle", { name: p.manifest.name })}
            checked={p.state === "enabled"}
            disabled={busy === p.manifest.id}
            onCheckedChange={(on) => void toggle(p, on)}
          />
          <Text size="sm" tone={p.state === "enabled" ? "default" : "muted"}>
            {p.state === "enabled" ? t("plugins.enabled") : t("plugins.disabled")}
          </Text>
        </Stack>
      ),
    },
    {
      key: "actions",
      header: t("plugins.col.actions"),
      width: "md",
      align: "end",
      render: (p) => (
        <Stack direction="row" gap="xs" justify="end">
          {p.manifest.settings.length > 0 && (
            <Button size="sm" variant="ghost" icon="settings" onClick={() => setSettingsFor(p)}>
              {t("plugins.settings")}
            </Button>
          )}
          {p.origin === "external" && (
            <Button size="sm" variant="ghost" icon="trash-2" onClick={() => setUninstalling(p)}>
              {t("plugins.uninstall")}
            </Button>
          )}
        </Stack>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader icon="puzzle" title={t("plugins.title")} description={t("plugins.description")} />
      <PageBody width="full">
        <Stack gap="lg">
          <Table
            columns={columns}
            rows={plugins}
            getRowKey={(p) => p.manifest.id}
            label={t("plugins.tableLabel")}
            isRowMuted={(p) => p.state === "disabled"}
            empty={<EmptyState layout="inline" message={t("plugins.empty")} />}
          />
          {status.data && services.mode === "tauri" && (
            <Text size="sm" tone="muted" as="p">
              {t("plugins.externalHint", { dir: status.data.dataDir })}
            </Text>
          )}
          {uninstalled.length > 0 && (
            <Section title={t("plugins.uninstalledTitle")} description={t("plugins.uninstalledDescription")}>
              <Table
                columns={[
                  { key: "name", header: t("plugins.col.name") },
                  { key: "location", header: t("plugins.col.location"), mono: true },
                  {
                    key: "actions",
                    header: t("plugins.col.actions"),
                    width: "md",
                    align: "end",
                    render: (u: { id: string; name: string; location: string }) => (
                      <Button size="sm" icon="rotate-ccw" onClick={() => void reinstall(u.id, u.name)}>
                        {t("plugins.reinstall")}
                      </Button>
                    ),
                  },
                ]}
                rows={uninstalled}
                getRowKey={(u) => u.id}
                label={t("plugins.uninstalledTitle")}
              />
            </Section>
          )}
          <Section title={t("plugins.errorsTitle")} description={t("plugins.errorsDescription")}>
            <PluginLoadErrors errors={loadErrors} />
          </Section>
        </Stack>
      </PageBody>
      <SettingsDrawer plugin={settingsFor} onClose={() => setSettingsFor(null)} />
      <UninstallDialog plugin={uninstalling} onClose={() => setUninstalling(null)} />
    </Page>
  );
}
