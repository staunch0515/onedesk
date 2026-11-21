// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, TreeInfo, TreeNode } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { buildI18n } from "../i18n";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { RunKeepBar } from "./run-keep-bar";
import { clearTreeCache, stripRunNumber, TreePanel } from "./side-panel";

const node = (key: string, label: string, parentKey: string | null, expandable = false): TreeNode => ({
  key, tree: "runs", parentKey: parentKey ?? undefined, label, icon: "history", kind: "core:run", expandable, state: "ok", menu: [{ id: "run.unkeep", label: "run.unkeep" } as never], draggable: false, accepts: [],
});
beforeEach(clearTreeCache);
const info = { id: "runs", title: "Run records", icon: "history", source: "provided", toolbar: [], menu: [], groups: false } as unknown as TreeInfo;

function setup() {
  const setKept = vi.fn(async () => undefined);
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
  const children = vi.fn(async (_t: string, parent: string | null) => ({
    nodes: parent === null ? [node("@runs:recent", "Recent runs", null, true), node("@runs:saved", "Saved results", null, true)] : parent === "@runs:saved" ? [node("r1", "#7 Nightly totals", parent)] : [node("r2", "#8 Scratch", parent)],
  }));
  const client = {
    ...base,
    tree: {
      ...base.tree,
      path: async () => [],
      children,
    },
    run: { ...base.run, setKept },
  };
  renderInShell(client, <TreePanel tree={info} />);
  return { setKept, children };
}

