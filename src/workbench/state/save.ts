import type { ProtocolClient } from "../protocol";
import type { Store } from "./store";

/**
 * Writes a tab's unsaved bound values with `page.save` (D259) for every kind of target, with the
 * `basis` of the page the user was looking at so a change made elsewhere is a `conflict`.
 * On success the tab takes the saved page's basis and re-resolves; what was typed while the save was
 * in flight stays unsaved. Throws what the protocol throws (the caller shows it).
 * Returns the resource id when a `new:` target was created.
 */
export async function saveTab(client: ProtocolClient, store: Store, tabId: string): Promise<string | undefined> {
  const tab = store.get().tabs.find((t) => t.id === tabId);
  const draft = store.get().drafts[tabId];
  if (!tab || !draft || Object.keys(draft).length === 0) return undefined;
  const isNew = tab.target.startsWith("new:");
  const { page } = await client.page.save(tab.target, draft, isNew ? undefined : tab.basis);
  store.set((st) => {
    const now = { ...(st.drafts[tabId] ?? {}) };
    for (const [k, v] of Object.entries(draft)) if (now[k] === v) delete now[k];
    return {
      drafts: { ...st.drafts, [tabId]: now },
      tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, target: page.target, title: page.title || t.title, basis: page.basis, reload: (t.reload ?? 0) + 1 } : t)),
    };
  });
  return isNew ? page.resourceId : undefined;
}
