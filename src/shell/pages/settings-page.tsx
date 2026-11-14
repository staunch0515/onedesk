/** Settings: appearance (theme, density), data (status, snapshots, export, import), secrets, plugin load errors. */
import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Dialog,
  DialogClose,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  Input,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  Section,
  Select,
  Stack,
  Table,
  Text,
  TextLink,
  useTheme,
  useToast,
  type Density,
  type ThemePreference,
} from "../../design";
import type { ImportPlan } from "../../kernel/contracts";
import { errorInfo, formatDateTime, snapshotTime } from "../format";
import { useAsync, useKernelTick } from "../hooks";
import { t } from "../i18n";
import { useShell } from "../shell-context";
import { PluginLoadErrors } from "./plugins-page";

function Appearance() {
  const { theme, density, setTheme, setDensity } = useTheme();
  return (
    <Section title={t("settings.appearance")}>
      <Stack direction="row" gap="lg" wrap>
        <FormField label={t("settings.theme")}>
          <Select
            value={theme}
            onValueChange={(v) => setTheme(v as ThemePreference)}
            options={[
              { value: "system", label: t("settings.theme.system"), icon: "monitor" },
              { value: "light", label: t("settings.theme.light"), icon: "sun" },
              { value: "dark", label: t("settings.theme.dark"), icon: "moon" },
            ]}
          />
        </FormField>
        <FormField label={t("settings.density")}>
          <Select
            value={density}
            onValueChange={(v) => setDensity(v as Density)}
            options={[
              { value: "comfortable", label: t("settings.density.comfortable") },
              { value: "compact", label: t("settings.density.compact") },
            ]}
          />
        </FormField>
      </Stack>
    </Section>
  );
}

function InfoRow({ label, children }: { label: string; children: string }) {
  return (
    <Stack gap="xs">
      <Text size="sm" tone="muted">
        {label}
      </Text>
      <Text mono>{children}</Text>
    </Stack>
  );
}

type Decision = "overwrite" | "skip";
interface ConflictRow {
  key: string;
  type: "resource" | "collection";
  id: string;
  name: string;
  existing: string;
  incoming: string;
}

function conflictRows(plan: ImportPlan): ConflictRow[] {
  return [
    ...plan.conflicts.map((c) => ({
      key: `resource:${c.incoming.id}`,
      type: "resource" as const,
      id: c.incoming.id,
      name: c.incoming.name,
      existing: formatDateTime(c.existing.updatedAt),
      incoming: formatDateTime(c.incoming.updatedAt),
    })),
    ...plan.collectionConflicts.map((c) => ({
      key: `collection:${c.incoming.id}`,
      type: "collection" as const,
      id: c.incoming.id,
      name: c.incoming.name,
      existing: formatDateTime(c.existing.createdAt),
      incoming: formatDateTime(c.incoming.createdAt),
    })),
  ];
}

