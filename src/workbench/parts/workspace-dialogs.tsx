import { useEffect, useState } from "react";
import { Badge, Button, Dialog, FormField, IconButton, Input, Table, type TableColumn } from "../../design";
import { useI18n } from "../i18n";
import { isPendingWorkspace, type WorkspaceEntry } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";

/** What the workspace menu opened (D400). */
export type WorkspaceDialog = { kind: "create" } | { kind: "manage" } | { kind: "rename"; entry: WorkspaceEntry } | { kind: "delete"; entry: WorkspaceEntry } | null;

const MAX_NAME = 100;

/** Switches this connection to a workspace, then loads the interface again so every part shows that workspace. */
export async function switchWorkspace(client: { workspace: { switchTo: (id: string) => Promise<unknown> } }, id: string) {
  await client.workspace.switchTo(id);
  // A tab opened for one workspace ("new window") keeps asking for it on every load: the switch replaces that.
  const url = new URL(window.location.href);
  if (url.searchParams.has("workspace")) {
    url.searchParams.delete("workspace");
    window.location.replace(url.toString());
  } else window.location.reload();
}

/** A name field with its own validation: 1 to 100 characters. */
function NameDialog({ title, ok, initial, onSubmit, onClose }: { title: string; ok: string; initial: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const { t, error } = useI18n();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setName(initial), [initial]);
  const clean = name.trim();
  const valid = clean.length > 0 && [...clean].length <= MAX_NAME;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onSubmit(clean);
      onClose();
    } catch (e) {
      setProblem(error(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {ok}
          </Button>
        </>
      }
    >
      <FormField label={t("workspace.name")} error={problem ?? (clean.length === 0 && name.length > 0 ? t("workspace.nameEmpty") : [...clean].length > MAX_NAME ? t("workspace.nameTooLong", { max: MAX_NAME }) : undefined)}>
        <Input value={name} autoFocus onChange={(e) => { setName(e.target.value); setProblem(null); }} onKeyDown={(e) => e.key === "Enter" && void submit()} />
      </FormField>
    </Dialog>
  );
}

/** Asks before a workspace goes to the trash folder; the button is busy while the main process works. */
function DeleteDialog({ entry, setDialog }: { entry: WorkspaceEntry; setDialog: (d: WorkspaceDialog) => void }) {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const back = () => setDialog({ kind: "manage" });
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && back()}
      size="sm"
      title={t("workspace.deleteTitle", { name: entry.name })}
      description={t("workspace.deleteBody")}
      footer={
        <>
          <Button disabled={busy} onClick={back}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={busy}
            loading={busy}
            onClick={() => {
              setBusy(true);
              client.workspace.remove(entry.id).catch(actions.fail).finally(back);
            }}
          >
            {t("workspace.delete")}
          </Button>
        </>
      }
    />
  );
}

/** The dialogs behind the title bar's workspace menu: new, rename, delete and the list to manage them. */
export function WorkspaceDialogs({ dialog, setDialog }: { dialog: WorkspaceDialog; setDialog: (d: WorkspaceDialog) => void }) {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const list = useQuery((c) => c.workspace.list(), [dialog?.kind === "manage"], ["app.workspacesChanged"]);
  const close = () => setDialog(null);

  if (!dialog) return null;
  if (dialog.kind === "create") {
    return (
      <NameDialog
        title={t("workspace.newTitle")}
        ok={t("workspace.create")}
        initial=""
        onClose={close}
        onSubmit={async (name) => {
          await client.workspace.create(name);
        }}
      />
    );
  }
  if (dialog.kind === "rename") {
    return <NameDialog title={t("workspace.renameTitle")} ok={t("workspace.rename")} initial={dialog.entry.name} onClose={() => setDialog({ kind: "manage" })} onSubmit={(name) => client.workspace.rename(dialog.entry.id, name)} />;
  }
  if (dialog.kind === "delete") return <DeleteDialog entry={dialog.entry} setDialog={setDialog} />;

  const columns: Array<TableColumn<WorkspaceEntry>> = [
    { key: "name", header: t("workspace.name"), render: (w) => (w.current ? <>{w.name} <Badge tone="accent">{t("workspace.current")}</Badge></> : w.name) },
    { key: "folder", header: t("workspace.folder"), mono: true, muted: true, render: (w) => w.folder ?? "" },
    {
      key: "actions",
      header: "",
      width: "md",
      align: "end",
      render: (w) => (
        <>
          <IconButton icon="app-window" label={t("workspace.openWindowAction", { name: w.name })} onClick={() => void client.workspace.openWindow(w.id).catch(actions.fail)} />
          <IconButton icon="pencil" label={t("workspace.renameAction", { name: w.name })} disabled={isPendingWorkspace(w)} onClick={() => setDialog({ kind: "rename", entry: w })} />
          <IconButton icon="trash-2" label={t("workspace.deleteAction", { name: w.name })} disabled={w.current || isPendingWorkspace(w)} onClick={() => setDialog({ kind: "delete", entry: w })} />
        </>
      ),
    },
  ];
  return (
    <Dialog open onOpenChange={(open) => !open && close()} size="lg" title={t("workspace.manageTitle")} description={t("workspace.manageBody")} footer={<Button onClick={close}>{t("common.close")}</Button>}>
      <Table label={t("topbar.workspaces")} columns={columns} rows={list.data ?? []} getRowKey={(w) => w.id} />
    </Dialog>
  );
}