describe("run records in two groups (D420)", () => {
  it("lists recent runs and saved results as separate groups", async () => {
    setup();
    expect(await screen.findByText("#7 Nightly totals")).toBeTruthy();
    expect(await screen.findByText("#8 Scratch")).toBeTruthy();
  });

  it("opens both groups by itself (D424), and a group the user collapses stays collapsed", async () => {
    setup();
    expect(await screen.findByText("#8 Scratch")).toBeTruthy();
    expect(await screen.findByText("#7 Nightly totals")).toBeTruthy();
    fireEvent.click(screen.getByText("Recent runs"));
    await waitFor(() => expect(screen.queryByText("#8 Scratch")).toBeNull());
    expect(screen.getByText("#7 Nightly totals")).toBeTruthy();
  });

  it("the auto-expanded groups settle: each level is read once and the rows are not mounted again", async () => {
    const { children } = setup();
    const row = await screen.findByText("#8 Scratch");
    await screen.findByText("#7 Nightly totals");
    await new Promise((r) => setTimeout(r, 300));
    expect(children.mock.calls.map((c) => c[1] ?? "root").sort()).toEqual(["@runs:recent", "@runs:saved", "root"]);
    expect(screen.getByText("#8 Scratch")).toBe(row); // the same element: nothing was torn down and drawn again
  });

  it("offers rename on a saved result only, and renaming keeps the result under the new name without its number", async () => {
    const { setKept } = setup();
    fireEvent.contextMenu(await screen.findByText("#8 Scratch"));
    await screen.findByText("Stop keeping this run");
    expect(screen.queryByText("Rename saved result")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.contextMenu(await screen.findByText("#7 Nightly totals"));
    fireEvent.click(await screen.findByText("Rename saved result"));
    const input = await screen.findByDisplayValue(/Nightly totals/);
    fireEvent.change(input, { target: { value: "#7 Weekly totals" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(setKept).toHaveBeenCalledWith("r1", true, "Weekly totals"));
  });

  it("strips the running number from the edited row text", () => {
    expect(stripRunNumber("#12 Name")).toBe("Name");
    expect(stripRunNumber("Name")).toBe("Name");
    expect(stripRunNumber("#3")).toBe("");
  });
});

const run = (over: Partial<Run>): Run => ({ id: "r1", seq: 7, title: "Query", icon: "database", action: "p:run", actionLabel: "Run", actor: "user", source: "manual", startedAt: 0, status: "success", params: {}, input: {}, kept: false, inTaskPanel: false, cancellable: false, ...over }) as Run;

describe("a run's own tab", () => {
  it("keeps an unkept result, and kept ones can be renamed, unkept or deleted (the kernel confirms the delete)", async () => {
    const execute = vi.fn(async () => []);
    const setKept = vi.fn(async () => undefined);
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, command: { ...base.command, execute }, run: { ...base.run, setKept } };
    const view = renderInShell(client, <RunKeepBar run={run({})} />);
    fireEvent.click(screen.getByText("Keep this result"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("run.keep", expect.objectContaining({ target: "run:r1" })));

    view.rerender(<RunKeepBar run={run({ kept: true, keptName: "Nightly" })} />);
    fireEvent.click(screen.getByText("Delete saved result"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("run.delete", expect.objectContaining({ target: "run:r1" })));
    fireEvent.click(screen.getByText("Stop keeping"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("run.unkeep", expect.objectContaining({ target: "run:r1" })));

    fireEvent.click(screen.getByText("Rename saved result"));
    const input = await screen.findByDisplayValue("Nightly");
    fireEvent.change(input, { target: { value: "  Weekly  " } });
    fireEvent.click(screen.getByText("Save name"));
    await waitFor(() => expect(setKept).toHaveBeenCalledWith("r1", true, "Weekly"));
  });
});

describe("counted phrases", () => {
  it("says 1 row, not 1 rows, in English; other languages without a singular keep their one form", () => {
    const en = buildI18n("en-US");
    expect(en.plural("result.rows", 1, { count: "1" })).toBe("1 row");
    expect(en.plural("result.rows", 2, { count: "2" })).toBe("2 rows");
    const zh = buildI18n("zh-CN", { "result.rows": "{count} 行" });
    expect(zh.plural("result.rows", 1, { count: "1" })).toBe("1 行");
    const zhOne = buildI18n("zh-CN", { "result.rows": "{count} 行", "result.rows.one": "{count} 件" });
    expect(zhOne.plural("result.rows", 1, { count: "1" })).toBe("1 件");
  });
});

describe("opening a run record (E3)", () => {
  function opened(reuse: () => Promise<unknown>) {
    const execute = vi.fn(async (id: string) => (id === "run.reuse" ? ((await reuse()) as never) : []));
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = {
      ...base,
      command: { ...base.command, execute },
      tree: {
        ...base.tree,
        path: async () => [],
        children: async (_t: string, parent: string | null) => ({
          nodes: parent === null ? [{ ...node("@runs:recent", "Recent runs", null, true) }] : [{ ...node("r2", "#8 Scratch", parent), target: "run:r2" }, ],
        }),
      },
    };
    const view = renderInShell(client, <TreePanel tree={info} />);
    return { execute, store: view.store };
  }

  it("a recent run goes back to its query with the values it had", async () => {
    const { execute, store } = opened(async () => [{ type: "open", target: "resource:q1", params: { year: "2024" }, envId: "e1" }]);
    fireEvent.click(await screen.findByText("#8 Scratch"));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("run.reuse", expect.objectContaining({ nodeKey: "r2", tree: "runs" })));
    await waitFor(() => {
      const tab = store.get().tabs.find((t) => t.target === "resource:q1");
      expect(tab?.params).toEqual({ year: "2024" });
      expect(tab?.envId).toBe("e1");
    });
  });

  it("falls back to the run's own page when the query cannot be reopened", async () => {
    const { store } = opened(async () => Promise.reject(new Error("notFound")));
    fireEvent.click(await screen.findByText("#8 Scratch"));
    await waitFor(() => expect(store.get().tabs.some((t) => t.target === "run:r2")).toBe(true));
  });
});

describe("the run tree follows the kernel's run events", () => {
  it("reads the groups again when a run is kept (the kernel says `runs`, not `tree:runs`)", async () => {
    const handlers = new Set<(topic: string) => void>();
    let saved: TreeNode[] = [];
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = {
      ...base,
      events: { subscribe: (topic: string, h: (t: string) => void) => (topic === "runs" ? (handlers.add(h), () => handlers.delete(h)) : () => undefined) },
      tree: {
        ...base.tree,
        path: async () => [],
        children: async (_t: string, parent: string | null) => ({ nodes: parent === null ? [node("@runs:saved", "Saved results", null, true)] : saved }),
      },
    };
    renderInShell(client as never, <TreePanel tree={{ ...info, id: "runs" }} />);
    saved = [node("r1", "#1 Kept now", "@runs:saved")];
    handlers.forEach((h) => h("runs"));
    expect(await screen.findByText("#1 Kept now")).toBeTruthy();
  });
});
