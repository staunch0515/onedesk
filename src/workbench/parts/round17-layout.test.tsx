// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sized, ThemeProvider, useToast } from "../../design";
import { createMockClient } from "../protocol/mock";
import type { TreeInfo, TreeNode } from "../protocol";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { createStore, DEFAULT_LAYOUT, LIMITS, type LayoutState } from "../state/store";
import { Workbench } from "../workbench";
import { useResize } from "./hooks";
import { InfoPanelPart } from "./info-panel";
import { TreePanel } from "./side-panel";

const settings = { locale: "en-US", theme: "light", density: "comfortable" } as const;
const node = (key: string, expandable: boolean): TreeNode => ({ key, tree: "t", label: key, icon: "folder", kind: "x", expandable, state: "ok", menu: [], draggable: false, accepts: [] });
const info = { id: "t", title: "T", icon: "folder", source: "provided", groups: false, menu: [], toolbar: [] } as unknown as TreeInfo;

describe("L2: tree expand all / collapse all, folding remembered", () => {
  it("collapse all clears the folded state, expand all opens every expandable node, and both are saved with the layout", async () => {
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, tree: { ...base.tree, path: async () => [], children: async (_t: string, key: string | null) => ({ nodes: key === null ? [node("a", true), node("b", true)] : [] }) } };
    const { store } = renderInShell(client, <TreePanel tree={info} />);
    await screen.findByText("a");
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(store.get().expanded.t).toEqual(["a", "b"]));
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(store.get().expanded.t).toEqual([]);
  });

  it("a saved layout brings the folded state back", () => {
    const saved: Partial<LayoutState> = { expanded: { t: ["a"] } };
    expect(createStore(saved, () => undefined).get().expanded).toEqual({ t: ["a"] });
  });

  it("saves the folded state after the quiet moment", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const store = createStore(null, save);
    save.mockClear();
    store.set({ expanded: { t: ["x"] } });
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ expanded: { t: ["x"] } }));
    vi.useRealTimers();
  });
});

function Resizer({ k, dir }: { k: "sideWidth" | "infoWidth" | "panelHeight"; dir: 1 | -1 }) {
  const r = useResize(k, dir);
  return (
    <>
      <button onClick={() => { r.onDragStart(); r.onDrag(40); }}>drag</button>
      <button onClick={() => { r.onDragStart(); r.onDrag(100000); }}>far</button>
      <button onClick={r.onReset}>reset</button>
    </>
  );
}

describe("L5 / L6: dividers drag, are remembered, and the info panel keeps its width", () => {
  it("dragging changes the remembered size within limits; double click resets", () => {
    const { store } = renderInShell(createMockClient({ fresh: true, quiet: true }), <Resizer k="infoWidth" dir={-1} />);
    fireEvent.click(screen.getByText("drag"));
    expect(store.get().infoWidth).toBe(DEFAULT_LAYOUT.infoWidth - 40);
    fireEvent.click(screen.getByText("far"));
    expect(store.get().infoWidth).toBe(LIMITS.info.min);
    fireEvent.click(screen.getByText("reset"));
    expect(store.get().infoWidth).toBe(DEFAULT_LAYOUT.infoWidth);
  });

  it("every divider size is part of the saved layout and is clamped when restored", () => {
    const store = createStore({ sideWidth: 999999, infoWidth: 1, panelHeight: 333 }, () => undefined);
    expect(store.get().sideWidth).toBe(LIMITS.side.max);
    expect(store.get().infoWidth).toBe(LIMITS.info.min);
    expect(store.get().panelHeight).toBe(333);
  });

  it("a Sized pane takes its width from the remembered size only, not from its content", () => {
    const { container } = render(
      <Sized axis="x" size={240}>
        <div style={{ width: 5000 }}>wide content</div>
      </Sized>,
    );
    expect((container.firstChild as HTMLElement).style.getPropertyValue("--od-size")).toBe("240px");
  });
});

describe("L7: ⌘K moves focus to the search box and typing searches the workspace", () => {
  it("focuses the search box on ⌘K and sends what is typed to the kernel", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const query = vi.fn(async () => []);
    const client = kernelLikeClient(mock, { search: { ...mock.search, query } as never });
    renderInShell(client, (
      <ThemeProvider theme="light" density="comfortable">
        <Workbench settings={settings} languages={[]} onSetting={async () => undefined} />
      </ThemeProvider>
    ));
    const box = await screen.findByRole("combobox", { name: "Search this workspace" });
    expect(document.activeElement).not.toBe(box);
    act(() => void fireEvent.keyDown(window, { key: "k", metaKey: true }));
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.change(box, { target: { value: "ab c" } });
    await waitFor(() => expect(query).toHaveBeenCalledWith("ab c", 12));
  });
});

function ToastButton() {
  const { toast } = useToast();
  return <button onClick={() => toast({ title: "Saved" })}>go</button>;
}

describe("L9: short messages float and go away by themselves", () => {
  it("shows a toast in the fixed viewport and removes it after its time", async () => {
    renderInShell(createMockClient({ fresh: true, quiet: true }), <ToastButton />);
    fireEvent.click(screen.getByText("go"));
    expect(await screen.findByText("Saved")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull(), { timeout: 3000 });
  });
});

describe("L8: tags are editable and favorites are marked", () => {
  it("saves edited tags through the page and shows the favorite badge", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const res = await mock.resource.get("q-orders-today");
    const save = vi.fn(async () => undefined);
    const client = kernelLikeClient(mock, {
      resource: { ...mock.resource, get: async () => ({ ...res, favorite: true, tags: ["a"] }) } as never,
      page: { ...mock.page, save } as never,
    });
    renderInShell(client, <InfoPanelPart resourceId="q-orders-today" />);
    const tags = await screen.findByRole("textbox", { name: "Tags" });
    expect(screen.getByText("Favorite")).toBeTruthy();
    fireEvent.change(tags, { target: { value: "a, b" } });
    fireEvent.blur(tags);
    await waitFor(() => expect(save).toHaveBeenCalledWith("resource:q-orders-today", { tags: ["a", "b"] }));
  });
});
