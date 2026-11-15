import { useState } from "react";
import { Badge, Banner, Button, Dialog, FormField, Input, Pane, Text, useToast } from "../../design";
import { useI18n } from "../i18n";
import type { ProtocolClient } from "../protocol";
import type { Actions } from "../state/context";
import { useUi, useWorkbench } from "../state/context";
import type { Store } from "../state/store";

/**
 * Starts installing a plugin package: the system folder dialog on the desktop, a path box in the
 * browser. Nothing is copied until the user confirms what the folder holds (`InstallPreview`).
 */
export async function startInstall(client: ProtocolClient, store: Store, actions: Pick<Actions, "fail">): Promise<void> {
  try {
    const pick = client.platform?.pickFolder;
    if (!pick) return void store.set({ install: { stage: "path" } });
    const folder = await pick();
    if (folder) await inspectFolder(client, store, folder);
  } catch (error) {
    actions.fail(error);
  }
}

export async function inspectFolder(client: ProtocolClient, store: Store, folder: string): Promise<void> {
  if (!client.app) return;
  const preview = await client.app.inspectPlugin(folder);
  store.set({ install: { stage: "preview", folder, preview } });
}

/** The two dialogs of the install flow. */
export function InstallDialogs() {
  const { client, store, actions } = useWorkbench();
  const { t, tx, error, permission } = useI18n();
  const { toast } = useToast();
  const install = useUi((s) => s.install);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    store.set({ install: null });
    setPath("");
  };

  const look = async () => {
    const folder = path.trim();
    if (!folder.startsWith("/")) return;
    setBusy(true);
    try {
      await inspectFolder(client, store, folder);
    } catch (e) {
      actions.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (install?.stage !== "preview" || !client.app) return;
    const { folder, preview } = install;
    setBusy(true);
    try {
      // What the user saw (id, version, permission fingerprint) goes back with the request: the main process
      // refuses if the package is no longer that, and records the confirmation itself after copying.
      const done = await client.app.installPlugin(folder, preview.id, preview.version, preview.fingerprint);
      if (done.warning) toast({ tone: "warning", title: t("install.doneWithWarning", { name: tx(preview.name), version: done.version, reason: error(done.warning) }) });
      else toast({ tone: "success", title: t("install.done", { name: tx(preview.name), version: done.version }) });
      close();
    } catch (e) {
      actions.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const preview = install?.stage === "preview" ? install.preview : null;
  const added = new Set(preview?.addedPermissions ?? []);

  return (
    <>
      <Dialog
        open={install?.stage === "path"}
        onOpenChange={(open) => !open && close()}
        size="sm"
        title={t("install.title")}
        description={t("install.pathBody")}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={busy} disabled={!path.trim().startsWith("/")} onClick={() => void look()}>
              {t("install.look")}
            </Button>
          </>
        }
      >
        <FormField label={t("install.folder")}>
          <Input mono value={path} placeholder="/Users/…" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void look()} autoFocus />
        </FormField>
      </Dialog>

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => !open && close()}
        size="md"
        title={preview?.valid ? t("install.confirmTitle", { name: tx(preview.name) }) : t("install.refusedTitle")}
        description={preview?.valid ? tx(preview.description) : undefined}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={busy} disabled={!preview?.valid || (preview?.installed ?? []).includes(preview?.version ?? "")} onClick={() => void confirm()}>
              {t("install.confirm")}
            </Button>
          </>
        }
      >
        {preview && !preview.valid && (
          <Banner tone="danger" title={t("install.invalid")}>
            {preview.problem ? error(preview.problem) : t("install.invalidUnknown")}
          </Banner>
        )}
        {preview?.valid && (
          <Pane gap="md">
            <Pane direction="row" gap="xs" align="center" wrap>
              <Text mono size="sm">{`${preview.id}@${preview.version}`}</Text>
              {preview.author && <Text size="sm" tone="muted">{preview.author}</Text>}
              {preview.installed.length > 0 && <Badge>{t("install.installedVersions", { versions: preview.installed.join(", ") })}</Badge>}
            </Pane>
            {preview.installed.includes(preview.version) && <Banner tone="warning" title={t("install.already")} />}
            <Text weight="semibold">{t("install.permissions")}</Text>
            {preview.permissions.length === 0 ? (
              <Text size="sm" tone="muted">{t("install.noPermissions")}</Text>
            ) : (
              <Pane gap="xs">
                {preview.permissions.map((p) => (
                  <Pane key={p.id} direction="row" gap="sm" align="center" wrap>
                    <Text size="sm" weight="medium">{permission(p.id)}</Text>
                    {added.has(p.id) && <Badge tone="warning">{t("install.newPermission")}</Badge>}
                    {p.detail && <Text size="xs" tone="muted" mono>{p.detail}</Text>}
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
