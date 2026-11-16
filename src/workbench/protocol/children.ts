import type { ProtocolClient } from "./client";
import type { TreeNode } from "./types";

/** What is known of one level of a tree: the batches read so far and where the next one starts (absent = all read). */
export interface Level {
  nodes: TreeNode[];
  next?: number;
}

/** Reads one batch of a level (the kernel gives at most 200 per call), starting at `offset`. `locale` is the interface language: provided trees name their nodes in it (D363). */
export async function loadBatch(client: ProtocolClient, tree: string, parent: string | null, offset?: number, locale?: string): Promise<Level> {
  const page = await client.tree.children(tree, parent, offset, locale);
  return { nodes: page.nodes, next: page.next };
}

/** Reads a level from its start until it holds at least `atLeast` nodes or is complete (always at least one batch). A refresh uses this to keep as much as was already on screen. */
export async function loadLevel(client: ProtocolClient, tree: string, parent: string | null, locale?: string, atLeast = 0): Promise<Level> {
  const level = await loadBatch(client, tree, parent, undefined, locale);
  while (level.next !== undefined && level.nodes.length < atLeast) {
    const more = await loadBatch(client, tree, parent, level.next, locale);
    level.nodes = level.nodes.concat(more.nodes);
    level.next = more.next;
  }
  return level;
}

/** Appends the next batch to a level (no-op when it is complete). */
export async function loadMore(client: ProtocolClient, tree: string, parent: string | null, level: Level, locale?: string): Promise<Level> {
  if (level.next === undefined) return level;
  const more = await loadBatch(client, tree, parent, level.next, locale);
  return { nodes: level.nodes.concat(more.nodes), next: more.next };
}

/** Reads every batch of one level. There is no cap: callers that must not read an unbounded level use `loadBatch`/`loadMore`. */
export async function loadChildren(client: ProtocolClient, tree: string, parent: string | null, locale?: string): Promise<TreeNode[]> {
  let level = await loadBatch(client, tree, parent, undefined, locale);
  while (level.next !== undefined) level = await loadMore(client, tree, parent, level, locale);
  return level.nodes;
}
