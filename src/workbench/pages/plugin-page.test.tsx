// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageDescriptor, PluginDetail } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { PluginPage } from "./plugin-page";

const tab: TabState = { id: "t1", target: "plugin:org.example.web", title: "", icon: "puzzle", pinned: false, envId: null, params: {} };
const descriptor = { target: tab.target, title: "Web", icon: "puzzle", found: true, state: "ok", breadcrumb: [], page: "plugin", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as unknown as PageDescriptor;

const detail = (over: Partial<PluginDetail> = {}): PluginDetail => ({
  id: "org.example.web",
  name: "Web",
  icon: "globe",
  description: "d",
  author: "a",
  license: "MIT",
  homepage: "https://example.com",
  enabled: true,
  builtin: false,
  versions: [
    { version: "0.1.0", installedAt: 1, active: true, pinned: false, notes: "", resourceCount: 3, confirmed: true },
    { version: "0.2.0", installedAt: 2, active: false, pinned: false, notes: "", resourceCount: 0, confirmed: false },
  ],
  settings: [],
  permissions: [{ id: "network", detail: "api.example.com", granted: false, required: true }],
  provides: { kinds: [], actions: [], trees: [], resultTabs: [], other: [] },
  load: { state: "loaded" },
  resourceCount: 3,
  folders: [],
  lastUpgrade: { batch: "b1", from: "0.1.0", to: "0.2.0", count: 2, at: 1, undone: false },
  unconfirmed: ["0.2.0"],
  ...over,
});

function setup(d: PluginDetail = detail(), undo = vi.fn(async () => ({ restored: 2, modified: [] as Array<{ id: string; name: string }> }))) {
  const app = { inspectPlugin: vi.fn(), installPlugin: vi.fn(), removePlugin: vi.fn(async () => undefined) };
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { app: app as never });
  const plugin = {
    ...base.plugin,
    get: vi.fn(async () => d),
    activateVersion: vi.fn(async () => ({ batch: "b2", upgraded: 3, kept: 1 })),
    confirmPermissions: vi.fn(async () => undefined),
    setPinned: vi.fn(async () => undefined),
    undoUpgrade: undo,
  };
  renderInShell({ ...base, plugin }, <PluginPage tab={tab} descriptor={descriptor} />);
  return { app, plugin };
}

describe("plugin page versions (kernel plugin)", () => {
  it("lists both versions with their resource counts and the unconfirmed mark", async () => {
    setup();
    expect(await screen.findByText("0.2.0")).toBeTruthy();
    expect(screen.getByText("Not confirmed")).toBeTruthy();
    expect(screen.getByText("The last upgrade (0.1.0 → 0.2.0) took over 2 resource(s).")).toBeTruthy();
  });

  it("asks to confirm the permissions before switching to an unconfirmed version, then switches", async () => {
    const { plugin } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Activate" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Network access")).toBeTruthy();
    expect(plugin.activateVersion).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow and use" }));
    await waitFor(() => expect(plugin.confirmPermissions).toHaveBeenCalledWith("org.example.web", "0.2.0"));
    await waitFor(() => expect(plugin.activateVersion).toHaveBeenCalledWith("org.example.web", "0.2.0"));
  });

  it("lists how many resources still use a version before removing it", async () => {
    const { app } = setup();
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/3 resource\(s\) still use it/)).toBeTruthy();
    expect(app.removePlugin).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(app.removePlugin).toHaveBeenCalledWith("org.example.web", "0.1.0"));
  });

  it("undoes the last upgrade and, when some resources were edited since, lets the user choose them", async () => {
    const undo = vi.fn(async (_batch: string, also?: string[]) => (also && also.length > 0 ? { restored: 3, modified: [] } : { restored: 2, modified: [{ id: "r9", name: "Edited query" }] }));
    setup(detail(), undo as never);
    fireEvent.click(await screen.findByRole("button", { name: "Undo upgrade" }));
    const first = await screen.findByRole("dialog");
    fireEvent.click(within(first).getByRole("button", { name: "Undo upgrade" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("b1", []));
    const pick = await screen.findByText("Edited query");
    fireEvent.click(pick);
    fireEvent.click(screen.getByRole("button", { name: "Revert selected" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("b1", ["r9"]));
  });

  it("hides folder grants for a plugin that does not ask for files and shows the uninstall action", async () => {
    setup();
    await screen.findByText("0.2.0");
    expect(screen.queryByRole("button", { name: /Grant a folder/ })).toBeNull();
    expect(screen.getByText("Uninstall")).toBeTruthy();
  });
});
