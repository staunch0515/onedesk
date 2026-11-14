/**
 * New resource: kind (enabled plugins only), name, group, plus the kind's required fields (so the body is valid
 * on creation). Then opens the resource on its “编辑” tab.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Banner, Button, Dialog, DialogClose, EmptyState, FormField, Input, Select, Stack, useToast } from "../design";
import { CORE_EDIT_VIEW } from "../kernel/contracts";
import { errorInfo } from "./format";
import { t } from "./i18n";
import { initialValues, validateValues, valuesToData, type FormValue, type FormValues } from "./schema-form";
import { SchemaFields } from "./schema-fields";
import { useShell } from "./shell-context";

export interface NewResourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: { kind?: string; group?: string };
}

export function NewResourceDialog({ open, onOpenChange, preset }: NewResourceDialogProps) {
  const { kernel, navigate } = useShell();
  const { toast } = useToast();
  const kinds = useMemo(() => (open ? kernel.registry.kinds() : []), [kernel, open]);
  const [kind, setKind] = useState("");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);

  const kindDef = kinds.find((k) => k.id === kind);
  const requiredFields = useMemo(() => (kindDef ? kindDef.schema.filter((f) => f.required) : []), [kindDef]);

  useEffect(() => {
    if (!open) return;
    const first = preset?.kind && kernel.registry.kind(preset.kind) ? preset.kind : (kernel.registry.kinds()[0]?.id ?? "");
    setKind(first);
    setName("");
    setGroup(preset?.group ?? "");
    setErrors({});
    setFormError(null);
    setSaving(false);
    void kernel.resources.groups().then(setGroups, () => setGroups([]));
  }, [open, preset, kernel]);

  useEffect(() => {
    setValues(kindDef ? initialValues(kindDef.schema, {}, true) : {});
  }, [kindDef]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    const next: Record<string, string> = {};
    if (!kind) next.kind = t("new.kindRequired");
    if (!name.trim()) next.name = t("new.nameRequired");
    Object.assign(next, validateValues(requiredFields, values));
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const body = kindDef ? valuesToData(kindDef.schema, values) : {};
      const created = await kernel.resources.create({ kind, name: name.trim(), group: group.trim(), body });
      onOpenChange(false);
      toast({ title: t("new.created", { name: created.name }), tone: "success" });
      await navigate({ page: "resource", id: created.id, tab: CORE_EDIT_VIEW });
    } catch (err) {
      const info = errorInfo(err);
      if (info.fields) setErrors(info.fields);
      const shown = info.fields ? Object.keys(info.fields).filter((k) => k === "name" || k === "group" || requiredFields.some((f) => f.name === k)) : [];
      if (!info.fields || shown.length < Object.keys(info.fields).length) setFormError(info.hint ? `${info.message}（${info.hint}）` : info.message);
    } finally {
      setSaving(false);
    }
  };

  const setValue = (field: string, value: FormValue) => setValues((v) => ({ ...v, [field]: value }));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("new.title")}
      description={kinds.length ? t("new.description") : undefined}
      closeLabel={t("common.close")}
      dismissible={!saving}
      footer={
        kinds.length ? (
          <>
            <DialogClose>
              <Button disabled={saving}>{t("common.cancel")}</Button>
            </DialogClose>
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              {t("new.submit")}
            </Button>
          </>
        ) : (
          <DialogClose>
            <Button>{t("common.close")}</Button>
          </DialogClose>
        )
      }
    >
      {kinds.length === 0 ? (
        <EmptyState layout="inline" message={t("new.noKinds")} />
      ) : (
        <form
          onSubmit={(e) => void submit(e)}
          onKeyDown={(e) => {
            // Enter in a single-line field submits (textareas keep Enter for new lines).
            if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName === "INPUT") {
              e.preventDefault();
              void submit();
            }
          }}
        >
          <Stack gap="md">
            {formError && <Banner tone="danger">{formError}</Banner>}
            <FormField label={t("new.kind")} required requiredMark={t("common.requiredMark")} error={errors.kind}>
              <Select
                options={kinds.map((k) => ({ value: k.id, label: k.name, icon: k.icon }))}
                value={kind || undefined}
                placeholder={t("new.kindPlaceholder")}
                onValueChange={setKind}
              />
            </FormField>
            <FormField label={t("new.name")} required requiredMark={t("common.requiredMark")} error={errors.name}>
              <Input value={name} placeholder={t("new.namePlaceholder")} autoFocus onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField
              label={t("new.group")}
              error={errors.group}
              description={groups.length ? t("new.groupDescription", { groups: groups.filter(Boolean).join("、") }) : t("new.groupDescriptionNone")}
            >
              <Input value={group} onChange={(e) => setGroup(e.target.value)} />
            </FormField>
            <SchemaFields fields={requiredFields} values={values} errors={errors} onChange={setValue} />
          </Stack>
        </form>
      )}
    </Dialog>
  );
}
