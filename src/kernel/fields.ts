/** Validation of values against FieldDef lists (kind schemas, action inputs, plugin settings). See D62. */
import { ParameterDefSchema, SafeHrefSchema } from "../plugin-api";
import type { FieldDef } from "../plugin-api";

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function checkValue(field: FieldDef, value: unknown): string | undefined {
  switch (field.type) {
    case "text":
    case "longtext":
      return typeof value === "string" ? undefined : "必须是文本";
    case "url":
      if (typeof value !== "string") return "必须是网址";
      if (!SafeHrefSchema.safeParse(value).success) return "只支持 http、https、mailto 网址";
      try {
        new URL(value);
        return undefined;
      } catch {
        return "的网址格式不正确";
      }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "必须是数字";
    case "boolean":
      return typeof value === "boolean" ? undefined : "必须是布尔值";
    case "select":
      if (typeof value !== "string") return "必须从选项中选择";
      return (field.options ?? []).some((o) => o.value === value) ? undefined : "不在可选范围内";
    case "reference":
      return typeof value === "string" ? undefined : "必须是资源 id";
    case "parameter": {
      if (!Array.isArray(value)) return "必须是参数列表";
      const seen = new Set<string>();
      for (const item of value) {
        const parsed = ParameterDefSchema.safeParse(item);
        if (!parsed.success) return `中的参数定义不正确：${parsed.error.issues[0]?.message ?? "格式错误"}`;
        if (seen.has(parsed.data.name)) return `中的参数名重复：${parsed.data.name}`;
        seen.add(parsed.data.name);
      }
      return undefined;
    }
  }
}

/** Error messages keyed by field name; empty object = valid. Keys of `values` that are not fields are ignored. */
export function validateFields(fields: FieldDef[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (isEmpty(value)) {
      // `false` and 0 are real values, so only truly missing values count as empty.
      if (field.required) errors[field.name] = `${field.label}不能为空`;
      continue;
    }
    const problem = checkValue(field, value);
    if (problem) errors[field.name] = `${field.label}${problem}`;
  }
  return errors;
}

/** Fills missing values from `field.default`. */
export function applyDefaults(fields: FieldDef[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const field of fields) {
    if (isEmpty(out[field.name]) && field.default !== undefined) out[field.name] = field.default;
  }
  return out;
}
