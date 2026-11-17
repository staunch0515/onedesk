// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLayout } from "../../design/testing/layout";
import type { TreeInfo, TreeNode, TreePage } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { TreePanel } from "./side-panel";

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
