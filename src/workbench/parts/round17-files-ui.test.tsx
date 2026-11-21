// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TreeInfo, TreeNode } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { CommandDialogs } from "./command-dialogs";
import { useWorkbench } from "../state/context";
import { clearTreeCache, TreePanel } from "./side-panel";

type TreeProps = {
  rows: Array<{ key: string; draggable?: boolean }>;
  canDrop: (d: string, t: string | null, p: "before" | "inside" | "after") => boolean;
  onDrop: (d: string, t: string | null, p: "before" | "inside" | "after", m: { alt: boolean }) => void;
  onContextMenu: (key: string | null, point: { x: number; y: number }) => void;
  onRenameCommit: (key: string, name: string) => void;
  editingKey: string | null;
};
const captured: { props: TreeProps | null } = { props: null };
vi.mock("../../design", async (orig) => {
  const mod = await orig<typeof import("../../design")>();
  return { ...mod, Tree: (props: TreeProps) => { captured.props = props; return <div data-testid="tree" />; } };
});

const P = "org.onedesk.files";
const node = (key: string, parentKey: string | undefined, folder: boolean, menuOps: string[] = ["move", "copy", "rename"]): TreeNode => ({
  key, tree: "files", parentKey, label: key.split("/").pop()!, icon: folder ? "folder" : "file", kind: folder ? "disk-folder" : "disk-file", expandable: folder, state: "ok",
  menu: menuOps.map((o) => ({ id: `${P}:${o}`, label: { "en-US": o === "move" ? "Move" : o === "copy" ? "Copy" : "Rename" } })), draggable: false, accepts: [],
});
const info = { id: "files", title: "Files", icon: "folder-open", source: "provided", groups: false, menu: [], toolbar: [] } as unknown as TreeInfo;
const nodes: Record<string, TreeNode[]> = {
  "": [node("/g", undefined, true, [])],
  "/g": [node("/g/a.txt", "/g", false), node("/g/sub", "/g", true)],
  "/g/sub": [],
};

function setup() {
  const mock = createMockClient({ fresh: true, quiet: true });
  const execute = vi.fn(async () => []);
  const client = kernelLikeClient(mock, {
    command: { ...mock.command, execute } as never,
    tree: { ...mock.tree, path: async () => [], children: async (_t: string, key: string | null) => ({ nodes: nodes[key ?? ""] ?? [] }) } as never,
  });
  const view = renderInShell(client, <><TreePanel tree={info} /><CommandDialogs /></>);
  return { execute, ...view };
}

async function ready(store: ReturnType<typeof setup>["store"]) {
  act(() => store.set({ expanded: { files: ["/g"] } }));
  await waitFor(() => expect(captured.props?.rows.some((r) => r.key === "/g/a.txt")).toBe(true));
}

