import type { ProtocolClient } from "../protocol";
import type { Store } from "./store";

/**
 * The startup page (round 11, D382): a client that starts with no tab at all opens the first startup page of the
 * enabled plugins (`workspace.info().startupPages`, ordered by plugin id). Called once at start, never later, so a
 * user who closes the page does not get it back until the next start that has no tab.
 * Returns true when a tab was opened.
 */
export async function openStartupPage(client: ProtocolClient, store: Store): Promise<boolean> {
  if (store.get().tabs.length > 0) return false;
  let target: string | undefined;
  try {
    target = (await client.workspace.info()).startupPages?.find((p) => p.startsWith("page:"));
  } catch {
    return false;
  }
  if (!target) return false;
  const tab = { id: "t-startup", target, title: "", icon: "loader", pinned: false, envId: store.get().lastEnvId, params: {} };
  store.set({ tabs: [tab], activeTabId: tab.id });
  return true;
}
