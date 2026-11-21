// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventHandler, TreeInfo, TreeNode } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { TreePanel } from "./side-panel";

const info = {
  id: "p.tables",
  title: "Tables",
  icon: "table",
  source: "provided",
  groups: false,
  menu: [],
  toolbar: [
    { id: "p:toggleLevels", label: { "en-US": "Two levels", "zh-CN": "两层" }, icon: "layers" },
    { id: "p:resync", label: { "en-US": "Resync" }, icon: "refresh-cw", disabled: true },
  ],
} as unknown as TreeInfo;
const leaf = (label: string): TreeNode => ({ key: label, tree: "p.tables", label, icon: "table", kind: "x", expandable: false, state: "ok", menu: [], draggable: false, accepts: [] });

describe("tree toolbar buttons a plugin declares (X9)", () => {
  it("draws them with the plugin's words, runs the command with the tree, and reads the tree again when the kernel says it changed", async () => {
    const handlers = new Set<EventHandler>();
    let level = [leaf("orders")];
    const execute = vi.fn(async () => {
      level = [leaf("orders.items")];
      handlers.forEach((h) => h("tree:p.tables"));
      return [];
    });
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = {
      ...base,
      command: { ...base.command, execute },
      tree: { ...base.tree, path: async () => [], children: async () => ({ nodes: level }) },
      events: { subscribe: (topic: string, h: EventHandler) => (topic === "tree:p.tables" ? (handlers.add(h), () => handlers.delete(h)) : () => undefined) },
    };
    renderInShell(client, <TreePanel tree={info} />);
    expect(await screen.findByText("orders")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Resync" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Two levels" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("p:toggleLevels", expect.objectContaining({ tree: "p.tables" })));
    expect(await screen.findByText("orders.items")).toBeTruthy();
  });
});
