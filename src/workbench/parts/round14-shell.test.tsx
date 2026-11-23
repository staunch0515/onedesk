// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../design";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { Workbench } from "../workbench";
import { buildI18n } from "../i18n";
import { KernelError } from "../protocol/errors";
import { StatusBarPart } from "./status-bar";
import { TopBarPart } from "./top-bar";

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

  it("leaves the secrets page and the plugin page to name themselves, and asks for the new language explicitly", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const resolve = vi.fn(async (target: string, context?: { locale?: string }) => ({ ...(await mock.page.resolve("resource:b", {})), title: `T:${target}:${context?.locale}` }));
    const client = kernelLikeClient(mock, { page: { ...mock.page, resolve } as never });
    const ui = (
      <ThemeProvider theme="light" density="comfortable">
        <Workbench settings={settings} languages={[]} onSetting={async () => undefined} />
      </ThemeProvider>
    );
    const { store, rerender } = renderInShell(client, ui);
    const mk = (id: string, target: string, title: string): TabState => ({ id, target, title, icon: "key-round", pinned: false, envId: null, params: {} });
    act(() => store.set({ tabs: [mk("a", "resource:a", "A"), mk("s", "shell:secrets", "Secrets"), mk("p", "plugin:org.example.x", "Plugin X"), mk("b", "resource:b", "alt")], activeTabId: "a" }));
    resolve.mockClear();
    rerender(ui, "zh-CN");
    await waitFor(() => expect(store.get().tabs.find((x) => x.id === "b")!.title).toBe("T:resource:b:zh-CN"));
    const s2 = store.get().tabs.find((x) => x.id === "s")!;
    expect(s2.missing).toBeFalsy();
    expect(s2.icon).toBe("key-round");
    expect(s2.title).not.toBe("shell:secrets");
    const p2 = store.get().tabs.find((x) => x.id === "p")!;
    expect(p2.title).toBe("Plugin X");
    expect(resolve.mock.calls.map(([t]) => t)).not.toContain("shell:secrets");
    expect(resolve.mock.calls.map(([t]) => t)).not.toContain("plugin:org.example.x");
  });
});

describe("the title bar follows a renamed workspace", () => {
  it("re-reads the list when the main process says the workspaces changed", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    let name = "Before";
    const handlers = new Set<() => void>();
    const entry = () => ({ id: "w1", name, folder: "/x/w1", current: true });
    const client = kernelLikeClient(mock, {
      workspace: { ...mock.workspace, list: async () => [entry()] } as never,
      events: { subscribe: (topic: string, h: () => void) => { if (topic === "app.workspacesChanged") handlers.add(h); return () => handlers.delete(h); } } as never,
    });
    renderInShell(client, <ThemeProvider theme="light" density="comfortable"><TopBarPart onSettings={noop} /></ThemeProvider>);
    await screen.findByText("Before");
    name = "After";
    act(() => handlers.forEach((h) => h()));
    await screen.findByText("After");
  });
});

describe("a refusal by protection names the layer", () => {
  it("says which layer to change when the kernel names it, and keeps the general text otherwise", () => {
    const i = buildI18n("en-US");
    expect(i.error(new KernelError("denied", { reason: "readonly", layerName: "Production" }))).toMatch(/set by “Production”/);
    expect(i.error(new KernelError("denied", { reason: "noExport", layerName: "Production" }))).toMatch(/set by “Production”/);
    expect(i.error(new KernelError("denied", { reason: "readonly" }))).not.toMatch(/set by/);
  });
});

describe("a page the plugin could not produce", () => {
  it("shows the plugin's message as one line of small text, without its stack", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const resolve = vi.fn(async () => {
      throw new KernelError("pluginError", { reason: "threw" }, "plugin error: stream did not contain valid UTF-8\nsecond line");
    });
    const client = kernelLikeClient(mock, { page: { ...mock.page, resolve } as never });
    const ui = (
      <ThemeProvider theme="light" density="comfortable">
        <Workbench settings={settings} languages={[]} onSetting={async () => undefined} />
      </ThemeProvider>
    );
    const { store } = renderInShell(client, ui);
    const tab: TabState = { id: "t9", target: "resource:x", title: "X", icon: "file", pinned: false, envId: null, params: {} };
    act(() => store.set({ tabs: [tab], activeTabId: "t9" }));
    expect(await screen.findByText("Details: plugin error: stream did not contain valid UTF-8")).toBeTruthy();
    expect(screen.queryByText(/second line/)).toBeNull();
  });
});