describe("file commands in a plugin's tree (D428)", () => {
  it("a node with a move command is draggable and can be dropped onto a folder, not onto itself or its own folder tree", async () => {
    const { store } = setup();
    await ready(store);
    const rows = captured.props!.rows;
    expect(rows.find((r) => r.key === "/g/a.txt")!.draggable).toBe(true);
    expect(rows.find((r) => r.key === "/g")!.draggable).toBe(false);
    expect(captured.props!.canDrop("/g/a.txt", "/g/sub", "inside")).toBe(true);
    expect(captured.props!.canDrop("/g/a.txt", "/g/sub", "before")).toBe(false);
    expect(captured.props!.canDrop("/g/a.txt", "/g/a.txt", "inside")).toBe(false);
    expect(captured.props!.canDrop("/g/sub", "/g/sub", "inside")).toBe(false);
  });

  it("honours a folder's `accepts` when the plugin declares it (D430)", async () => {
    clearTreeCache(); // levels are remembered per tree id
    const { store } = setup();
    const picky = nodes["/g"]!.map((n) => (n.key === "/g/sub" ? { ...n, accepts: ["disk-folder"] } : n));
    const saved = nodes["/g"];
    nodes["/g"] = picky;
    await ready(store);
    expect(captured.props!.canDrop("/g/a.txt", "/g/sub", "inside")).toBe(false); // a disk-file is not accepted there
    nodes["/g"] = saved!;
    clearTreeCache();
  });

  it("dropping calls the move command with the target folder as destination; with ⌥ it calls copy", async () => {
    const { store, execute } = setup();
    await ready(store);
    act(() => captured.props!.onDrop("/g/a.txt", "/g/sub", "inside", { alt: false }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(`${P}:move`, expect.objectContaining({ tree: "files", nodeKey: "/g/a.txt", args: { destination: "/g/sub" } })));
    act(() => captured.props!.onDrop("/g/a.txt", "/g/sub", "inside", { alt: true }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(`${P}:copy`, expect.objectContaining({ nodeKey: "/g/a.txt", args: { destination: "/g/sub" } })));
  });

  it("“Copy” in the context menu asks for a folder among the tree's folders and sends it as destination", async () => {
    const { store, execute } = setup();
    await ready(store);
    act(() => captured.props!.onContextMenu("/g/a.txt", { x: 10, y: 10 }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Copy to…")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Choose" }) as HTMLButtonElement).disabled).toBe(true);
    // The picker's tree is the mocked one here; read its rows and pick the folder the way the real tree would.
    await waitFor(() => expect(captured.props!.rows.map((r) => r.key)).toContain("/g"));
    act(() => (captured.props as unknown as { onActivate: (k: string) => void }).onActivate("/g"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(`${P}:copy`, expect.objectContaining({ nodeKey: "/g/a.txt", args: { destination: "/g" } })));
  });

  it("“Rename” edits in place and the confirmed name goes to the rename command as newName", async () => {
    const { store, execute } = setup();
    await ready(store);
    act(() => captured.props!.onContextMenu("/g/a.txt", { x: 10, y: 10 }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await waitFor(() => expect(store.get().renaming).toEqual({ tree: "files", key: "/g/a.txt", command: `${P}:rename` }));
    act(() => captured.props!.onRenameCommit("/g/a.txt", "b.txt"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(`${P}:rename`, expect.objectContaining({ nodeKey: "/g/a.txt", args: { newName: "b.txt" } })));
    expect(store.get().renaming).toBeNull();
  });
});

describe("the confirm dialog with choices (D428)", () => {
  it("offers the plugin's choices, sends the chosen id under choiceArg, and warns when irreversible", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const execute = vi.fn(async () => []);
    const client = kernelLikeClient(mock, { command: { ...mock.command, execute } as never });
    function Ask() {
      const { actions } = useWorkbench();
      return <button onClick={() => actions.runEffects([{ type: "confirm", message: { "en-US": "b.txt exists." }, command: `${P}:copy`, choices: [{ id: "overwrite", label: { "en-US": "Replace it" } }, { id: "skip" }, { id: "keepBoth" }], choiceArg: "conflict", irreversible: true } as never])}>ask</button>;
    }
    renderInShell(client, <><Ask /><CommandDialogs /></>);
    fireEvent.click(screen.getByText("ask"));
    expect(await screen.findByText(/b\.txt exists\. This cannot be undone\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(`${P}:copy`, expect.objectContaining({ args: { confirmed: true, conflict: "keepBoth" } })));
  });
});

describe("a plugin's tree after the kernel says it changed (a folder was granted)", () => {
  it("reads the root again on tree:<id>, so a new granted folder shows without switching trees", async () => {
    clearTreeCache();
    const handlers = new Set<(topic: string) => void>();
    let roots: TreeNode[] = [];
    const mock = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(mock, {
      tree: { ...mock.tree, path: async () => [], children: async () => ({ nodes: roots }) } as never,
      events: { subscribe: (topic: string, h: (t: string) => void) => (topic === "tree:files" ? (handlers.add(h), () => handlers.delete(h)) : () => undefined) } as never,
    });
    renderInShell(client, <TreePanel tree={info} />);
    await waitFor(() => expect(captured.props?.rows).toEqual([]));
    roots = [node("/granted", undefined, true, [])];
    act(() => handlers.forEach((h) => h("tree:files")));
    await waitFor(() => expect(captured.props?.rows.map((r) => r.key)).toEqual(["/granted"]));
    clearTreeCache();
  });
});