function ImportDialog({ plan, onClose, onApply }: { plan: ImportPlan | null; onClose: () => void; onApply: (decisions: Record<string, Decision>) => Promise<void> }) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState(false);
  const rows = plan ? conflictRows(plan) : [];
  useEffect(() => setDecisions({}), [plan]);
  const fresh = plan ? plan.newResources.length + plan.newCollections.length : 0;
  const all = (d: Decision) => setDecisions(Object.fromEntries(rows.map((r) => [r.key, d])));
  const apply = async () => {
    setBusy(true);
    try {
      await onApply(decisions);
    } finally {
      setBusy(false);
    }
  };
  const undecided = rows.some((r) => !decisions[r.key]);
  return (
    <Dialog
      open={plan !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t("settings.conflictsTitle", { count: rows.length })}
      description={t("settings.conflictsDescription", { fresh })}
      size="lg"
      dismissible={!busy}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button disabled={busy} onClick={() => all("skip")}>
            {t("settings.skipAll")}
          </Button>
          <Button disabled={busy} onClick={() => all("overwrite")}>
            {t("settings.overwriteAll")}
          </Button>
          <DialogClose>
            <Button disabled={busy}>{t("common.cancel")}</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} disabled={undecided} onClick={() => void apply()}>
            {t("settings.applyImport")}
          </Button>
        </>
      }
    >
      <Table
        columns={[
          { key: "name", header: t("settings.col.item") },
          { key: "type", header: t("settings.col.type"), width: "sm", render: (r: ConflictRow) => (r.type === "resource" ? t("settings.conflictResource") : t("settings.conflictCollection")) },
          { key: "existing", header: t("settings.col.existing"), width: "md", numeric: true, muted: true },
          { key: "incoming", header: t("settings.col.incoming"), width: "md", numeric: true, muted: true },
          {
            key: "decision",
            header: t("settings.col.decision"),
            width: "md",
            render: (r: ConflictRow) => (
              <Select
                size="sm"
                value={decisions[r.key]}
                placeholder={t("edit.selectPlaceholder")}
                onValueChange={(v) => setDecisions((d) => ({ ...d, [r.key]: v as Decision }))}
                options={[
                  { value: "overwrite", label: t("settings.conflictOverwrite") },
                  { value: "skip", label: t("settings.conflictSkip") },
                ]}
              />
            ),
          },
        ]}
        rows={rows}
        getRowKey={(r) => r.key}
        label={t("settings.conflictsTitle", { count: rows.length })}
      />
    </Dialog>
  );
}

function DataSection() {
  const { kernel, services } = useShell();
  const { toast } = useToast();
  const status = useAsync(() => services.status(), [services]);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  const fail = (title: string, e: unknown) => {
    const info = errorInfo(e);
    toast({ title, description: info.hint ? `${info.message}（${t("common.reasonHint", { hint: info.hint })}）` : info.message, tone: "danger" });
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      const folder = await services.pickFolder(t("settings.exportPick"));
      if (!folder) return;
      const bundle = await kernel.data.exportAll();
      const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
      const path = await services.exportWrite(folder, [
        { name: "resources.json", content: json(bundle.resources) },
        { name: "collections.json", content: json(bundle.collections) },
        { name: "plugins.json", content: json(bundle.plugins) },
        { name: "manifest.json", content: json(bundle.manifest) },
      ]);
      toast({ title: t("settings.exported", { path }), tone: "success" });
    } catch (e) {
      fail(t("settings.exportFailed"), e);
    } finally {
      setExporting(false);
    }
  };

  const finish = async (p: ImportPlan, decisions: Record<string, Decision>) => {
    const result = await kernel.data.applyImport(p, (c) => decisions[`${c.type}:${c.id}`] ?? "skip");
    toast({ title: t("settings.importDone", result), tone: "success" });
  };

  const startImport = async () => {
    setImporting(true);
    try {
      const folder = await services.pickFolder(t("settings.importPick"));
      if (!folder) return;
      const files = await services.importRead(folder);
      const next = await kernel.data.planImport(files);
      const conflicts = next.conflicts.length + next.collectionConflicts.length;
      const fresh = next.newResources.length + next.newCollections.length;
      if (conflicts === 0 && fresh === 0) toast({ title: t("settings.importNothing"), tone: "info" });
      else if (conflicts === 0) await finish(next, {});
      else setPlan(next);
    } catch (e) {
      fail(t("settings.importFailed"), e);
    } finally {
      setImporting(false);
    }
  };

  const applyPlan = async (decisions: Record<string, Decision>) => {
    if (!plan) return;
    try {
      await finish(plan, decisions);
      setPlan(null);
    } catch (e) {
      fail(t("settings.importFailed"), e);
    }
  };

  let info;
  if (status.status === "error" && !status.data) {
    const e = errorInfo(status.error);
    info = <ErrorState layout="inline" title={t("common.loadFailed")} reason={e.message} onRetry={status.reload} retryLabel={t("common.retry")} />;
  } else if (!status.data) info = <LoadingState layout="inline" label={t("common.loading")} />;
  else {
    const s = status.data;
    info = (
      <Stack gap="md">
        <InfoRow label={t("settings.dataDir")}>{s.dataDir}</InfoRow>
        <InfoRow label={t("settings.dbPath")}>{s.dbPath}</InfoRow>
        <InfoRow label={t("settings.schema")}>{t("settings.schemaValue", { current: s.schemaVersion, latest: s.latestSchemaVersion })}</InfoRow>
        <Stack gap="xs">
          <Text size="sm" tone="muted">
            {t("settings.backups")}
          </Text>
          <Table
            columns={[
              { key: "name", header: t("settings.col.backup"), mono: true },
              { key: "time", header: t("settings.col.backupTime"), width: "md", numeric: true, render: (r: { name: string }) => snapshotTime(r.name) },
            ]}
            rows={s.backups.map((name) => ({ name }))}
            getRowKey={(r) => r.name}
            label={t("settings.backups")}
            empty={<EmptyState layout="inline" message={t("settings.backupsEmpty")} />}
          />
          <Text size="sm" tone="muted" as="p">
            {t("settings.backupsDescription")}
          </Text>
        </Stack>
      </Stack>
    );
  }

  return (
    <Section title={t("settings.data")}>
      <Stack gap="lg">
        {info}
        <Stack direction="row" gap="lg" wrap>
          <Stack gap="sm">
            <Text weight="medium">{t("settings.export")}</Text>
            <Text size="sm" tone="muted" as="p">
              {t("settings.exportDescription")}
            </Text>
            <div>
              <Button icon="download" loading={exporting} onClick={() => void exportAll()}>
                {t("settings.export")}
              </Button>
            </div>
          </Stack>
          <Stack gap="sm">
            <Text weight="medium">{t("settings.import")}</Text>
            <Text size="sm" tone="muted" as="p">
              {t("settings.importDescription")}
            </Text>
            <div>
              <Button icon="upload" loading={importing} onClick={() => void startImport()}>
                {t("settings.import")}
              </Button>
            </div>
          </Stack>
        </Stack>
      </Stack>
      <ImportDialog plan={plan} onClose={() => setPlan(null)} onApply={applyPlan} />
    </Section>
  );
}

