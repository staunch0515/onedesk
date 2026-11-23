import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Dialog, FormField, Input, Pane, Text, TextBlock, useToast } from "../../design";
import { useI18n } from "../i18n";
import { kernelErrorCode, type InstallAnswer, type InstallRequest, type ProtocolClient } from "../protocol";
import type { Actions } from "../state/context";
import { useUi, useWorkbench } from "../state/context";
import type { Store } from "../state/store";
import { PagesNotice } from "./pages-notice";
import { ProgramsNotice } from "./programs-notice";

/**
 * Starts installing a plugin package: on the desktop the system dialog for a package file
 * (`<id>-<version>.odplugin`, D456) or, with `from: "folder"`, for an unpacked package folder; in the browser
 * a path box that takes either. Nothing is copied until the user confirms what the package holds (`InstallPreview`).
 */
export async function startInstall(client: ProtocolClient, store: Store, actions: Pick<Actions, "fail">, from: "package" | "folder" = "package"): Promise<void> {
  try {
    const pick = from === "folder" ? client.platform?.pickFolder : client.platform?.pickPackageFile;
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

/** The reason a failed request reports to the plugin: the error's `reason`, else its code. */
function failureReason(error: unknown): string {
  const known = kernelErrorCode(error);
  return known ? (known.params.reason ?? known.code) : "internal";
}

/**
 * Plugins' install requests (round 7, D345): each one goes through the same inspect → confirm → install
 * path as a manual install, one at a time, and the kernel is told how it ended. Nothing is installed
 * without the user pressing the confirm button; the kernel only registers the request.
 */
function useInstallRequests() {
  const { client, store } = useWorkbench();
  const queue = useRef<InstallRequest[]>([]);
  const active = useRef<string | null>(null);
  const answered = useRef(new Set<string>());
  const install = useUi((s) => s.install);

  const answer = useCallback(
    async (a: InstallAnswer) => {
      answered.current.add(a.id);
      if (active.current === a.id) active.current = null;
      try {
        await client.plugin.answerInstallRequest?.(a);
      } catch {
        // The request may have expired meanwhile; there is nobody left to tell.
      }
    },
    [client],
  );

  const pump = useCallback(async () => {
    while (!active.current && queue.current.length > 0 && !store.get().install && client.app) {
      const next = queue.current.shift()!;
      active.current = next.id;
      try {
        const preview = await client.app.inspectPlugin(next.folder);
        if (active.current !== next.id) return;
        store.set({ install: { stage: "preview", folder: next.folder, preview, request: { id: next.id, plugin: next.plugin, name: next.pluginName } } });
      } catch (e) {
        await answer({ id: next.id, outcome: "failed", reason: failureReason(e) });
      }
    }
  }, [client, store, answer]);

  const refresh = useCallback(async () => {
    const list = await client.plugin.installRequests?.().catch(() => undefined);
    if (!list) return;
    const ids = new Set(list.map((r) => r.id));
    queue.current = queue.current.filter((r) => ids.has(r.id));
    for (const r of list) if (!answered.current.has(r.id) && r.id !== active.current && !queue.current.some((q) => q.id === r.id)) queue.current.push(r);
    // The request on screen ended elsewhere (expired, or its plugin was disabled): drop its dialog.
    const shown = store.get().install;
    if (active.current && !ids.has(active.current)) {
      if (shown?.stage === "preview" && shown.request?.id === active.current) store.set({ install: null });
      active.current = null;
    }
    await pump();
  }, [client, store, pump]);

  useEffect(() => {
    if (!client.app || !client.plugin.installRequests) return;
    void refresh();
    const offs = ["install-requests", "connection"].map((topic) => client.events.subscribe(topic, () => void refresh()));
    return () => offs.forEach((off) => off());
  }, [client, refresh]);

  useEffect(() => {
    if (install === null) void pump();
  }, [install, pump]);

  return answer;
}

/** The two dialogs of the install flow. */
export function InstallDialogs() {
  const { client, store, actions } = useWorkbench();
  const { t, tx, error, permission } = useI18n();
  const { toast } = useToast();
  const install = useUi((s) => s.install);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const answerRequest = useInstallRequests();

  /** Closes the dialogs; a plugin's request that is still open is answered as declined (refused packages: failed). */
  const close = () => {
    const open = store.get().install;
    store.set({ install: null });
    setPath("");
    if (open?.stage === "preview" && open.request) {
      const { preview, request } = open;
      void answerRequest(preview.valid ? { id: request.id, outcome: "declined" } : { id: request.id, outcome: "failed", reason: failureReason(preview.problem) });
    }
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
      const request = install.request;
      let done;
      try {
        done = await client.app.installPlugin(folder, preview.id, preview.version, preview.fingerprint);
      } catch (e) {
        if (!request) throw e;
        // A plugin is waiting: tell it, show the error, and let the next request come.
        store.set({ install: null });
        void answerRequest({ id: request.id, outcome: "failed", reason: failureReason(e) });
        throw e;
      }
      if (request) {
        store.set({ install: null });
        void answerRequest({ id: request.id, outcome: "installed", plugin: done.plugin, version: done.version });
      }
      if (done.warning) toast({ tone: "warning", title: t("install.doneWithWarning", { name: tx(preview.name), version: done.version, reason: error(done.warning) }) });
      else toast({ tone: "success", title: t("install.done", { name: tx(preview.name), version: done.version }) });
      if (!request) close();
    } catch (e) {
      actions.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const request = install?.stage === "preview" ? install.request : undefined;
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
        title={preview?.valid ? (request ? t("install.requestTitle", { requester: tx(request.name), name: tx(preview.name) }) : t("install.confirmTitle", { name: tx(preview.name) })) : t("install.refusedTitle")}
        description={preview?.valid ? tx(preview.description) : request ? t("install.requestedBy", { requester: tx(request.name) }) : undefined}
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
          <Pane gap="sm">
            <Banner tone="danger" title={t("install.invalid")}>
              {preview.problem ? error(preview.problem) : t("install.invalidUnknown")}
            </Banner>
            {preview.problem?.detail && (
              <TextBlock variant="code" tone="danger">
                {preview.problem.detail}
              </TextBlock>
            )}
          </Pane>
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
                    {p.detail && p.id !== "programs" && p.id !== "pages" && <Text size="xs" tone="muted" mono>{p.detail}</Text>}
                  </Pane>
                ))}
              </Pane>
            )}
            {preview.permissions.filter((p) => p.id === "programs").map((p) => (
              <ProgramsNotice key={p.id} detail={p.detail} />
            ))}
            {preview.permissions.filter((p) => p.id === "pages").map((p) => (
              <PagesNotice key={p.id} detail={p.detail} />
            ))}
          </Pane>
        )}
      </Dialog>
    </>
  );
}
