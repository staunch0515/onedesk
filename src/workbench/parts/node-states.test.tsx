// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PageDescriptor, TreeInfo, TreeNode } from "../protocol";
import { createMockClient } from "../protocol/mock";
import type { TabState } from "../state/store";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { Frame } from "./frame";
import { TreePanel } from "./side-panel";

const base = { tree: "queries", icon: "file-text", kind: "x", expandable: false, menu: [], draggable: false, accepts: [] };
const nodes: TreeNode[] = [
  { ...base, key: "a", label: "Alive", state: "ok" },
  { ...base, key: "b", label: "Gone", state: "broken", stateReason: "sourceMissing" },
  { ...base, key: "c", label: "Faulty", state: "broken" },
];
const info = { id: "queries", title: "Queries", icon: "list", source: "provided", toolbar: [], menu: [], groups: false } as unknown as TreeInfo;

describe("a resource whose source file is gone (round 16)", () => {
  it("is drawn as stale in the tree, not as a fault, and says why", async () => {
    const mock = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    renderInShell({ ...mock, tree: { ...mock.tree, path: async () => [], children: async () => ({ nodes }) } }, <TreePanel tree={info} />);
    const row = (await screen.findByText("Gone")).closest("[data-state]") as HTMLElement;
    expect(row.dataset.state).toBe("stale");
    expect(row.getAttribute("title")).toContain("The source file no longer exists");
    expect(((await screen.findByText("Faulty")).closest("[data-state]") as HTMLElement).dataset.state).toBe("broken");
  });

  it("says so in the page's banner, as a warning titled Source missing", () => {
    const tab: TabState = { id: "t", target: "resource:r", title: "", icon: "file", pinned: false, envId: null, params: {} };
    const descriptor = { target: tab.target, title: "Q", icon: "file", found: true, state: "broken", stateReason: "sourceMissing", breadcrumb: [], page: "view", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as unknown as PageDescriptor;
    renderInShell(kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {}), <Frame tab={tab} descriptor={descriptor}>x</Frame>);
    expect(screen.getAllByText("Source missing").length).toBe(2); // the badge by the title and the banner
    expect(screen.getByText("The source file no longer exists")).toBeTruthy();
    expect(screen.queryByText("Broken")).toBeNull();
  });
});
