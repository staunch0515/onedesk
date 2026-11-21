import type { TreeNode } from "../protocol";

/** The three file commands a plugin can put in a node's menu (D428); their ids end in `:move`, `:copy`, `:rename`. */
export type FileOp = "move" | "copy" | "rename";

export function fileOpOf(commandId: string): FileOp | null {
  const m = /:(move|copy|rename)$/.exec(commandId);
  return m ? (m[1] as FileOp) : null;
}

/** The node's own command for `op`, if its menu has one. */
export function opCommand(node: TreeNode, op: FileOp): string | undefined {
  return node.menu.find((c) => fileOpOf(c.id) === op && !c.disabled)?.id;
}
