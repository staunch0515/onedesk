import type { ProtocolClient } from "./client";
import type { TreeNode } from "./types";

/** Safety cap: a provided tree may hold tens of thousands of entries (§5); the sidebar shows the first ones. */
const MAX_NODES = 5000;

/** Reads every batch of one level (the kernel gives at most 200 per call). `locale` is the interface language: provided trees name their nodes in it (D363). */
export async function loadChildren(client: ProtocolClient, tree: string, parent: string | null, locale?: string): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  let offset: number | undefined;
  do {
    const page = await client.tree.children(tree, parent, offset, locale);
    nodes.push(...page.nodes);
    offset = page.next;
  } while (offset !== undefined && nodes.length < MAX_NODES);
  return nodes;
}
