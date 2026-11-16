import { useState } from "react";
import { Badge, Banner, Button, Dialog, FormField, Input, Pane, Text, useToast } from "../../design";
import { useI18n } from "../i18n";
import type { ProtocolClient } from "../protocol";
import type { Actions } from "../state/context";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { Store } from "../state/store";

type Fail = Pick<Actions, "fail">;

/** Exporting the workspace: the system folder dialog on the desktop, a path box in the browser. */
export async function startExport(client: ProtocolClient, store: Store, actions: Fail, toastDone: (resources: number, folder: string) => void): Promise<void> {
  try {
    const pick = client.platform?.pickFolder;
    if (!pick) return void store.set({ transfer: { stage: "export-path" } });
    const folder = await pick();
    if (folder) toastDone((await client.workspace.export(folder)).resources, folder);
  } catch (error) {
    actions.fail(error);
  }
}

/** Importing: choose the export's folder, then show what would happen before anything changes. */
export async function startImport(client: ProtocolClient, store: Store, actions: Fail): Promise<void> {
  try {
    const pick = client.platform?.pickFolder;
    if (!pick) return void store.set({ transfer: { stage: "import-path" } });
    const folder = await pick();
    if (folder) await previewFolder(client, store, folder);
  } catch (error) {
    actions.fail(error);
  }
}

export async function previewFolder(client: ProtocolClient, store: Store, folder: string): Promise<void> {
  const preview = await client.workspace.importPreview(folder);
  store.set({ transfer: { stage: "import-preview", folder, preview } });
}

/** Exporting a run's table: the system "save as" dialog on the desktop, a path box in the browser. */
export async function startRunExport(client: ProtocolClient, store: Store, actions: Fail, run: string, suggested: string, done: (rows: number, path: string) => void): Promise<void> {
  try {
    const pick = client.platform?.pickSaveFile;
    if (!pick) return void store.set({ exportCsv: { run } });
    const path = await pick(suggested);
    if (path) {
      const result = await client.run.export(run, path);
      done(result.rows, result.path);
    }
  } catch (error) {
    actions.fail(error);
  }
}

