import { useState } from "react";
import { Button, Dialog, FormField, Input } from "../../design";
import { useI18n } from "../i18n";
import { useUi, useWorkbench } from "../state/context";
import type { ConfirmState } from "../state/store";

/** Dialogs a command can ask for: pick a folder (browser mode) and confirm. */
export function CommandDialogs() {
  const { store, actions } = useWorkbench();
  const { t, tx, confirmTexts } = useI18n();
  const folderPrompt = useUi((s) => s.folderPrompt);
  const confirm = useUi((s) => s.confirmCommand);
  const [path, setPath] = useState("");
  const answer = (pending: ConfirmState, more: Record<string, unknown>) => {
    store.set({ confirmCommand: null });
    void actions.command(pending.command, { ...pending.context, args: { ...pending.context.args, confirmed: true, ...more } });
  };
  const choiceText = (id: string) => (id === "overwrite" || id === "skip" || id === "keepBoth" ? t(`confirm.choice.${id}`) : id);
  const grant = () => {
    const plugin = folderPrompt?.plugin;
    const replace = folderPrompt?.replace;
    if (!path.trim().startsWith("/")) return;
    const chosen = path.trim();
    closeFolder();
    if (plugin) void actions.grantFolder(plugin, chosen, replace);
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
        description={confirm ? [tx(confirm.message), confirm.irreversible ? t("confirm.irreversible") : ""].filter(Boolean).join(" ") : undefined}
        footer={
          <>
            <Button onClick={() => store.set({ confirmCommand: null })}>{t("common.cancel")}</Button>
            {confirm?.choices ? (
              confirm.choices.map((choice) => (
                <Button key={choice.id} variant={choice.danger ? "danger" : "secondary"} onClick={() => answer(confirm, { [confirm.choiceArg ?? "conflict"]: choice.id })}>
                  {choice.label ? tx(choice.label) : choiceText(choice.id)}
                </Button>
              ))
            ) : (
              <Button variant={confirm?.danger || confirm?.irreversible ? "danger" : "primary"} onClick={() => confirm && answer(confirm, {})}>
                {confirm ? (confirmTexts(confirm.message)?.ok ?? t("confirm.ok")) : t("confirm.ok")}
              </Button>
            )}
          </>
        }
      />
    </>
  );
}
