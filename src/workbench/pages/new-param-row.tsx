import { useState } from "react";
import { IconButton, Input, Pane, Text } from "../../design";
import { useI18n } from "../i18n";
import type { ParamType } from "../protocol";
import { RefPicker } from "./ref-picker";

/** A name pages can write as `{{name}}`: no spaces, no braces. */
export const validParamName = (name: string): boolean => name.length > 0 && !/[\s{}]/.test(name);

/**
 * Adds a parameter right where the parameters are (D466, D470): type any name and any value, Enter adds it. No dialog,
 * no list of the kernel's own names to pick from. The link button makes the value a reference to a resource instead
 * (chosen by name, G3).
 */
export function NewParamRow({ own, onAdd }: { own: Set<string>; onAdd: (name: string, value: string, type?: ParamType) => Promise<unknown> }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [picking, setPicking] = useState(false);
  const trimmed = name.trim();
  const error = trimmed === "" ? undefined : !validParamName(trimmed) ? t("params.addBadName") : own.has(trimmed) ? t("params.addExists") : undefined;
  const ready = trimmed !== "" && !error;
  const add = (v: string, type?: ParamType) => {
    if (!ready) return;
    void onAdd(trimmed, v, type).then(() => {
      setName("");
      setValue("");
    }, () => undefined);
  };
  return (
    <Pane gap="xs">
      <Pane direction="row" gap="sm" align="center">
        <Pane grow>
          <Input mono size="sm" aria-label={t("params.newName")} placeholder={t("params.newNamePlaceholder")} invalid={Boolean(error)} value={name} onChange={(e) => setName(e.target.value)} />
        </Pane>
        <Pane grow>
          <Input
            mono
            size="sm"
            aria-label={t("params.newValue")}
            placeholder={t("params.newValuePlaceholder")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add(value)}
          />
        </Pane>
        <IconButton icon="plus" size="sm" variant="secondary" label={t("params.addHere")} disabled={!ready} onClick={() => add(value)} />
        <IconButton icon="link" size="sm" label={t("params.addRef")} disabled={!ready} onClick={() => setPicking(true)} />
      </Pane>
      {error && (
        <Text size="xs" tone="danger">
          {error}
        </Text>
      )}
      <RefPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(id) => {
          setPicking(false);
          add(id, "ref");
        }}
      />
    </Pane>
  );
}
