import type { ViewField } from "../protocol";

/**
 * The run parameters to send. A value shown from the environment is a placeholder, not something the
 * user entered: on kernel pages only what was filled in on this tab goes out (the plugin reads the
 * environment itself with `host.params.get`). Demo pages keep sending the displayed value.
 */
export function runParams(fields: ViewField[], entered: Record<string, string>, kernelPage: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const value = entered[f.name] ?? "";
    if (kernelPage) {
      if (value !== "") out[f.name] = value;
    } else out[f.name] = value || f.envValue || "";
  }
  return out;
}

/**
 * View state of a page (D467): page parameters named `view.<x>` that no field shows — e.g. a note's reading/editing
 * mode, switched by an action in the actions row. A page event may set them; they go back to the page's own render and
 * events, never to a run.
 */
export const VIEW_PREFIX = "view.";
const MAX_VIEW_VALUE = 200;
const isView = (name: string, value: unknown): value is string => name.startsWith(VIEW_PREFIX) && name.length > VIEW_PREFIX.length && typeof value === "string" && value.length <= MAX_VIEW_VALUE;

/** The view-state parameters (`view.<x>`) of a tab. */
export function viewParams(entered: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(entered ?? {}).filter(([name, value]) => isView(name, value)));
}

/**
 * `PageEventResult.params` (D358) may only set the page's own parameter fields (`param: true`) and its view state
 * (`view.<x>`, D467): the kernel passes the plugin's keys through unfiltered, so any other key is dropped here.
 * Returns the merged params, or `null` when nothing applies.
 */
export function applyPageParams(fields: ViewField[], current: Record<string, string>, returned: Record<string, string> | undefined): Record<string, string> | null {
  const allowed = new Set(fields.map((f) => f.name));
  const picked = Object.entries(returned ?? {}).filter(([name, value]) => (allowed.has(name) && typeof value === "string") || isView(name, value));
  return picked.length > 0 ? { ...current, ...Object.fromEntries(picked) } : null;
}
