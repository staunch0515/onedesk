import { isOneDeskError, type Resource } from "../plugin-api";
import { t } from "./i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/** Local date-time `YYYY-MM-DD HH:mm` (data is stored in UTC, D81). */
export function formatDateTime(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Snapshot / export names carry a UTC stamp `YYYYMMDD-HHMMSS` (D81); returns the Date or null. */
export function parseUtcStamp(name: string): Date | null {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local time of a snapshot name, or the name itself when it carries no stamp. */
export function snapshotTime(name: string): string {
  const d = parseUtcStamp(name);
  return d ? formatDateTime(d) : name;
}

export interface ErrorInfo {
  message: string;
  hint?: string;
  code?: string;
  fields?: Record<string, string>;
}

/** User-facing reason (+ hint) of anything thrown by the kernel, the platform or a plugin. */
export function errorInfo(e: unknown): ErrorInfo {
  if (isOneDeskError(e)) {
    const info: ErrorInfo = { message: e.message, code: e.code };
    if (e.hint) info.hint = e.hint;
    if (e.fields) info.fields = e.fields;
    return info;
  }
  if (e instanceof Error && e.message) return { message: e.message };
  if (typeof e === "string" && e) return { message: e };
  return { message: t("common.unknownError") };
}

export function groupLabel(group: string): string {
  return group.trim() === "" ? t("common.ungrouped") : group;
}

/** "a, b，c" → ["a", "b", "c"] (both comma widths, trimmed, deduplicated). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,，]/)) {
    const tag = part.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function formatTags(tags: string[]): string {
  return tags.join(", ");
}

export function byName(a: Resource, b: Resource): number {
  return a.name.localeCompare(b.name, "zh-CN");
}
