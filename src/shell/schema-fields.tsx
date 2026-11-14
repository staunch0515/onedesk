/** Input controls generated from a field schema (see schema-form.ts for values and validation). */
import { useId } from "react";
import { Button, Checkbox, EmptyState, FormField, IconButton, Input, Select, Stack, Switch, Textarea, type SelectOption } from "../design";
import type { FieldDef, Resource } from "../plugin-api";
import { t } from "./i18n";
import type { FormValue, FormValues, ParameterRow } from "./schema-form";

const NONE = "__none__";

export interface SchemaFieldsProps {
  fields: FieldDef[];
  values: FormValues;
  errors: Record<string, string>;
  onChange: (name: string, value: FormValue) => void;
  /** Candidates for `reference` fields (filtered by refKind). */
  references?: Resource[];
  disabled?: boolean;
}

export function ParameterEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: ParameterRow[];
  onChange: (rows: ParameterRow[]) => void;
  disabled?: boolean;
}) {
  // Explicit ids: inside a FormField every control would otherwise get the field's id.
  const base = useId();
  const update = (i: number, patch: Partial<ParameterRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Stack gap="sm">
      {rows.length === 0 && <EmptyState layout="inline" message={t("param.empty")} />}
      {rows.map((row, i) => (
        <Stack key={i} direction="row" gap="sm" align="center">
          <Input
            id={`${base}-name-${i}`}
            aria-label={`${t("param.name")} ${i + 1}`}
            placeholder={t("param.name")}
            value={row.name}
            mono
            disabled={disabled}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <Input
            id={`${base}-label-${i}`}
            aria-label={`${t("param.label")} ${i + 1}`}
            placeholder={t("param.label")}
            value={row.label}
            disabled={disabled}
            onChange={(e) => update(i, { label: e.target.value })}
          />
          <Input
            id={`${base}-default-${i}`}
            aria-label={`${t("param.default")} ${i + 1}`}
            placeholder={t("param.default")}
            value={row.default}
            disabled={disabled}
            onChange={(e) => update(i, { default: e.target.value })}
          />
          <Checkbox id={`${base}-required-${i}`} label={t("param.required")} checked={row.required} disabled={disabled} onCheckedChange={(c) => update(i, { required: c })} />
          <IconButton
            icon="trash-2"
            label={t("param.remove", { row: i + 1 })}
            size="sm"
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </Stack>
      ))}
      <div>
        <Button
          size="sm"
          icon="plus"
          disabled={disabled}
          onClick={() => onChange([...rows, { name: "", label: "", default: "", required: false }])}
        >
          {t("param.add")}
        </Button>
      </div>
    </Stack>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  references,
  disabled,
}: {
  field: FieldDef;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  references?: Resource[];
  disabled?: boolean;
}) {
  const text = typeof value === "string" ? value : "";
  switch (field.type) {
    case "longtext":
      return <Textarea value={text} placeholder={field.placeholder} rows={6} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return <Input type="number" inputMode="decimal" value={text} placeholder={field.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <Input type="url" mono value={text} placeholder={field.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "boolean":
      return <Switch checked={value === true} disabled={disabled} onCheckedChange={onChange} />;
    case "select": {
      const options: SelectOption[] = (field.options ?? []).filter((o) => o.value !== "").map((o) => ({ value: o.value, label: o.label }));
      if (!field.required) options.unshift({ value: NONE, label: t("common.none") });
      return (
        <Select
          options={options}
          value={text === "" ? (field.required ? undefined : NONE) : text}
          placeholder={field.placeholder ?? t("edit.selectPlaceholder")}
          disabled={disabled}
          onValueChange={(v) => onChange(v === NONE ? "" : v)}
        />
      );
    }
    case "reference": {
      const candidates = (references ?? []).filter((r) => !field.refKind || r.kind === field.refKind);
      const options: SelectOption[] = candidates.map((r) => ({ value: r.id, label: r.name }));
      if (text && !candidates.some((r) => r.id === text)) options.unshift({ value: text, label: t("edit.referenceMissing", { id: text }) });
      options.unshift({ value: NONE, label: t("common.none") });
      return (
        <Select
          options={options}
          value={text === "" ? NONE : text}
          placeholder={t("edit.referencePlaceholder")}
          disabled={disabled}
          onValueChange={(v) => onChange(v === NONE ? "" : v)}
        />
      );
    }
    case "parameter":
      return <ParameterEditor rows={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} />;
    default:
      return <Input value={text} placeholder={field.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function SchemaFields({ fields, values, errors, onChange, references, disabled }: SchemaFieldsProps) {
  return (
    <>
      {fields.map((field) => (
        <FormField
          key={field.name}
          label={field.label}
          description={field.description}
          error={errors[field.name]}
          required={field.required}
          requiredMark={t("common.requiredMark")}
        >
          <FieldControl
            field={field}
            value={values[field.name]}
            onChange={(v) => onChange(field.name, v)}
            references={references}
            disabled={disabled}
          />
        </FormField>
      ))}
    </>
  );
}
