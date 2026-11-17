import { describe, expect, it } from "vitest";
import type { ProtocolClient } from "../protocol";
import { createStore } from "./store";
import { openStartupPage } from "./startup";

const clientWith = (startupPages: string[] | undefined, fail = false) => ({ workspace: { info: async () => (fail ? Promise.reject(new Error("x")) : { id: "w", name: "w", startupPages }) } }) as unknown as ProtocolClient;
const tab = { id: "t1", target: "resource:a", title: "a", icon: "file", pinned: false, envId: null, params: {} };

describe("startup page", () => {
  it("opens the first startup page when there is no tab", async () => {
    const store = createStore(null, () => undefined);
    expect(await openStartupPage(clientWith(["page:org.a/welcome", "page:org.b/x"]), store)).toBe(true);
    expect(store.get().tabs.map((t) => t.target)).toEqual(["page:org.a/welcome"]);
    expect(store.get().activeTabId).toBe(store.get().tabs[0]!.id);
  });

  it("does nothing when a tab was restored", async () => {
    const store = createStore({ tabs: [tab], activeTabId: "t1" }, () => undefined);
    expect(await openStartupPage(clientWith(["page:org.a/welcome"]), store)).toBe(false);
    expect(store.get().tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("does nothing without a startup page, or when the workspace cannot answer", async () => {
    const a = createStore(null, () => undefined);
    expect(await openStartupPage(clientWith(undefined), a)).toBe(false);
    expect(await openStartupPage(clientWith([]), a)).toBe(false);
    expect(await openStartupPage(clientWith(["page:x/y"], true), a)).toBe(false);
    expect(a.get().tabs).toEqual([]);
  });

  it("is not repeated once the user closed the page (it only runs at start)", async () => {
    const store = createStore(null, () => undefined);
    const client = clientWith(["page:org.a/welcome"]);
    await openStartupPage(client, store);
    store.set({ tabs: [], activeTabId: null });
    // Nothing calls it again: the tab stays closed.
    expect(store.get().tabs).toEqual([]);
  });
});
