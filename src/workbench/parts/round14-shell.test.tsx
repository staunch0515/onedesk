// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { Workbench } from "../workbench";
import { StatusBarPart } from "./status-bar";

afterEach(() => vi.restoreAllMocks());

const settings = { locale: "en-US", theme: "light", density: "comfortable" } as const;
const noop = () => undefined;
const statusBar = () => <StatusBarPart settings={settings} languages={[]} onSetting={noop} resolvedTheme="light" />;

describe("the demo-data notice in the status bar", () => {
  it("always shows with the pure mock client", () => {
    renderInShell(createMockClient({ fresh: true, quiet: true }), statusBar());
    expect(screen.getAllByText("Demo data").length).toBeGreaterThan(0);
  });

  it("is absent with a kernel behind it while nothing demo is in view", () => {
    renderInShell(kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {}), statusBar());
    expect(screen.queryByText("Demo data")).toBeNull();
    expect(screen.queryByText(/demo/i)).toBeNull();
  });

  it("shows while the active tab is a demo page", () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const { store } = renderInShell(kernelLikeClient(mock, { demo: { tree: () => false, target: (t) => t === "resource:demo" } }), statusBar());
    expect(screen.queryByText(/demo/i)).toBeNull();
    const tab: TabState = { id: "t1", target: "resource:demo", title: "Demo", icon: "file", pinned: false, envId: null, params: {} };
    act(() => store.set({ tabs: [tab], activeTabId: "t1" }));
    expect(screen.getAllByText(/demo/i).length).toBeGreaterThan(0);
  });
});

describe("switching the interface language", () => {
  it("renames the tabs in the background too, but not before the language changes", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const resolve = vi.fn(async (target: string) => ({ ...(await mock.page.resolve(target, {})), title: target === "resource:b" ? "neu" : "x" }));
    const client = kernelLikeClient(mock, { page: { ...mock.page, resolve } as never });
    const ui = (
      <ThemeProvider theme="light" density="comfortable">
        <Workbench settings={settings} languages={[]} onSetting={async () => undefined} />
      </ThemeProvider>
    );
    const { store, rerender } = renderInShell(client, ui);
    const mk = (id: string, title: string): TabState => ({ id, target: `resource:${id}`, title, icon: "file", pinned: false, envId: null, params: {} });
    act(() => store.set({ tabs: [mk("a", "A"), mk("b", "alt")], activeTabId: "a" }));
    resolve.mockClear();
    expect(store.get().tabs[1]!.title).toBe("alt");
    rerender(ui, "zh-CN");
    await waitFor(() => expect(store.get().tabs.find((x) => x.id === "b")!.title).toBe("neu"));
    expect(resolve.mock.calls.some(([target]) => target === "resource:b")).toBe(true);
  });
});
