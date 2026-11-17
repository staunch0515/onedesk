// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOpenableUrl, useWorkbench } from "../state/context";
import type { Actions } from "../state/context";
import type { ViewNode } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { ViewNodes } from "./view-nodes";

let actions: Actions;
function Grab() {
  actions = useWorkbench().actions;
  return null;
}

afterEach(() => vi.restoreAllMocks());

describe("isOpenableUrl", () => {
  it("allows http, https and mailto only, and not too long", () => {
    for (const ok of ["https://e.com", "http://e.com/a?b", "MAILTO:a@b.c"]) expect(isOpenableUrl(ok)).toBe(true);
    for (const bad of ["", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://x", "example.com", "https://a b", "https://a\nb", `https://e.com/${"a".repeat(2048)}`]) expect(isOpenableUrl(bad)).toBe(false);
  });
});

describe("the openExternal effect", () => {
  it("goes to the main process when there is one", async () => {
    const openExternal = vi.fn(async () => undefined);
    const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { platform: { openExternal } });
    renderInShell(client, <Grab />);
    await act(async () => actions.runEffects([{ type: "openExternal", url: "https://e.com/x" }]));
    expect(openExternal).toHaveBeenCalledWith("https://e.com/x");
  });

  it("opens a new tab in a plain browser, and refuses other protocols without asking anyone", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const openExternal = vi.fn(async () => undefined);
    renderInShell(kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {}), <Grab />);
    await act(async () => actions.runEffects([{ type: "openExternal", url: "https://e.com" }]));
    expect(open).toHaveBeenCalledWith("https://e.com", "_blank", "noopener,noreferrer");
    open.mockClear();
    const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { platform: { openExternal } });
    renderInShell(client, <Grab />);
    await act(async () => actions.runEffects([{ type: "openExternal", url: "javascript:alert(1)" }]));
    expect(open).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("a markdown text node", () => {
  const nodes: ViewNode[] = [{ type: "text", id: "t", format: "markdown", text: "# Title\n\n<b>raw</b> [site](https://e.com) [[Known]] [[Nowhere]]" }];

  it("renders without raw HTML, opens links outside, and resolves references from the resource's refs", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const openExternal = vi.fn(async () => undefined);
    const client = kernelLikeClient(mock, {
      platform: { openExternal },
      refs: { incoming: async () => [], outgoing: async () => [{ source: { id: "a", name: "A" }, field: "body.text", text: "Known", target: { id: "b", name: "Known" }, state: "ok" }] },
    });
    const { store } = renderInShell(client, <><Grab /><ViewNodes nodes={nodes} /></>);
    store.set({ tabs: [{ id: "t1", target: "resource:a", title: "A", icon: "file", pinned: false, envId: null, params: {} }], activeTabId: "t1" });
    expect(screen.getByRole("heading", { name: "Title" }).tagName).toBe("H2");
    expect(document.querySelector("b")).toBeNull();
    fireEvent.click(screen.getByText("site"));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://e.com"));
    await waitFor(() => expect(screen.getByText("Nowhere").className).toContain("broken"));
    expect(screen.getByText("Known").className).not.toContain("broken");
    fireEvent.click(screen.getByText("Known"));
    await waitFor(() => expect(store.get().tabs.some((t) => t.target === "resource:b")).toBe(true));
  });
});
