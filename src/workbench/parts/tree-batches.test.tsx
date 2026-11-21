// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLayout } from "../../design/testing/layout";
import type { TreeInfo, TreeNode, TreePage } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { isSyntheticKey, TreePanel } from "./side-panel";

const BATCH = 200;
const node = (i: number): TreeNode => ({ key: `n${i}`, tree: "big", label: `Node ${i}`, icon: "file", kind: "x", expandable: false, state: "ok", menu: [], draggable: false, accepts: [] });
let seq = 0;
// A tree panel remembers what it read per tree id; every test uses its own tree.
const infoOf = () =>
  ({ id: `big${seq++}`, title: "Big", icon: "list", source: "provided", toolbar: [], menu: [], groups: false }) as unknown as TreeInfo;

function setup(total: number, fail?: () => boolean) {
  const children = vi.fn(async (_tree: string, _parent: string | null, offset = 0): Promise<TreePage> => {
    if (fail?.()) throw new Error("boom");
    const nodes = Array.from({ length: Math.min(BATCH, total - offset) }, (_, i) => node(offset + i));
    return { nodes, ...(offset + BATCH < total ? { next: offset + BATCH } : {}) };
  });
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
  const client = { ...base, tree: { ...base.tree, children, path: async () => [] } };
  renderInShell(client, <TreePanel tree={infoOf()} />);
  const scroller = () => document.querySelector<HTMLElement>(".od-tree")!;
  const offsets = () => children.mock.calls.map((c) => c[2] ?? 0);
  return { children, scroller, offsets };
}

describe("a long level is read batch by batch as it is scrolled (D373)", () => {
  let restore = () => undefined as void;
  beforeEach(() => {
    restore = fakeLayout({ viewport: 260, tokens: { "--tree-row-height": "26px" } });
  });
  afterEach(() => restore());

  it("reads only the first batch at first, and the next one when the end of the loaded part comes into view", async () => {
    const { scroller, offsets, children } = setup(1000);
    expect(await screen.findByText("Node 0")).toBeTruthy();
    expect(offsets()).toEqual([0]);
    expect(document.querySelectorAll('[role="treeitem"]').length).toBeLessThan(40); // not 200

    scroller().scrollTop = 26 * 195;
    fireEvent.scroll(scroller());
    await waitFor(() => expect(offsets()).toEqual([0, 200]));
    expect(await screen.findByText("Node 399", {}, { timeout: 100 }).catch(() => null)).toBeNull(); // 400 are known, but only what is in view is drawn
    expect(children).toHaveBeenCalledTimes(2);
  });

  it("the last batch ends the level: no more asking, no placeholder", async () => {
    const { scroller, offsets } = setup(250);
    await screen.findByText("Node 0");
    scroller().scrollTop = 26 * 195;
    fireEvent.scroll(scroller());
    await waitFor(() => expect(offsets()).toEqual([0, 200]));
    scroller().scrollTop = 26 * 250;
    fireEvent.scroll(scroller());
    await screen.findByText("Node 249");
    expect(document.querySelector("[data-more]")).toBeNull();
    expect(offsets()).toEqual([0, 200]);
  });

  it("a level longer than the old 5000 cap can be read to its end", async () => {
    const { scroller, offsets } = setup(20000);
    await screen.findByText("Node 0");
    for (let batch = 1; batch <= 26; batch++) {
      scroller().scrollTop = 26 * (batch * 200 - 5);
      fireEvent.scroll(scroller());
      await waitFor(() => expect(offsets()).toContain(batch * 200));
    }
    expect(offsets().length).toBe(27); // 27 batches = 5 400 nodes, past the old 5 000 cap
  }, 30000);

  it("a batch that fails is reported and the loaded part stays", async () => {
    let failing = false;
    const { scroller, offsets } = setup(1000, () => failing);
    await screen.findByText("Node 0");
    failing = true;
    scroller().scrollTop = 26 * 195;
    fireEvent.scroll(scroller());
    await waitFor(() => expect(offsets()).toEqual([0, 200]));
    // the failed batch is not asked for again and again
    await new Promise((r) => setTimeout(r, 200));
    expect(offsets()).toEqual([0, 200]);
    expect(screen.getByText("Node 195")).toBeTruthy(); // what was read is still there
  });
});

