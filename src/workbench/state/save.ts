import type { ProtocolClient } from "../protocol";
import { KernelError } from "../protocol/errors";
import { staleFields } from "./merge";
import type { Store } from "./store";

/**
 * Writes a tab's unsaved bound values with `page.save` (D259) for every kind of target, with the
 * `basis` of the page the user was looking at. If something else changed meanwhile, the kernel merges what does not
 * touch the fields being saved and refuses the rest with `conflict` / `stale` (D374): the fields are then put in the
 * tab's pending merge (the page shows a bar to choose "keep mine" / "use new") and the draft stays untouched.
 * Fields the user chose to keep go along as `overwrite`.
 * On success the tab takes the saved page's basis and re-resolves; what was typed while the save was
 * in flight stays unsaved. Throws what the protocol throws (the caller shows it, except a stale conflict, see `staleFields`).
 * Returns the resource id when a `new:` target was created.
 */
export async function saveTab(client: ProtocolClient, store: Store, tabId: string): Promise<string | undefined> {
  const tab = store.get().tabs.find((t) => t.id === tabId);
  const draft = store.get().drafts[tabId];
  if (!tab || !draft || Object.keys(draft).length === 0) return undefined;
  const isNew = tab.target.startsWith("new:");
  const pending = store.get().merge[tabId];
  // A conflict the user has not answered yet is not sent to the kernel: the answer decides what is written.
  const open = (pending?.conflicts ?? []).filter((f) => f in draft);
  if (!isNew && open.length > 0) throw new KernelError("conflict", { reason: "stale", fields: open.join(",") });
  const overwrite = isNew ? [] : (pending?.keep ?? []).filter((f) => f in draft);
  let page;
  try {
    ({ page } = await client.page.save(tab.target, draft, isNew ? undefined : tab.basis, undefined, overwrite.length > 0 ? overwrite : undefined));
  } catch (error) {
    const stale = staleFields(error);
    if (stale) markStale(store, tabId, stale.fields.filter((f) => f in draft));
    throw error;
  }
  store.set((st) => {
    const now = { ...(st.drafts[tabId] ?? {}) };
    for (const [k, v] of Object.entries(draft)) if (now[k] === v) delete now[k];
    const { [tabId]: _done, ...merge } = st.merge;
    return {
      drafts: { ...st.drafts, [tabId]: now },
      // What was just written is now the saved value: not "changed elsewhere" when the page is read again.
      bases: { ...st.bases, [tabId]: { ...(st.bases[tabId] ?? {}), ...draft } },
      merge,
      tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, target: page.target, title: page.title || t.title, basis: page.basis, reload: (t.reload ?? 0) + 1 } : t)),
    };
  });
  return isNew ? page.resourceId : undefined;
}

/** Puts fields into the tab's pending conflicts and reads the page again so it shows the new saved values. */
export function markStale(store: Store, tabId: string, fields: string[]): void {
  store.set((st) => {
    const prev = st.merge[tabId] ?? { conflicts: [], keep: [] };
    return {
      merge: { ...st.merge, [tabId]: { conflicts: [...new Set([...prev.conflicts, ...fields])], keep: prev.keep.filter((f) => !fields.includes(f)) } },
      tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, reload: (t.reload ?? 0) + 1 } : t)),
    };
  });
}
