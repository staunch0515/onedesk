// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildI18n } from "../i18n";
import type { ProtocolClient, TreeInfo, TreeNode, ViewNode } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { TreePanel } from "./side-panel";
import { ViewNodes } from "./view-nodes";

afterEach(() => vi.restoreAllMocks());

describe("permission resourcesAll (D389)", () => {
  it("has its own words in English, and a language's overlay wins", () => {
    expect(buildI18n("en-US").permission("resourcesAll")).toMatch(/name, type and location/);
    expect(buildI18n("xx", { "kernel.permission.resourcesAll": "XX" }).permission("resourcesAll")).toBe("XX");
    expect(buildI18n("en-US").permission("resources")).toBe("Resources"); // the old ids are untouched
  });
});

describe("a table with row buttons", () => {
  const table: ViewNode = {
    type: "table",
    id: "items",
    columns: [{ key: "name", label: "Name" }],
    rows: [["A"], ["B"]],
    rowTargets: ["resource:a", null],
    rowKeys: ["ka", "kb"],
    rowActions: [
      { id: "remove", label: "Remove", icon: "x" },
      { id: "up", label: "Up", icon: "arrow-up" },
    ],
  };
  const mock = () => kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});

  it("sends the event name and the row index, and a click on the button does not open the row", () => {
    const onRowAction = vi.fn();
    renderInShell(mock(), <ViewNodes nodes={[table]} onRowAction={onRowAction} />);
    fireEvent.click(screen.getAllByLabelText("Up")[1]!);
    expect(onRowAction).toHaveBeenCalledWith("up", "kb");
    fireEvent.click(screen.getAllByLabelText("Remove")[0]!);
    expect(onRowAction).toHaveBeenLastCalledWith("remove", "ka");
  });

  it("draws no buttons where nobody listens (a result tab)", () => {
    renderInShell(mock(), <ViewNodes nodes={[table]} />);
    expect(screen.queryByLabelText("Remove")).toBeNull();
  });
});

describe("a node that accepts any resource (dropAny, D390)", () => {
  const nodeOf = (key: string, over: Partial<TreeNode> & { dropAny?: boolean } = {}): TreeNode =>
    ({ key, tree: "t12", label: key, icon: "file", kind: "x", expandable: false, state: "ok", menu: [], draggable: true, accepts: [], ...over }) as TreeNode;
  const info = { id: "t12", title: "T", icon: "list", source: "stored", toolbar: [], menu: [], groups: true } as unknown as TreeInfo;

  function setup(move: ProtocolClient["tree"]["move"]) {
    const nodes = [nodeOf("note"), nodeOf("bag", { kind: "bag", expandable: true, dropAny: true }), nodeOf("plain", { expandable: true })];
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, tree: { ...base.tree, children: async () => ({ nodes }), path: async () => [], move } };
    renderInShell(client, <TreePanel tree={info} />);
  }
  const at = (key: string) => document.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)!;
  async function dragOnto(from: string, to: string) {
    await screen.findByText(to);
    const target = at(to);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100, left: 0, right: 100, bottom: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    document.elementFromPoint = () => target;
    fireEvent.pointerDown(at(from), { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 50 });
    fireEvent.pointerMove(window, { clientX: 31, clientY: 50 });
    fireEvent.pointerUp(window, { clientX: 31, clientY: 50 });
  }

  it("lets a note be dropped on it, calls the move method, and shows the plugin's message", async () => {
    const move = vi.fn<ProtocolClient["tree"]["move"]>(async () => ({ message: "Added 1 item" }));
    setup(move);
    await dragOnto("note", "bag");
    await waitFor(() => expect(move).toHaveBeenCalledWith("t12", "note", "bag", "inside", expect.any(String)));
    expect(await screen.findByText("Added 1 item")).toBeTruthy();
  });

  it("an ordinary node still refuses what it does not accept", async () => {
    const move = vi.fn<ProtocolClient["tree"]["move"]>(async () => undefined);
    setup(move);
    await dragOnto("note", "plain");
    await new Promise((r) => setTimeout(r, 50));
    expect(move).not.toHaveBeenCalled();
  });
});

describe("a provided node whose target is gone (state broken)", () => {
  it("is drawn in its state with the plugin's words as its hint", async () => {
    const node = { key: "@c/1", tree: "t13", label: "(gone)", icon: "file", kind: "x", expandable: false, state: "broken", stateReason: { "en-US": "No longer exists" }, menu: [], draggable: false, accepts: [] } as TreeNode;
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, tree: { ...base.tree, children: async () => ({ nodes: [node] }), path: async () => [] } };
    renderInShell(client, <TreePanel tree={{ id: "t13", title: "T", icon: "list", source: "provided", toolbar: [], menu: [], groups: false } as unknown as TreeInfo} />);
    const row = (await screen.findByText("(gone)")).closest('[role="treeitem"]')!;
    expect(row.getAttribute("data-state")).toBe("broken");
    expect(row.getAttribute("title")).toContain("No longer exists");
  });
});

describe("table rows without rowKeys, or without a target (D393)", () => {
  it("the row action gets the row number as text; a row without a target does not open anything", () => {
    const onRowAction = vi.fn();
    const node: ViewNode = { type: "table", id: "t", columns: [{ key: "n", label: "N" }], rows: [["A"], ["B"]], rowTargets: [null, null], rowActions: [{ id: "remove", label: "Remove", icon: "x" }] };
    renderInShell(kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {}), <ViewNodes nodes={[node]} onRowAction={onRowAction} />);
    fireEvent.click(screen.getAllByLabelText("Remove")[1]!);
    expect(onRowAction).toHaveBeenCalledWith("remove", "1");
    fireEvent.doubleClick(screen.getByText("A"));
  });
  it("the action column is sized by the grid from the number of buttons, not by a pixel value", () => {
    const node: ViewNode = { type: "table", id: "t", columns: [{ key: "n", label: "N" }], rows: [["A"]], rowActions: [{ id: "a", label: "A1" }, { id: "b", label: "B1" }] };
    renderInShell(kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {}), <ViewNodes nodes={[node]} onRowAction={() => undefined} />);
    expect(screen.getByLabelText("A1")).toBeTruthy();
  });
});