describe("review fixes for long levels (round 10)", () => {
  let restore = () => undefined as void;
  beforeEach(() => {
    restore = fakeLayout({ viewport: 260, tokens: { "--tree-row-height": "26px" } });
  });
  afterEach(() => restore());

  function setup2(opts: { children: (parent: string | null, offset: number) => TreePage; path?: (key: string) => string[]; tabNode?: string }) {
    const info = infoOf();
    const children = vi.fn(async (_t: string, parent: string | null, offset = 0) => opts.children(parent, offset));
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, tree: { ...base.tree, children, path: async (_t: string, key: string) => opts.path?.(key) ?? [key] } };
    const { store } = renderInShell(client, <TreePanel tree={info} />);
    if (opts.tabNode) {
      store.set({
        tabs: [{ id: "t1", target: "resource:x", title: "X", icon: "file", pinned: false, envId: null, params: {}, node: { tree: info.id, key: opts.tabNode } }],
        activeTabId: "t1",
      });
    }
    return { children, store, offsets: () => children.mock.calls.map((c) => c[2] ?? 0), scroller: () => document.querySelector<HTMLElement>(".od-tree")! };
  }
  const nodeOf = (key: string, over: Partial<TreeNode> = {}): TreeNode => ({ key, tree: "t", label: key, icon: "file", kind: "x", expandable: false, state: "ok", menu: [], draggable: false, accepts: [], ...over });
  const batchOf = (total: number, size: number) => (_p: string | null, offset: number): TreePage => ({
    nodes: Array.from({ length: Math.min(size, total - offset) }, (_, i) => nodeOf(`n${offset + i}`)),
    ...(offset + size < total ? { next: offset + size } : {}),
  });

  it("small batches (each shorter than the screen) are read one after another until the screen is full", async () => {
    const { offsets } = setup2({ children: batchOf(100, 4) });
    await screen.findByText("n0");
    await waitFor(() => expect(screen.queryByText("n12")).toBeTruthy()); // more than the 4 of the first batch, without any scrolling
    expect(offsets().length).toBeGreaterThan(2);
    await new Promise((r) => setTimeout(r, 150));
    expect(offsets().length).toBeLessThan(10); // and then it stops: the screen is full
  });

  it("the node of the active tab is found even when it sits in a later batch: read on, selected and drawn", async () => {
    const { offsets } = setup2({ children: batchOf(1000, 200), tabNode: "n650" });
    const row = await screen.findByText("n650", {}, { timeout: 3000 });
    expect(row.closest('[role="treeitem"]')!.getAttribute("aria-selected")).toBe("true");
    expect(Math.max(...offsets())).toBe(600); // read on only as far as the node
  });

  it("a node that never turns up stops the search at the end of the level", async () => {
    const { offsets } = setup2({ children: batchOf(450, 200), tabNode: "elsewhere" });
    await screen.findByText("n0");
    await waitFor(() => expect(offsets()).toContain(400));
    await new Promise((r) => setTimeout(r, 100));
    expect(Math.max(...offsets())).toBe(400); // the end of the level: nothing beyond it was asked for
  });

  it("a plugin that keeps answering the same `next` does not make the panel loop", async () => {
    const { offsets } = setup2({ children: (_p, offset) => ({ nodes: offset === 0 ? [nodeOf("a"), nodeOf("b")] : [], next: 5 }), tabNode: "zzz" });
    await screen.findByText("a");
    await new Promise((r) => setTimeout(r, 300));
    expect(offsets().length).toBeLessThan(6);
  });

  it("a node that fails to load is drawn with words, not blank", async () => {
    setup2({ children: () => ({ nodes: [nodeOf("!r/", { label: "", state: "load-failed", stateReason: "pluginError" })] }) });
    const row = (await screen.findByText("Could not load")).closest('[role="treeitem"]')!;
    expect(row.getAttribute("data-state")).toBe("load-failed");
    expect(row.getAttribute("title")).toContain("The plugin failed to produce this page.");
  });

  it("a key repeated in a level, or equal to its parent's, does not make the tree loop", async () => {
    const { children } = setup2({
      children: (parent) =>
        parent === null
          ? { nodes: [nodeOf("p", { expandable: true }), nodeOf("p", { expandable: true }), nodeOf("q")] }
          : { nodes: [nodeOf("p", { expandable: true }), nodeOf("c")] },
    });
    await screen.findByText("q");
    expect(screen.getAllByText("p")).toHaveLength(1);
    fireEvent.click(document.querySelector('[data-tree-key="p"] .od-tree__twist')!);
    await screen.findByText("c");
    expect(screen.getAllByText("p")).toHaveLength(1); // the child that claims its parent's key is left out
    expect(children.mock.calls.length).toBeLessThan(6);
    // and filtering through it ends
    fireEvent.change(screen.getByLabelText("Filter by name"), { target: { value: "c" } });
    await screen.findByText("c");
  });

  it("the placeholder row has no menu, not even the tree's; plugin nodes are no drop targets", async () => {
    const { scroller } = setup2({ children: batchOf(1000, 200) });
    await screen.findByText("n0");
    scroller().scrollTop = 26 * 190;
    fireEvent.scroll(scroller());
    // The placeholder is replaced as soon as its batch arrives, so look it up and act on it in the same step; never between two awaits.
    await waitFor(() => {
      const more = document.querySelector("[data-more]");
      expect(more).toBeTruthy();
      fireEvent.contextMenu(more!);
    });
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(isSyntheticKey("@abc/item-1")).toBe(true);
    expect(isSyntheticKey("!abc/")).toBe(true);
    expect(isSyntheticKey("\u0000more:")).toBe(true);
    expect(isSyntheticKey("0123456789abcdef0123456789abcdef")).toBe(false);
  });
});
