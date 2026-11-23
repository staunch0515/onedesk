/**
 * Prototype of layout step 2 (docs/handoff/prototype-layout-v2.md): the new layout is the default; `?layout=classic`
 * shows the current one for comparison (remembered until `?layout=new`). main.tsx writes the choice to
 * `<html data-layout>` before the first render; where nothing set it (unit tests) the new layout applies.
 */
export type LayoutMode = "classic" | "new";

const KEY = "onedesk.prototype.layout";

export function pickLayout(query: URLSearchParams): LayoutMode {
  const asked = query.get("layout");
  if (asked === "classic" || asked === "new") {
    try {
      localStorage.setItem(KEY, asked);
    } catch {
      /* no storage: the address decides every time */
    }
    return asked;
  }
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "new";
  } catch {
    return "new";
  }
}

export function layoutMode(): LayoutMode {
  return typeof document !== "undefined" && document.documentElement.dataset.layout === "classic" ? "classic" : "new";
}

/** From this window width up the info panel sits left of the content (near the tree); below it, on the right. */
export const INFO_LEFT_MIN_WIDTH = 1600;