function SecretDialog({ mode, name: fixedName, existing, onClose }: { mode: "add" | "edit" | null; name?: string; existing: string[]; onClose: () => void }) {
  const { kernel } = useShell();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(fixedName ?? "");
    setValue("");
    setErrors({});
  }, [mode, fixedName]);

  const save = async () => {
    const finalName = mode === "edit" ? (fixedName ?? "") : name;
    const next: Record<string, string> = {};
    if (mode === "add") {
      if (!finalName) next.name = t("settings.secretNameRequired");
      else if (finalName !== finalName.trim() || finalName.length > 128) next.name = t("settings.secretNameInvalid");
      else if (existing.includes(finalName)) next.name = t("settings.secretExists");
    }
    if (!value) next.value = t("settings.secretValueRequired");
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      await kernel.secrets.set(finalName, value);
      toast({ title: t("settings.secretSaved", { name: finalName }), tone: "success" });
      setValue("");
      onClose();
    } catch (e) {
      setErrors({ value: errorInfo(e).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => !open && !saving && onClose()}
      title={mode === "edit" ? `${t("settings.editSecret")} · ${fixedName ?? ""}` : t("settings.addSecret")}
      size="sm"
      closeLabel={t("common.close")}
      dismissible={!saving}
      footer={
        <>
          <DialogClose>
            <Button disabled={saving}>{t("common.cancel")}</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <Stack gap="md">
          {mode === "add" && (
            <FormField label={t("settings.secretName")} description={t("settings.secretNameDescription")} required requiredMark={t("common.requiredMark")} error={errors.name}>
              <Input value={name} mono autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
            </FormField>
          )}
          <FormField
            label={mode === "edit" ? t("settings.secretValueNew") : t("settings.secretValue")}
            description={t("settings.secretValueDescription")}
            required
            requiredMark={t("common.requiredMark")}
            error={errors.value}
          >
            <Input type="password" value={value} autoFocus={mode === "edit"} autoComplete="new-password" onChange={(e) => setValue(e.target.value)} />
          </FormField>
        </Stack>
      </form>
    </Dialog>
  );
}

function SecretRowActions({ name, onEdit, onDelete }: { name: string; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={<IconButton icon="ellipsis" size="sm" label={t("settings.secretActions", { name })} />}
      items={[
        { key: "edit", label: t("settings.editSecret"), icon: "pencil", onSelect: onEdit },
        { key: "delete", label: t("common.delete"), icon: "trash-2", danger: true, onSelect: onDelete },
      ]}
    />
  );
}

function SecretsSection() {
  const { kernel, services, confirm } = useShell();
  const { toast } = useToast();
  const [nonce, setNonce] = useState(0);
  const list = useAsync(() => kernel.secrets.list(), [kernel, nonce]);
  const [dialog, setDialog] = useState<{ mode: "add" | "edit"; name?: string } | null>(null);
  const remove = async (name: string) => {
    const ok = await confirm({ title: t("settings.secretDeleteTitle", { name }), description: t("settings.secretDeleteBody"), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    try {
      await kernel.secrets.delete(name);
      toast({ title: t("settings.secretDeleted", { name }), tone: "success" });
    } catch (e) {
      const info = errorInfo(e);
      toast({ title: info.message, tone: "danger" });
    }
    setNonce((n) => n + 1);
  };

  let body;
  if (list.status === "error" && !list.data) {
    const e = errorInfo(list.error);
    body = <ErrorState layout="inline" title={t("common.loadFailed")} reason={e.message} resolution={e.hint} onRetry={list.reload} retryLabel={t("common.retry")} />;
  } else if (!list.data) body = <LoadingState layout="inline" label={t("common.loading")} />;
  else
    body = (
      <Table
        columns={[
          { key: "name", header: t("settings.col.secretName"), mono: true },
          {
            key: "actions",
            header: t("settings.col.secretActions"),
            width: "xs",
            align: "end",
            render: (r: { name: string }) => <SecretRowActions name={r.name} onEdit={() => setDialog({ mode: "edit", name: r.name })} onDelete={() => void remove(r.name)} />,
          },
        ]}
        rows={list.data.map((name) => ({ name }))}
        getRowKey={(r) => r.name}
        label={t("settings.secrets")}
        empty={<EmptyState layout="inline" message={t("settings.secretsEmpty")} />}
      />
    );

  return (
    <Section
      title={t("settings.secrets")}
      description={t("settings.secretsDescription")}
      actions={
        <Button size="sm" icon="plus" onClick={() => setDialog({ mode: "add" })}>
          {t("settings.addSecret")}
        </Button>
      }
    >
      <Stack gap="md">
        {services.mode === "browser" && <Banner tone="info">{t("settings.secretsPreview")}</Banner>}
        {body}
      </Stack>
      <SecretDialog
        mode={dialog?.mode ?? null}
        name={dialog?.name}
        existing={list.data ?? []}
        onClose={() => {
          setDialog(null);
          setNonce((n) => n + 1);
        }}
      />
    </Section>
  );
}

/** G.4: the settings page lists every plugin that failed to load, with its reason (D135). */
function PluginErrorsSection() {
  const { kernel, navigate } = useShell();
  useKernelTick(kernel, ["plugin.changed"]);
  const errors = kernel.plugins.loadErrors();
  return (
    <Section title={t("settings.pluginErrors")}>
      <Stack gap="sm">
        <Text as="p" tone={errors.length ? "danger" : "muted"}>
          {errors.length ? t("settings.pluginErrorsSome", { count: errors.length }) : t("settings.pluginErrorsNone")}{" "}
          <TextLink href="#plugins" onOpen={() => void navigate({ page: "plugins" })}>
            {t("settings.gotoPlugins")}
          </TextLink>
        </Text>
        {errors.length > 0 && <PluginLoadErrors errors={errors} />}
      </Stack>
    </Section>
  );
}

export function SettingsPage() {
  return (
    <Page>
      <PageHeader icon="settings" title={t("settings.title")} description={t("settings.description")} />
      <PageBody width="readable">
        <Stack gap="lg">
          <Appearance />
          <DataSection />
          <SecretsSection />
          <PluginErrorsSection />
        </Stack>
      </PageBody>
    </Page>
  );
}
