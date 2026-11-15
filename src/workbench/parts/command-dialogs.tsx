import { useState } from "react";
import { Button, Dialog, FormField, Input } from "../../design";
import { useI18n } from "../i18n";
import { useUi, useWorkbench } from "../state/context";

/** Dialogs a command can ask for: pick a folder (browser mode) and confirm. */
export function CommandDialogs() {
  const { store, actions } = useWorkbench();
  const { t, tx } = useI18n();
  const folderPrompt = useUi((s) => s.folderPrompt);
  const confirm = useUi((s) => s.confirmCommand);
  const [path, setPath] = useState("");

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
              onClick={() => {
                const plugin = folderPrompt?.plugin;
                closeFolder();
                if (plugin) void actions.grantFolder(plugin, path.trim());
              }}
            >
              {t("folder.grant")}
            </Button>
          </>
        }
      >
        <FormField label={t("folder.path")}>
          <Input mono value={path} placeholder="/Users/…" onChange={(e) => setPath(e.target.value)} autoFocus />
        </FormField>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && store.set({ confirmCommand: null })}
        size="sm"
        title={t("confirm.title")}
        description={confirm ? tx(confirm.message) : undefined}
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
              {t("confirm.ok")}
            </Button>
          </>
        }
      />
    </>
  );
}
