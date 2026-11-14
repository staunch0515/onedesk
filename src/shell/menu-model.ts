/**
 * Sidebar menu model: resources grouped by `group`, ordered by the user's saved order (kernel.prefs, D64).
 * Pure functions so grouping and sorting are unit-tested without React.
 */
import type { Resource } from "../plugin-api";

export const MENU_PREFS_KEY = "shell.menu";

export interface MenuPrefs {
  /** Group names in display order ("" = ungrouped). Groups not listed follow, by name; ungrouped last. */
  groupOrder: string[];
  /** Resource ids per group in display order. Unlisted resources follow, by name. */
  itemOrder: Record<string, string[]>;
  /** Collapsed group names. */
  collapsed: string[];
}

export interface MenuGroup {
  key: string;
  items: Resource[];
}

export const EMPTY_MENU_PREFS: MenuPrefs = { groupOrder: [], itemOrder: {}, collapsed: [] };

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Accepts whatever was stored; anything malformed falls back to defaults. */
export function normalizeMenuPrefs(value: unknown): MenuPrefs {
  if (typeof value !== "object" || value === null) return EMPTY_MENU_PREFS;
  const v = value as Record<string, unknown>;
  const itemOrder: Record<string, string[]> = {};
  if (typeof v.itemOrder === "object" && v.itemOrder !== null) {
    for (const [k, ids] of Object.entries(v.itemOrder as Record<string, unknown>)) if (isStringArray(ids)) itemOrder[k] = ids;
  }
  return {
    groupOrder: isStringArray(v.groupOrder) ? v.groupOrder : [],
    itemOrder,
    collapsed: isStringArray(v.collapsed) ? v.collapsed : [],
  };
}

const compareText = (a: string, b: string) => a.localeCompare(b, "zh-CN");

function orderBy<T>(list: T[], order: string[], keyOf: (x: T) => string, fallback: (a: T, b: T) => number): T[] {
  const rank = new Map(order.map((k, i) => [k, i]));
  return [...list].sort((a, b) => {
    const ra = rank.get(keyOf(a));
    const rb = rank.get(keyOf(b));
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return fallback(a, b);
  });
}

export function buildMenu(resources: Resource[], prefs: MenuPrefs): MenuGroup[] {
  const groups = new Map<string, Resource[]>();
  for (const r of resources) {
    const key = r.group.trim();
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const keys = orderBy([...groups.keys()], prefs.groupOrder, (k) => k, (a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return compareText(a, b);
  });
  return keys.map((key) => ({
    key,
    items: orderBy(groups.get(key) ?? [], prefs.itemOrder[key] ?? [], (r) => r.id, (a, b) => compareText(a.name, b.name)),
  }));
}

/** Moves `activeId` to the position of `overId` within the group's current display order. */
export function moveItem(prefs: MenuPrefs, group: MenuGroup, activeId: string, overId: string): MenuPrefs {
  const ids = group.items.map((r) => r.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return prefs;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return { ...prefs, itemOrder: { ...prefs.itemOrder, [group.key]: next } };
}

/** Moves a group one step up (-1) or down (+1) in the current display order. */
export function moveGroup(prefs: MenuPrefs, groups: MenuGroup[], key: string, delta: -1 | 1): MenuPrefs {
  const keys = groups.map((g) => g.key);
  const from = keys.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= keys.length) return prefs;
  const next = [...keys];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return { ...prefs, groupOrder: next };
}

export function setCollapsed(prefs: MenuPrefs, key: string, collapsed: boolean): MenuPrefs {
  const rest = prefs.collapsed.filter((k) => k !== key);
  return { ...prefs, collapsed: collapsed ? [...rest, key] : rest };
}
