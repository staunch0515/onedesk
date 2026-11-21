import { useState } from "react";
import { Dialog, Input, OptionList } from "../../design";
import { useI18n } from "../i18n";
import { useQuery } from "../state/context";

/**
 * Chooses a resource for a reference parameter (G3): the user searches by name and picks one. The kernel checks what the
 * value may point at when the parameter is used; the dialog only hands back the resource's id and name.
 */
export function RefPicker({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (id: string, name: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const hits = useQuery((c) => (open && text.trim() ? c.search.query(text.trim(), 30) : Promise.resolve([])), [open, text]);
  const items = (hits.data ?? [])
    .filter((h) => h.target.startsWith("resource:"))
    .map((h) => ({ key: h.target, label: h.title, icon: h.icon, description: h.subtitle, onSelect: () => onPick(h.target.slice("resource:".length), h.title) }));
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setText(""); onOpenChange(next); }} size="sm" title={t("ref.pickTitle")}>
      <Input icon="search" autoFocus aria-label={t("ref.pickSearch")} placeholder={t("ref.pickSearch")} value={text} onChange={(e) => setText(e.target.value)} />
      <OptionList scroll label={t("ref.pickTitle")} items={items} empty={text.trim() ? (hits.loading ? t("common.loading") : t("ref.pickNone")) : t("ref.pickHint")} />
    </Dialog>
  );
}
