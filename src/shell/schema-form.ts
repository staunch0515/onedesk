/**
 * Form model generated from a field schema (kind schema, action input, plugin settings).
 * Values are kept in editing form (numbers as text) and converted back to body values on save.
 */
import type { FieldDef, ParameterDef } from "../plugin-api";
import { t } from "./i18n";

export type FormValue = string | boolean | ParameterRow[];
export type FormValues = Record<string, FormValue>;

/** A parameter row while editing (all text, so half-typed rows are kept). */
export interface ParameterRow {
  name: string;
  label: string;
  default: string;
  required: boolean;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_RE = /^(https?:\/\/[^\s/?#]+|mailto:\S+)/i;

function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

function toRows(v: unknown): ParameterRow[] {
  if (!Array.isArray(v)) return [];
  return v.map((p) => {
    const o = (typeof p === "object" && p !== null ? p : {}) as Partial<ParameterDef>;
    return { name: asText(o.name), label: asText(o.label), default: asText(o.default), required: o.required === true };
  });
}

/** Editing values from stored data; `useDefaults` fills missing values from `field.default` (new data, action input). */
export function initialValues(fields: FieldDef[], data: Record<string, unknown>, useDefaults = false): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    const raw = data[f.name] !== undefined ? data[f.name] : useDefaults ? f.default : undefined;
    switch (f.type) {
      case "boolean":
        values[f.name] = raw === true;
        break;
      case "parameter":
        values[f.name] = toRows(raw);
        break;
      default:
        values[f.name] = asText(raw);
    }
  }
  return values;
}

/** Field values in their stored shape; empty values are omitted. */
export function valuesToData(fields: FieldDef[], values: FormValues, base: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const f of fields) {
    const v = values[f.name];
    delete out[f.name];
    switch (f.type) {
      case "boolean":
        out[f.name] = v === true;
        break;
      case "number": {
        const s = typeof v === "string" ? v.trim() : "";
        if (s !== "") out[f.name] = Number(s);
        break;
      }
      case "parameter": {
        const rows = (Array.isArray(v) ? v : []).filter((r) => r.name.trim() || r.label.trim() || r.default !== "");
        if (rows.length === 0) break;
        out[f.name] = rows.map((r) => {
          const p: ParameterDef = { name: r.name.trim() };
          if (r.label.trim()) p.label = r.label.trim();
          if (r.default !== "") p.default = r.default;
          if (r.required) p.required = true;
          return p;
        });
        break;
      }
      default: {
        const s = typeof v === "string" ? v : "";
        if (s.trim() !== "") out[f.name] = f.type === "url" ? s.trim() : s;
      }
    }
  }
  return out;
}

function isEmpty(f: FieldDef, v: FormValue | undefined): boolean {
  if (f.type === "boolean") return false;
  if (f.type === "parameter") return !Array.isArray(v) || v.length === 0;
  return typeof v !== "string" || v.trim() === "";
}

/** Client-side checks with field-level messages (the kernel validates again on save). */
export function validateValues(fields: FieldDef[], values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (isEmpty(f, v)) {
      if (f.required) errors[f.name] = t("field.required", { label: f.label });
      continue;
    }
    switch (f.type) {
      case "number":
        if (!Number.isFinite(Number((v as string).trim()))) errors[f.name] = t("field.number", { label: f.label });
        break;
      case "url":
        if (!URL_RE.test((v as string).trim())) errors[f.name] = t("field.url", { label: f.label });
        break;
      case "select":
        if (!f.options?.some((o) => o.value === v)) errors[f.name] = t("field.select", { label: f.label });
        break;
      case "parameter": {
        const error = validateParameterRows(v as ParameterRow[]);
        if (error) errors[f.name] = error;
        break;
      }
    }
  }
  return errors;
}

export function validateParameterRows(rows: ParameterRow[]): string | undefined {
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const name = r.name.trim();
    if (!name) {
      if (r.label.trim() || r.default !== "" || r.required) return t("field.paramEmptyName", { row: i + 1 });
      continue;
    }
    if (!NAME_RE.test(name)) return t("field.paramName");
    if (seen.has(name)) return t("field.paramDuplicate", { name });
    seen.add(name);
  }
  return undefined;
}

/** Action input: values in the shape `actions.run` expects (strings for text fields, D72). */
export function valuesToInput(fields: FieldDef[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === "boolean") out[f.name] = v === true;
    else if (f.type === "number") {
      const s = typeof v === "string" ? v.trim() : "";
      if (s !== "") out[f.name] = Number(s);
    } else if (f.type === "parameter") out[f.name] = valuesToData([f], values)[f.name] ?? [];
    else out[f.name] = typeof v === "string" ? v : "";
  }
  return out;
}

export function sameValues(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
