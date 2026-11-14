/**
 * Remembers the display data of every kind seen (name, icon, field labels) in kernel.prefs, so resources of a
 * disabled plugin can still show readable field names — the kernel forgets a kind's schema when it is disabled.
 */
import type { Kernel } from "../kernel/contracts";

export const KIND_CACHE_PREF = "shell.kindCache";

export interface CachedKind {
  name: string;
  icon?: string;
  /** Field name → label, in schema order. */
  fields: Record<string, string>;
}
export type KindCache = Record<string, CachedKind>;

export function normalizeKindCache(value: unknown): KindCache {
  if (typeof value !== "object" || value === null) return {};
  const out: KindCache = {};
  for (const [kind, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.fields !== "object" || o.fields === null) continue;
    const fields: Record<string, string> = {};
    for (const [k, label] of Object.entries(o.fields as Record<string, unknown>)) if (typeof label === "string") fields[k] = label;
    out[kind] = { name: o.name, fields, ...(typeof o.icon === "string" ? { icon: o.icon } : {}) };
  }
  return out;
}

/** Merges the currently registered kinds into the cache; writes only when something changed. */
export async function rememberKinds(kernel: Kernel): Promise<KindCache> {
  const stored = normalizeKindCache(await kernel.prefs.get(KIND_CACHE_PREF));
  const next: KindCache = { ...stored };
  for (const k of kernel.registry.kinds()) {
    const entry: CachedKind = { name: k.name, fields: Object.fromEntries(k.schema.map((f) => [f.name, f.label])) };
    if (k.icon) entry.icon = k.icon;
    next[k.id] = entry;
  }
  if (JSON.stringify(next) !== JSON.stringify(stored)) await kernel.prefs.set(KIND_CACHE_PREF, next);
  return next;
}