/** The dialogs of the export, import and CSV export flows (browser mode asks for paths; the preview is always shown). */
export function TransferDialogs() {
  const { client, store, actions } = useWorkbench();
  const { t, error, dateTime } = useI18n();
  const { toast } = useToast();
  const transfer = useUi((s) => s.transfer);
  const exportCsv = useUi((s) => s.exportCsv);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    store.set({ transfer: null, exportCsv: null });
    setPath("");
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      actions.fail(e);
    } finally {
      setBusy(false);
    }
  };
  const absolute = path.trim().startsWith("/");

  const present = useQuery((c) => (c.secrets ? c.secrets.list() : Promise.resolve([])), [transfer?.stage === "import-preview"], ["secrets"]);
  const have = new Set((present.data ?? []).map((s) => s.name));
  const preview = transfer?.stage === "import-preview" ? transfer.preview : null;
  const importable = preview?.valid && preview.create + preview.update > 0;

  const submitPath = () => {
    if (!absolute) return;
    const folder = path.trim();
    if (transfer?.stage === "export-path")
      void run(async () => {
        const result = await client.workspace.export(folder);
        toast({ tone: "success", title: t("transfer.exportDone", { resources: result.resources, folder: result.folder }) });
        close();
      });
    else if (transfer?.stage === "import-path") void run(() => previewFolder(client, store, folder));
    else if (exportCsv)
      void run(async () => {
        const result = await client.run.export(exportCsv.run, folder);
        toast({ tone: "success", title: t("result.exported", { rows: result.rows, path: result.path }) });
        close();
      });
  };

  const asksForPath = transfer?.stage === "export-path" || transfer?.stage === "import-path" || exportCsv !== null;
  const titles = transfer?.stage === "export-path" ? [t("transfer.exportTitle"), t("transfer.exportBody"), t("transfer.exportGo")] : exportCsv ? [t("result.exportTitle"), t("result.exportBody"), t("result.exportGo")] : [t("transfer.importTitle"), t("transfer.importPathBody"), t("transfer.look")];

  return (
    <>
      <Dialog
        open={asksForPath}
        onOpenChange={(open) => !open && close()}
        size="sm"
        title={titles[0]}
        description={titles[1]}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={busy} disabled={!absolute} onClick={submitPath}>
              {titles[2]}
            </Button>
          </>
        }
      >
        <FormField label={exportCsv ? t("result.exportPath") : t("transfer.folder")}>
          <Input mono value={path} placeholder={exportCsv ? "/Users/…/result.csv" : "/Users/…"} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitPath()} autoFocus />
        </FormField>
      </Dialog>

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => !open && close()}
        size="md"
        title={preview?.valid ? t("transfer.previewTitle", { source: preview.source }) : t("transfer.refusedTitle")}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!importable}
              onClick={() =>
                void run(async () => {
                  if (transfer?.stage !== "import-preview") return;
                  const result = await client.workspace.import(transfer.folder, transfer.preview.fingerprint);
                  toast({ tone: "success", title: t("transfer.importDone", { created: result.created, updated: result.updated, group: result.group.name }) });
                  close();
                  // Show the new group in its tree.
                  const res = await client.resource.get(result.group.id);
                  if (res) void actions.reveal(res.tree, res.id);
                })
              }
            >
              {t("transfer.importGo")}
            </Button>
          </>
        }
      >
        {preview && !preview.valid && (
          <Banner tone="danger" title={t("transfer.refusedTitle")}>
            {preview.problem ? error(preview.problem) : t("install.invalidUnknown")}
          </Banner>
        )}
        {preview?.valid && (
          <Pane gap="md">
            <Pane direction="row" gap="xs" align="center" wrap>
              <Badge tone="success">{t("transfer.summary", { create: preview.create, update: preview.update, skipped: preview.skipped.length })}</Badge>
              <Text size="sm" tone="muted">{t("transfer.exportedAt", { at: dateTime(preview.exportedAt) })}</Text>
            </Pane>
            <Text size="sm">{t("transfer.intoNewGroup")}</Text>
            {preview.grantHosts.length > 0 && (
              <Pane gap="xs">
                <Text weight="semibold">{t("transfer.grantHosts")}</Text>
                <Pane direction="row" gap="xs" wrap>
                  {preview.grantHosts.map((h) => (
                    <Badge key={h} tone="warning" icon="globe">{h}</Badge>
                  ))}
                </Pane>
              </Pane>
            )}
            {preview.secretNames.length > 0 && (
              <Pane gap="xs">
                <Text weight="semibold">{t("transfer.secretNames")}</Text>
                {preview.secretNames.map((n) => (
                  <Pane key={n} direction="row" gap="sm" align="center" wrap>
                    <Text size="sm" mono>{n}</Text>
                    <Badge tone={have.has(n) ? "success" : "neutral"} icon="key-round">{have.has(n) ? t("transfer.secretPresent") : t("transfer.secretAbsent")}</Badge>
                  </Pane>
                ))}
              </Pane>
            )}
            {preview.skipped.length > 0 && (
              <Pane gap="xs">
                <Text weight="semibold">{t("transfer.skipped")}</Text>
                {preview.skipped.map((s, i) => (
                  <Pane key={`${s.name}-${i}`} direction="row" gap="sm" align="center" wrap>
                    <Text size="sm" weight="medium">{s.name}</Text>
                    <Text size="xs" tone="muted" mono>{s.kind}</Text>
                    <Badge tone="warning">{skipText(t, s.reason)}</Badge>
                  </Pane>
                ))}
              </Pane>
            )}
          </Pane>
        )}
      </Dialog>
    </>
  );
}

function skipText(t: ReturnType<typeof useI18n>["t"], reason: string): string {
  if (reason === "unknownKind") return t("transfer.skip.unknownKind");
  if (reason === "needsVersion") return t("transfer.skip.needsVersion");
  if (reason === "config") return t("transfer.skip.config");
  if (reason === "invalid") return t("transfer.skip.invalid");
  return reason;
}
