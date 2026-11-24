import { useState } from "react";
import { Button, Dialog, FormField, Input, Pane, Select, Switch, Text } from "../../design";
import { useI18n } from "../i18n";
import type { KnownParam, ParamType } from "../protocol";
import { RefPicker } from "./ref-picker";
import { useQuery } from "../state/context";

/** The types a parameter the user names can have (D466). Secrets have their own place (`{{secret:name}}`). */
const TYPES = ["text", "number", "boolean", "ref"] as const;
type FreeType = (typeof TYPES)[number];

/** A name pages can write as `{{name}}`: no spaces, no braces. */
export const validParamName = (name: string): boolean => name.length > 0 && !/[\s{}]/.test(name);

/**
 * "Add parameter" (D466): any name and any value — an environment holds whatever the user's pages need, read by name
 * (`{{name}}`). The parameters the workspace itself understands (`params.known`, for this layer and not yet set here)
 * are offered as quick picks; picking one fills in its name and type.
 */
export function AddParamDialog({ layer, own, open, onOpenChange, onAdd }: { layer: "config" | "env"; own: Set<string>; open: boolean; onOpenChange: (open: boolean) => void; onAdd: (name: string, value: string, type?: ParamType) => Promise<void> }) {
  const { t } = useI18n();
  const known = useQuery((c) => c.params.known(), [], []);
  const [name, setName] = useState("");
  const [type, setType] = useState<FreeType>("text");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [refPicked, setRefPicked] = useState<{ id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const offered = (known.data ?? []).filter((k: KnownParam) => k.layers.includes(layer) && !own.has(k.name));
  const trimmed = name.trim();
  // A name the workspace understands keeps its own type (a list is typed as comma separated text).
  const knownParam = (known.data ?? []).find((k) => k.name === trimmed);
  const shownType: ParamType = knownParam ? knownParam.type : type;
  const exists = own.has(trimmed);
  const badName = trimmed !== "" && !validParamName(trimmed);
  const ready = validParamName(trimmed) && !exists && (shownType !== "ref" || refPicked !== null);
  const desc = knownParam && t(`params.desc.${knownParam.name}` as never) !== `params.desc.${knownParam.name}` ? t(`params.desc.${knownParam.name}` as never) : "";

  const close = (next: boolean) => {
    if (!next) {
      setName("");
      setType("text");
      setValue("");
      setRefPicked(null);
    }
    onOpenChange(next);
  };
  const pickKnown = (k: KnownParam) => {
    setName(k.name);
    // A switch starts on: adding "protection.readonly" is how it is turned on.
    setValue(k.type === "boolean" ? "true" : "");
  };
  const pickType = (next: string) => {
    setType(next as FreeType);
    setValue(next === "boolean" ? "true" : "");
    setRefPicked(null);
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
            disabled={!ready}
            onClick={() => {
              setBusy(true);
              // A known parameter keeps the kernel's own type; a named one says which it is.
              const sent = shownType === "ref" ? refPicked!.id : value;
              void onAdd(trimmed, sent, knownParam ? undefined : type).then(() => {
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
        <FormField label={t("params.addName")} error={exists ? t("params.addExists") : badName ? t("params.addBadName") : undefined}>
          <Input mono aria-label={t("params.addName")} placeholder={t("params.addNamePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        {offered.length > 0 && (
          <Pane gap="xs">
            <Text size="xs" tone="muted">
              {t("params.addKnown")}
            </Text>
            <Pane direction="row" gap="xs" wrap>
              {offered.map((k) => (
                <Button key={k.name} size="sm" variant="ghost" onClick={() => pickKnown(k)}>
                  {k.name}
                </Button>
              ))}
            </Pane>
          </Pane>
        )}
        {!knownParam && (
          <FormField label={t("params.addType")}>
            <Select aria-label={t("params.addType")} value={type} onValueChange={pickType} options={TYPES.map((x) => ({ value: x, label: t(`params.type.${x}` as never) }))} />
          </FormField>
        )}
        {desc && (
          <Text size="sm" tone="muted">
            {desc}
          </Text>
        )}
        <FormField label={t("params.addValue")}>
          {shownType === "boolean" ? (
            <Switch aria-label={t("params.addValue")} checked={value === "true"} onCheckedChange={(on) => setValue(on ? "true" : "false")} />
          ) : shownType === "ref" ? (
            <Pane direction="row" gap="sm" align="center">
              <Pane grow>
                <Input icon="link" aria-label={t("params.addValue")} value={refPicked?.name ?? ""} readOnly placeholder={t("env.refChoose")} />
              </Pane>
              <Button onClick={() => setPicking(true)}>{t("env.refChoose")}</Button>
            </Pane>
          ) : (
            <Input mono aria-label={t("params.addValue")} type={shownType === "number" ? "number" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
          )}
        </FormField>
        <RefPicker
          open={picking}
          onOpenChange={setPicking}
          onPick={(id, picked) => {
            setRefPicked({ id, name: picked });
            setPicking(false);
          }}
        />
      </Pane>
    </Dialog>
  );
}
