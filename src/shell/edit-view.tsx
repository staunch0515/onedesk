/**
 * The generic “编辑” view (D12): common fields + kind fields generated from the schema.
 * The draft lives in `useEditDraft` (owned by the resource page) so it survives tab switches and ⌘S works.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, FormField, Input, Section, Select, Stack, Switch, Textarea } from "../design";
import type { Kernel } from "../kernel/contracts";
import type { FieldDef, Resource } from "../plugin-api";
import { errorInfo, formatTags, parseTags } from "./format";
import { t } from "./i18n";
import { initialValues, sameValues, validateValues, valuesToData, type FormValue, type FormValues } from "./schema-form";
import { SchemaFields } from "./schema-fields";

export interface GeneralDraft {
  name: string;
  group: string;
  tags: string;
  description: string;
  visibility: Resource["visibility"];
  aiVisible: boolean;
}

function generalOf(r: Resource): GeneralDraft {
  return { name: r.name, group: r.group, tags: formatTags(r.tags), description: r.description, visibility: r.visibility, aiVisible: r.aiVisible };
}

export function validateGeneral(g: GeneralDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!g.name.trim()) errors.name = t("field.required", { label: t("edit.name") });
  if (parseTags(g.tags).some((tag) => tag.includes('"') || tag.includes("\\"))) errors.tags = t("field.tagsInvalid");
  return errors;
}

export interface EditDraft {
  general: GeneralDraft;
  values: FormValues;
  errors: Record<string, string>;
  formError: string | null;
  conflict: boolean;
  dirty: boolean;
  saving: boolean;
  setGeneral: (patch: Partial<GeneralDraft>) => void;
  setValue: (name: string, value: FormValue) => void;
  save: () => Promise<boolean>;
  reset: () => void;
}

export function useEditDraft(kernel: Kernel, resource: Resource | null, schema: FieldDef[]): EditDraft {
  const baseGeneral = useMemo(() => (resource ? generalOf(resource) : null), [resource]);
  const baseValues = useMemo(() => (resource ? initialValues(schema, resource.body) : {}), [resource, schema]);
  const [general, setGeneralState] = useState<GeneralDraft | null>(baseGeneral);
  const [values, setValues] = useState<FormValues>(baseValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [baseVersion, setBaseVersion] = useState<{ id: string; version: number } | null>(null);
  const justSaved = useRef(false);

  const dirty = general !== null && baseGeneral !== null && (!sameValues(general, baseGeneral) || !sameValues(values, baseValues));

  const reset = useCallback(() => {
    setGeneralState(baseGeneral);
    setValues(baseValues);
    setErrors({});
    setFormError(null);
    setConflict(false);
    justSaved.current = false;
    setBaseVersion(resource ? { id: resource.id, version: resource.version } : null);
  }, [baseGeneral, baseValues, resource]);

  // New resource, or a newer version saved elsewhere while there are no local edits: take it.
  useEffect(() => {
    if (!resource) return;
    const switched = baseVersion?.id !== resource.id;
    if (switched || (baseVersion?.version !== resource.version && (!dirty || justSaved.current))) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource]);

  const save = async (): Promise<boolean> => {
    if (!resource || !general || saving) return false;
    const local = { ...validateGeneral(general), ...validateValues(schema, values) };
    const body = valuesToData(schema, values, resource.body);
    const kernelErrors = Object.keys(local).length ? {} : kernel.resources.validate(resource.kind, body);
    const all = { ...kernelErrors, ...local };
    setErrors(all);
    setConflict(false);
    if (Object.keys(all).length) {
      setFormError(t("edit.fixErrors"));
      return false;
    }
    setFormError(null);
    setSaving(true);
    try {
      await kernel.resources.update(resource.id, {
        name: general.name.trim(),
        group: general.group.trim(),
        tags: parseTags(general.tags),
        description: general.description,
        visibility: general.visibility,
        aiVisible: general.aiVisible,
        body,
        expectedVersion: baseVersion?.id === resource.id ? baseVersion.version : resource.version,
      });
      justSaved.current = true;
      return true;
    } catch (e) {
      const info = errorInfo(e);
      if (info.code === "conflict") setConflict(true);
      else {
        if (info.fields) setErrors(info.fields);
        setFormError(info.hint ? `${info.message}（${info.hint}）` : info.message);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    general: general ?? (baseGeneral as GeneralDraft),
    values,
    errors,
    formError,
    conflict,
    dirty,
    saving,
    setGeneral: (patch) => setGeneralState((g) => (g ? { ...g, ...patch } : g)),
    setValue: (name, value) => setValues((v) => ({ ...v, [name]: value })),
    save,
    reset,
  };
}

export interface EditViewProps {
  draft: EditDraft;
  schema: FieldDef[];
  references: Resource[];
  onReload: () => void;
  onSave: () => void;
}

export function EditView({ draft, schema, references, onReload, onSave }: EditViewProps) {
  const { general, errors } = draft;
  const req = t("common.requiredMark");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <Stack gap="lg">
        {draft.conflict && (
          <Banner
            tone="warning"
            title={t("edit.conflict")}
            actions={
              <Button size="sm" onClick={onReload}>
                {t("edit.reload")}
              </Button>
            }
          >
            {t("edit.conflictBody")}
          </Banner>
        )}
        {draft.formError && (
          <Banner tone="danger" title={t("edit.saveFailed")}>
            {draft.formError}
          </Banner>
        )}
        {schema.length > 0 && (
          <Section title={t("edit.fields")}>
            <Stack gap="md">
              <SchemaFields fields={schema} values={draft.values} errors={errors} onChange={draft.setValue} references={references} />
            </Stack>
          </Section>
        )}
        <Section title={t("edit.general")}>
          <Stack gap="md">
            <FormField label={t("edit.name")} required requiredMark={req} error={errors.name}>
              <Input value={general.name} onChange={(e) => draft.setGeneral({ name: e.target.value })} />
            </FormField>
            <FormField label={t("edit.group")} description={t("edit.groupDescription")} error={errors.group}>
              <Input value={general.group} onChange={(e) => draft.setGeneral({ group: e.target.value })} />
            </FormField>
            <FormField label={t("edit.tags")} description={t("edit.tagsDescription")} error={errors.tags}>
              <Input value={general.tags} onChange={(e) => draft.setGeneral({ tags: e.target.value })} />
            </FormField>
            <FormField label={t("edit.description")} error={errors.description}>
              <Textarea value={general.description} rows={3} onChange={(e) => draft.setGeneral({ description: e.target.value })} />
            </FormField>
            <FormField label={t("edit.visibility")} error={errors.visibility}>
              <Select
                value={general.visibility}
                onValueChange={(v) => draft.setGeneral({ visibility: v === "public" ? "public" : "private" })}
                options={[
                  { value: "private", label: t("edit.visibility.private") },
                  { value: "public", label: t("edit.visibility.public") },
                ]}
              />
            </FormField>
            <Switch
              label={t("edit.aiVisible")}
              description={t("edit.aiVisibleDescription")}
              checked={general.aiVisible}
              onCheckedChange={(c) => draft.setGeneral({ aiVisible: c })}
            />
          </Stack>
        </Section>
        <Stack direction="row" gap="sm" justify="end">
          <Button disabled={!draft.dirty || draft.saving} onClick={draft.reset}>
            {t("edit.reset")}
          </Button>
          <Button type="submit" variant="primary" loading={draft.saving} disabled={!draft.dirty && !draft.formError}>
            {t("common.save")}
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}
