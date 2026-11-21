import { useState } from "react";
import { Button, Dialog, FormField, Input, Pane } from "../../design";
import { useI18n } from "../i18n";
import type { Run } from "../protocol";
import { useWorkbench } from "../state/context";

const MAX_NAME = 100;

/**
 * What can be done with a run's result from its own tab (D420): keep it (it then lives under "Saved results" with a readable
 * name), rename it, stop keeping it, or delete it for good (the kernel asks first, the shell shows its question).
 */
export function RunKeepBar({ run }: { run: Run }) {
  const { client, actions } = useWorkbench();
  const { t, error } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const target = `run:${run.id}`;
  const clean = name.trim();
  const valid = clean.length > 0 && [...clean].length <= MAX_NAME;
  const submit = () => {
    if (!valid) return;
    client.run.setKept(run.id, true, clean).then(() => setRenaming(false), (e) => setProblem(error(e)));
  };
  if (run.status === "running") return null;
  return (
    <>
      <Pane direction="row" gap="sm" align="center" wrap pad="sm">
        {run.keptName && <span>{run.keptName}</span>}
        {!run.kept && (
          <Button size="sm" icon="bookmark" onClick={() => void actions.command("run.keep", { target, nodeKey: run.id })}>
            {t("run.keep")}
          </Button>
        )}
        {run.kept && (
          <>
            <Button
              size="sm"
              icon="pencil"
              onClick={() => {
                setName(run.keptName ?? run.title);
                setProblem(null);
                setRenaming(true);
              }}
            >
              {t("run.rename")}
            </Button>
            <Button size="sm" icon="bookmark-minus" onClick={() => void actions.command("run.unkeep", { target, nodeKey: run.id })}>
              {t("run.unkeep")}
            </Button>
            <Button size="sm" variant="danger" icon="trash-2" onClick={() => void actions.command("run.delete", { target, nodeKey: run.id })}>
              {t("run.delete")}
            </Button>
          </>
        )}
      </Pane>
      <Dialog
        open={renaming}
        onOpenChange={(open) => !open && setRenaming(false)}
        size="sm"
        title={t("run.rename")}
        footer={
          <>
            <Button onClick={() => setRenaming(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" disabled={!valid} onClick={submit}>
              {t("run.renameOk")}
            </Button>
          </>
        }
      >
        <FormField label={t("run.renameLabel")} error={problem ?? undefined}>
          <Input
            value={name}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </FormField>
      </Dialog>
    </>
  );
}
