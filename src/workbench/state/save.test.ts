import { describe, expect, it } from "vitest";
import { KernelError } from "../protocol/errors";
import type { ProtocolClient } from "../protocol";
import { saveTab } from "./save";
import { createStore } from "./store";

type Call = { target: string; changes: Record<string, unknown>; basis?: string };

function setup(target: string, save: (c: Call) => unknown = () => ({ target, title: "T", basis: "2", resourceId: undefined })) {
  const calls: Call[] = [];
  const client = {
    page: {
      async save(t: string, changes: Record<string, unknown>, basis?: string) {
        const call = { target: t, changes, basis };
        calls.push(call);
        const out = save(call);
        if (out instanceof Error) throw out;
        return { page: out };
      },
    },
  } as unknown as ProtocolClient;
  const store = createStore(null, () => undefined);
  store.set({
    tabs: [{ id: "t1", target, title: "T", icon: "file", pinned: false, envId: null, params: {}, basis: "1" }],
    activeTabId: "t1",
    drafts: { t1: { "body.text": "hello" } },
  });
  return { client, store, calls };
}

describe("saveTab", () => {
  it("saves a node: page (file) with its basis, clears the draft and re-resolves the page", async () => {
    const { client, store, calls } = setup("node:files/a.txt");
    await saveTab(client, store, "t1");
    expect(calls).toEqual([{ target: "node:files/a.txt", changes: { "body.text": "hello" }, basis: "1" }]);
    const tab = store.get().tabs[0]!;
    expect(store.get().drafts.t1).toEqual({});
    expect(tab.basis).toBe("2");
    expect(tab.reload).toBe(1);
  });

  it("sends the basis for resource: pages and none for new: pages", async () => {
    const a = setup("resource:r1", () => ({ target: "resource:r1", title: "T", basis: "5" }));
    await saveTab(a.client, a.store, "t1");
    expect(a.calls[0]?.basis).toBe("1");
    const b = setup("new:x:y?parent=g", () => ({ target: "resource:new1", title: "Fresh", basis: "1", resourceId: "new1" }));
    const created = await saveTab(b.client, b.store, "t1");
    expect(b.calls[0]?.basis).toBeUndefined();
    expect(created).toBe("new1");
    expect(b.store.get().tabs[0]).toMatchObject({ target: "resource:new1", title: "Fresh" });
  });

  it("keeps the draft and the old basis when the kernel answers conflict", async () => {
    const { client, store } = setup("resource:r1", () => new KernelError("conflict"));
    await expect(saveTab(client, store, "t1")).rejects.toMatchObject({ code: "conflict" });
    expect(store.get().drafts.t1).toEqual({ "body.text": "hello" });
    expect(store.get().tabs[0]?.basis).toBe("1");
  });

  it("does nothing without a draft", async () => {
    const { client, store, calls } = setup("resource:r1");
    store.set({ drafts: {} });
    await saveTab(client, store, "t1");
    expect(calls).toHaveLength(0);
  });
});
