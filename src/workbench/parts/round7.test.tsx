// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InstallPreview, InstallRequest, PageDescriptor, PluginDetail } from "../protocol";
import { KernelError } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { PluginPage } from "../pages/plugin-page";
import { useI18n } from "../i18n";
import type { TabState } from "../state/store";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { InstallDialogs } from "./install-dialogs";

const preview = (id: string, over: Partial<InstallPreview> = {}): InstallPreview => ({
  valid: true,
  id,
  version: "0.1.0",
  fingerprint: `fp-${id}`,
  name: id.toUpperCase(),
  description: "d",
  icon: "puzzle",
  author: "x",
  permissions: [{ id: "resources", detail: "org.example.note:note", granted: false, required: true }],
  installed: [],
  addedPermissions: [],
  provides: { kinds: [], actions: [], trees: [], resultTabs: [], other: [] },
  ...over,
});
const request = (id: string, folder: string): InstallRequest => ({ id, plugin: "org.example.market", pluginName: { "en-US": "Plugin market", "zh-CN": "插件市场" }, folder, at: 1 });

function setupRequests(requests: InstallRequest[], inspect: (folder: string) => Promise<InstallPreview>, install = vi.fn(async (_f: string, id: string, version: string) => ({ plugin: id, version }))) {
  const app = { inspectPlugin: vi.fn(inspect), installPlugin: install, removePlugin: vi.fn(async () => undefined) };
  const answer = vi.fn(async () => undefined);
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { app });
  const client = { ...base, plugin: { ...base.plugin, installRequests: vi.fn(async () => requests), answerInstallRequest: answer } };
  const { store } = renderInShell(client, <InstallDialogs />);
  return { app, answer, store };
}

describe("install requests from plugins", () => {
  it("names the requester, installs after confirm, answers, then shows the next request", async () => {
    const { app, answer } = setupRequests([request("r1", "/a"), request("r2", "/b")], async (f) => preview(f === "/a" ? "org.a" : "org.b"));
    expect(await screen.findByText("“Plugin market” asks to install “ORG.A”?".replace(/[“”]/g, ""))).toBeTruthy();
    // The permission detail lists <plugin>:<kind>.
    expect(screen.getByText("org.example.note:note")).toBeTruthy();
    expect(app.installPlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ id: "r1", outcome: "installed", plugin: "org.a", version: "0.1.0" }));
    expect(await screen.findByText(/ORG\.B/)).toBeTruthy();
    expect(app.inspectPlugin).toHaveBeenCalledTimes(2);
  });

  it("answers declined on cancel and failed when the folder cannot be inspected", async () => {
    const { answer } = setupRequests([request("r1", "/a"), request("r2", "/bad")], async (f) => {
      if (f === "/bad") throw new KernelError("invalid", { reason: "noManifest" });
      return preview("org.a");
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ id: "r1", outcome: "declined" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ id: "r2", outcome: "failed", reason: "noManifest" }));
  });

  it("answers failed when the install itself fails", async () => {
    const { answer } = setupRequests([request("r1", "/a")], async () => preview("org.a"), vi.fn(async () => Promise.reject(new KernelError("conflict", { reason: "changedSinceInspect" }))));
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ id: "r1", outcome: "failed", reason: "changedSinceInspect" }));
  });
});

const tab: TabState = { id: "t1", target: "plugin:org.example.tools", title: "", icon: "puzzle", pinned: false, envId: null, params: {} };
const descriptor = { target: tab.target, title: "T", icon: "puzzle", found: true, state: "ok", breadcrumb: [], page: "plugin", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as unknown as PageDescriptor;
const detail = (over: Partial<PluginDetail>): PluginDetail => ({
  id: "org.example.tools", name: "Tools", icon: "puzzle", description: "d", author: "a", license: "MIT", homepage: "https://example.com", enabled: true, builtin: false,
  versions: [{ version: "0.1.0", installedAt: 1, active: true, pinned: false, notes: "", resourceCount: 0, confirmed: true, permissions: [], fingerprint: "f" }],
  settings: [], permissions: [], provides: { kinds: [], actions: [], trees: [], resultTabs: [], other: [] }, load: { state: "loaded" }, resourceCount: 2, folders: [], unconfirmed: [], ...over,
});

function setupPage(d: PluginDetail, setEnabled = vi.fn(async () => undefined)) {
  const app = { inspectPlugin: vi.fn(), installPlugin: vi.fn(), removePlugin: vi.fn(async () => undefined) };
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { app: app as never });
  renderInShell({ ...base, plugin: { ...base.plugin, get: vi.fn(async () => d), setEnabled } }, <PluginPage tab={tab} descriptor={descriptor} />);
  return { setEnabled };
}

describe("plugin page dependencies", () => {
  it("lists what it depends on and says why it is waiting", async () => {
    setupPage(detail({ load: { state: "disabled" }, depends: [{ id: "org.example.note", range: ">=0.1.0", satisfied: false }, { id: "org.example.http", range: ">=1.0.0", satisfied: true, activeVersion: "1.2.0" }] }));
    expect(await screen.findByText("Waiting for plugins it depends on")).toBeTruthy();
    expect(screen.getByText("Needs org.example.note >=0.1.0")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Depends on" })).toBeTruthy();
    expect(screen.queryByText("Disabled in this workspace")).toBeNull();
  });

  it("lists the plugins that depend on it", async () => {
    setupPage(detail({ dependents: ["org.example.a", "org.example.b"] }));
    expect(await screen.findByText("Depended on by")).toBeTruthy();
    expect(screen.getByRole("button", { name: "org.example.a" })).toBeTruthy();
  });

  it("words a refusal because of dependents, naming them", async () => {
    setupPage(detail({}), vi.fn(async () => Promise.reject(new KernelError("conflict", { reason: "dependents", plugins: "org.example.a,org.example.b" }))));
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    expect(await screen.findByText(/org\.example\.a,org\.example\.b.*Disable them first/)).toBeTruthy();
  });
});

describe("texts", () => {
  it("words the switch failure and audit names in Chinese too", () => {
    function Probe() {
      const { error } = useI18n();
      return <span>{error(new KernelError("conflict", { reason: "dependents", plugins: "x" }))}</span>;
    }
    renderInShell(createMockClient({ fresh: true, quiet: true }), <Probe />, "zh-CN");
    expect(screen.getByText(/依赖它：x/)).toBeTruthy();
  });
});
