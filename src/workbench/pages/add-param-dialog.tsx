import { useState } from "react";
import { Button, Dialog, FormField, Input, Pane, Select, Switch, Text } from "../../design";
import { useI18n } from "../i18n";
import type { KnownParam, ParamType } from "../protocol";
import { RefPicker } from "./ref-picker";
import { useQuery } from "../state/context";

/** The "other" choice of the name list: a reference to a resource under a name of the user's choosing. */
const REF_CHOICE = "@ref";

/**
 * "Add parameter": the parameters the kernel itself understands (`params.known`), for this page's layer
 * (workspace configuration or environment) and not yet set here. The value control follows the type.
 */
export function AddParamDialog({ layer, own, open, onOpenChange, onAdd }: { layer: "config" | "env"; own: Set<string>; open: boolean; onOpenChange: (open: boolean) => void; onAdd: (name: string, value: string, type?: ParamType) => Promise<void> }) {
  const { t } = useI18n();
  const known = useQuery((c) => c.params.known(), [], []);
  const [name, setName] = useState<string | undefined>(undefined);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // A reference to a resource (G3), e.g. the environment's `datasource`: any name, the value is picked from the resources.
  const [refName, setRefName] = useState("datasource");
  const [refPicked, setRefPicked] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const isRef = name === REF_CHOICE;
  const options = (known.data ?? []).filter((k: KnownParam) => k.layers.includes(layer) && !own.has(k.name));
  const chosen = isRef ? ({ name: refName.trim(), type: "ref" } as const) : options.find((k) => k.name === name);
  const close = (next: boolean) => {
    if (!next) {
      setName(undefined);
      setValue("");
      setRefPicked(null);
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
            disabled={!chosen || (isRef && (!refPicked || chosen.name === "" || own.has(chosen.name)))}
            onClick={() => {
              if (!chosen) return;
              setBusy(true);
              void onAdd(chosen.name, isRef ? refPicked!.id : value, isRef ? "ref" : undefined).then(() => {
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
      <Pane gap="md">
          <FormField label={t("params.addPick")}>
            <Select key={name ?? "none"} aria-label={t("params.addPick")} placeholder={t("params.addPickPlaceholder")} value={name} onValueChange={pick} options={[...options.map((k) => ({ value: k.name, label: k.name })), { value: REF_CHOICE, label: t("env.refKind") }]} />
          </FormField>
          {isRef && (
            <>
              <FormField label={t("env.refName")} error={own.has(refName.trim()) ? t("params.addExists") : undefined}>
                <Input mono aria-label={t("env.refName")} placeholder={t("env.refNamePlaceholder")} value={refName} onChange={(e) => setRefName(e.target.value)} />
              </FormField>
              <FormField label={t("params.addValue")}>
                <Pane direction="row" gap="sm" align="center">
                  <Pane grow>
                    <Input icon="link" aria-label={t("params.addValue")} value={refPicked?.name ?? ""} readOnly placeholder={t("env.refChoose")} />
                  </Pane>
                  <Button onClick={() => setPicking(true)}>{t("env.refChoose")}</Button>
                </Pane>
              </FormField>
              <RefPicker open={picking} onOpenChange={setPicking} onPick={(id, picked) => { setRefPicked({ id, name: picked }); setPicking(false); }} />
            </>
          )}
          {chosen && !isRef && (
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
    </Dialog>
  );
}
