// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockClient } from "../protocol/mock";
import type { TabState } from "../state/store";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { ViewPage } from "./view-page";
import type { PageDescriptor } from "../protocol";

const tab: TabState = { id: "t1", target: "resource:r1", title: "R", icon: "file", pinned: false, envId: null, params: {}, basis: "1" };
const descriptor = { target: tab.target, title: "R", icon: "file", found: true, state: "ok", breadcrumb: [], page: "view", resourceId: "r1", basis: "1", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as unknown as PageDescriptor;

describe("a plugin page and the interface language (round 11 leftover)", () => {
  it("asks for the page again when the language changes, and not otherwise", async () => {
    const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const { store, rerender } = renderInShell(client, <ViewPage tab={tab} descriptor={descriptor} />);
    store.set({ tabs: [tab], activeTabId: "t1" });
    const reloads = () => store.get().tabs.find((t) => t.id === "t1")?.reload ?? 0;
    await act(async () => rerender(<ViewPage tab={tab} descriptor={descriptor} />));
    expect(reloads()).toBe(0);
    await act(async () => rerender(<ViewPage tab={tab} descriptor={descriptor} />, "zh-CN"));
    expect(reloads()).toBe(1);
  });
});

describe("a table row button on a plugin page (D393)", () => {
  it("sends the page event with the row key in the context", async () => {
    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const event = vi.fn(async () => ({}));
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, page: { ...base.page, event } };
    const withTable = { ...descriptor, view: [{ type: "table", id: "items", columns: [{ key: "n", label: "N" }], rows: [["A"], ["B"]], rowKeys: ["ka", "kb"], rowActions: [{ id: "up", label: "Move up", icon: "arrow-up" }] }] } as unknown as PageDescriptor;
    const { store } = renderInShell(client, <ViewPage tab={tab} descriptor={withTable} />);
    store.set({ tabs: [tab], activeTabId: "t1" });
    fireEvent.click(screen.getAllByLabelText("Move up")[1]!);
    await waitFor(() => expect(event).toHaveBeenCalled());
    expect(event.mock.calls[0]).toEqual(["resource:r1", "up", expect.objectContaining({ row: "kb" })]);
  });
});
