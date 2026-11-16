import { useState } from "react";
import { Button, Dialog, FormField, Input, Pane, Select, Switch, Text } from "../../design";
import { useI18n } from "../i18n";
import type { KnownParam } from "../protocol";
import { useQuery } from "../state/context";

/**
 * "Add parameter": the parameters the kernel itself understands (`params.known`), for this page's layer
 * (workspace configuration or environment) and not yet set here. The value control follows the type.
 */
export function AddParamDialog({ layer, own, open, onOpenChange, onAdd }: { layer: "config" | "env"; own: Set<string>; open: boolean; onOpenChange: (open: boolean) => void; onAdd: (name: string, value: string) => Promise<void> }) {
  const { t } = useI18n();
  const known = useQuery((c) => c.params.known(), [], []);
  const [name, setName] = useState<string | undefined>(undefined);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const options = (known.data ?? []).filter((k: KnownParam) => k.layers.includes(layer) && !own.has(k.name));
  const chosen = options.find((k) => k.name === name);
  const close = (next: boolean) => {
    if (!next) {
      setName(undefined);
      setValue("");
    }
    onOpenChange(next);
  };
  const pick = (next: string) => {
    setName(next);
    // A switch starts on: adding "protection.readonly" is how it is turned on.
    setValue(options.find((k) => k.name === next)?.type === "boolean" ? "true" : "");
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="sm"
      title={t("params.addTitle")}
      description={t("params.addBody")}
      footer={
        <>
          <Button onClick={() => close(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!chosen}
            onClick={() => {
              if (!chosen) return;
              setBusy(true);
              void onAdd(chosen.name, value).then(() => {
                setBusy(false);
                close(false);
              }, () => setBusy(false));
            }}
          >
            {t("params.addGo")}
          </Button>
        </>
      }
    >
      {known.data && options.length === 0 ? (
        <Text size="sm" tone="muted">{t("params.addNone")}</Text>
      ) : (
        <Pane gap="md">
          <FormField label={t("params.addPick")}>
            <Select key={name ?? "none"} aria-label={t("params.addPick")} placeholder={t("params.addPickPlaceholder")} value={name} onValueChange={pick} options={options.map((k) => ({ value: k.name, label: k.name }))} />
          </FormField>
          {chosen && (
            <>
              <Text size="sm" tone="muted">{t(`params.desc.${chosen.name}` as never) === `params.desc.${chosen.name}` ? "" : t(`params.desc.${chosen.name}` as never)}</Text>
              <FormField label={t("params.addValue")}>
                {chosen.type === "boolean" ? (
                  <Switch aria-label={chosen.name} checked={value === "true"} onCheckedChange={(on) => setValue(on ? "true" : "false")} />
                ) : (
                  <Input mono aria-label={chosen.name} type={chosen.type === "number" ? "number" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
                )}
              </FormField>
            </>
          )}
        </Pane>
      )}
    </Dialog>
  );
}
