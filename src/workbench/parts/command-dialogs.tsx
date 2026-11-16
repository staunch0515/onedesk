import { useState } from "react";
import { Button, Dialog, FormField, Input } from "../../design";
import { useI18n } from "../i18n";
import { useQuery, useUi, useWorkbench } from "../state/context";

/** Dialogs a command can ask for: pick a folder (browser mode) and confirm. */
export function CommandDialogs() {
  const { store, actions } = useWorkbench();
  const { t, tx, confirmTexts } = useI18n();
  const folderPrompt = useUi((s) => s.folderPrompt);
  const confirm = useUi((s) => s.confirmCommand);
  const [path, setPath] = useState("");
  // A delete asks how many places refer to the item first (§10): the count is part of the question.
  const subject = confirm?.danger ? (confirm.context.target?.startsWith("resource:") ? confirm.context.target.slice(9) : (confirm.context.nodeKey ?? null)) : null;
  const incoming = useQuery((c) => (subject ? c.refs.incoming(subject).catch(() => []) : Promise.resolve([])), [subject], []);
  const referenced = new Set((incoming.data ?? []).map((r) => r.source.id)).size;

  const grant = () => {
    const plugin = folderPrompt?.plugin;
    if (!path.trim().startsWith("/")) return;
    const chosen = path.trim();
    closeFolder();
    if (plugin) void actions.grantFolder(plugin, chosen);
  };

  const closeFolder = () => {
    store.set({ folderPrompt: null });
    setPath("");
  };

  return (
    <>
      <Dialog
        open={folderPrompt !== null}
        onOpenChange={(open) => !open && closeFolder()}
        size="sm"
        title={t("folder.title")}
        description={t("folder.body")}
        footer={
          <>
            <Button onClick={closeFolder}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!path.trim().startsWith("/")}
              onClick={grant}
            >
              {t("folder.grant")}
            </Button>
          </>
        }
      >
        <FormField label={t("folder.path")}>
          <Input mono value={path} placeholder="/Users/…" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && grant()} autoFocus />
        </FormField>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && store.set({ confirmCommand: null })}
        size="sm"
        title={confirm ? (confirmTexts(confirm.message)?.title ?? t("confirm.title")) : t("confirm.title")}
        description={confirm ? [tx(confirm.message), referenced > 0 ? t("delete.refs", { count: referenced }) : ""].filter(Boolean).join(" ") : undefined}
        footer={
          <>
            <Button onClick={() => store.set({ confirmCommand: null })}>{t("common.cancel")}</Button>
            <Button
              variant={confirm?.danger ? "danger" : "primary"}
              onClick={() => {
                const pending = confirm;
                store.set({ confirmCommand: null });
                if (pending) void actions.command(pending.command, { ...pending.context, args: { ...pending.context.args, confirmed: true } });
              }}
            >
              {confirm ? (confirmTexts(confirm.message)?.ok ?? t("confirm.ok")) : t("confirm.ok")}
            </Button>
          </>
        }
      />
    </>
  );
}
