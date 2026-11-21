import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, EmptyState, LoadingState, Tree, type TreeRow } from "../../design";
import { useI18n } from "../i18n";
import { loadChildren, type TreeNode } from "../protocol";
import { useWorkbench } from "../state/context";

export interface FolderPickerProps {
  tree: string;
  title: string;
  /** The node being moved or copied: it and everything below it are not offered. */
  exclude: string;
  onPick: (folderKey: string) => void;
  onCancel: () => void;
}

/**
 * Asks for a folder of a tree. Only the folders the tree itself shows are offered, and a plugin's tree shows nothing outside the
 * folders the user granted, so nothing else can be chosen.
 */
export function FolderPicker({ tree, title, exclude, onPick, onCancel }: FolderPickerProps) {
  const { client, actions } = useWorkbench();
  const { t, locale } = useI18n();
  const [levels, setLevels] = useState<Map<string, TreeNode[]>>(new Map());
  const [open, setOpen] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const ROOT = "";

  const load = useCallback(
    (parent: string) => {
      loadChildren(client, tree, parent === ROOT ? null : parent, locale).then(
        (nodes) => setLevels((m) => new Map(m).set(parent, nodes.filter((n) => n.expandable && n.key !== exclude))),
        actions.fail,
      );
    },
    [client, tree, locale, exclude, actions],
  );
  useEffect(() => load(ROOT), [load]);
  useEffect(() => {
    for (const key of open) if (!levels.has(key)) load(key);
  }, [open, levels, load]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (parent: string, depth: number) => {
      for (const n of levels.get(parent) ?? []) {
        const isOpen = open.includes(n.key);
        out.push({ key: n.key, label: n.label, icon: isOpen ? "folder-open" : n.icon, depth, expandable: true, expanded: isOpen });
        if (isOpen) walk(n.key, depth + 1);
      }
    };
    walk(ROOT, 0);
    return out;
  }, [levels, open]);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={chosen === null} onClick={() => chosen !== null && onPick(chosen)}>
            {t("folderPicker.choose")}
          </Button>
        </>
      }
    >
      {!levels.has(ROOT) ? (
        <LoadingState layout="inline" label={t("common.loading")} />
      ) : rows.length === 0 ? (
        <EmptyState layout="inline" message={t("folderPicker.empty")} />
      ) : (
        <Tree
          rows={rows}
          label={t("folderPicker.label")}
          selectedKey={chosen}
          onActivate={setChosen}
          onToggle={(key) => setOpen((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]))}
        />
      )}
    </Dialog>
  );
}
