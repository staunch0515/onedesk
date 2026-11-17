import { describe, expect, it, vi } from "vitest";
import { appendBatch, loadChildren, loadLevel, loadMore } from "./children";
import type { ProtocolClient } from "./client";
import type { TreeNode } from "./types";

const n = (key: string) => ({ key }) as TreeNode;
const clientOf = (answer: (offset: number) => { nodes: TreeNode[]; next?: number }) => {
  const children = vi.fn(async (_t: string, _p: string | null, offset = 0) => answer(offset));
  return { client: { tree: { children } } as unknown as ProtocolClient, children };
};

describe("reading a level batch by batch", () => {
  it("follows `next` to the end", async () => {
    const { client } = clientOf((o) => (o === 0 ? { nodes: [n("a")], next: 1 } : { nodes: [n("b")] }));
    expect((await loadChildren(client, "t", null)).map((x) => x.key)).toEqual(["a", "b"]);
  });

  it("stops when the next offset does not move on", async () => {
    const { client, children } = clientOf(() => ({ nodes: [n("a")], next: 0 }));
    const nodes = await loadChildren(client, "t", null);
    expect(nodes.length).toBeLessThanOrEqual(2);
    expect(children.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("stops at an empty batch that still says there is more", async () => {
    const { client, children } = clientOf((o) => (o === 0 ? { nodes: [n("a")], next: 3 } : { nodes: [], next: 3 }));
    const level = await loadLevel(client, "t", null, undefined, 100);
    expect(level.next).toBeUndefined();
    expect(level.nodes.map((x) => x.key)).toEqual(["a"]);
    expect(children.mock.calls.length).toBe(2);
  });

  it("an empty first batch with a `next` is an empty level", async () => {
    const { client } = clientOf(() => ({ nodes: [], next: 9 }));
    expect(await loadChildren(client, "t", null)).toEqual([]);
    expect((await loadLevel(client, "t", null)).next).toBeUndefined();
  });

  it("appendBatch and loadMore keep what was read and end the level when nothing advances", async () => {
    expect(appendBatch({ nodes: [n("a")], next: 1 }, { nodes: [n("b")], next: 2 })).toEqual({ nodes: [n("a"), n("b")], next: 2 });
    expect(appendBatch({ nodes: [n("a")], next: 2 }, { nodes: [n("b")], next: 2 }).next).toBeUndefined();
    const { client } = clientOf(() => ({ nodes: [n("x")], next: 1 }));
    expect((await loadMore(client, "t", null, { nodes: [n("a")] })).nodes).toEqual([n("a")]);
  });
});
