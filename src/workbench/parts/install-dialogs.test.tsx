// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InstallPreview } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { InstallDialogs, inspectFolder, startInstall } from "./install-dialogs";

const preview = (over: Partial<InstallPreview> = {}): InstallPreview => ({
  valid: true,
  id: "org.example.web",
  version: "0.2.0",
  name: "Web tool",
  description: "Calls web services",
  icon: "globe",
  author: "Example",
  permissions: [
    { id: "network", detail: "api.example.com", granted: false, required: true },
    { id: "files", detail: "", granted: false, required: false },
  ],
  installed: ["0.1.0"],
  addedPermissions: ["network"],
  provides: { kinds: [], actions: [], trees: [], resultTabs: [], other: [] },
  ...over,
});

function setup(p: InstallPreview, pick?: () => Promise<string | null>) {
  const app = { inspectPlugin: vi.fn(async () => p), installPlugin: vi.fn(async () => ({ plugin: p.id, version: p.version })), removePlugin: vi.fn(async () => undefined) };
  const confirmPermissions = vi.fn(async () => undefined);
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { app });
  const client = { ...base, platform: pick ? { pickFolder: pick } : undefined, plugin: { ...base.plugin, confirmPermissions } };
  const { store } = renderInShell(client, <InstallDialogs />);
  return { app, confirmPermissions, store, client };
}

describe("install flow", () => {
  it("lists every permission, marks the new one, and installs then confirms on Install", async () => {
    const { app, confirmPermissions, store, client } = setup(preview());
    await act(async () => inspectFolder(client, store, "/pkg"));
    expect(await screen.findByText("Install Web tool?")).toBeTruthy();
    expect(screen.getByText("Network access")).toBeTruthy();
    expect(screen.getByText("api.example.com")).toBeTruthy();
    expect(screen.getByText("Files in granted folders")).toBeTruthy();
    expect(screen.getAllByText("New")).toHaveLength(1);
    expect(app.installPlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(confirmPermissions).toHaveBeenCalledWith("org.example.web", "0.2.0"));
    expect(app.installPlugin).toHaveBeenCalledWith("/pkg");
    await waitFor(() => expect(store.get().install).toBeNull());
  });

  it("closes with a warning, not an error, when the kernel's automatic switch to the new version fails", async () => {
    const { app, confirmPermissions, store, client } = setup(preview());
    confirmPermissions.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "pluginError", params: { reason: "migrateFailed" } }));
    await act(async () => inspectFolder(client, store, "/pkg"));
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(store.get().install).toBeNull());
    expect(app.installPlugin).toHaveBeenCalledTimes(1);
  });

  it("explains a refused package and cannot be confirmed", async () => {
    const bad = preview({ valid: false, problem: { code: "invalid", params: { reason: "schema" } }, permissions: [] });
    const { app, store, client } = setup(bad);
    await act(async () => inspectFolder(client, store, "/bad"));
    expect(await screen.findByText("This folder cannot be installed")).toBeTruthy();
    expect(screen.getByText("The package was refused")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(true);
    expect(app.installPlugin).not.toHaveBeenCalled();
  });

  it("asks for a path in the browser and inspects it; the desktop dialog goes straight to the preview", async () => {
    const { app, store, client } = setup(preview());
    await act(async () => startInstall(client, store, { fail: () => undefined }));
    expect(store.get().install).toEqual({ stage: "path" });
    const input = await screen.findByPlaceholderText("/Users/…");
    fireEvent.change(input, { target: { value: "/Users/me/pkg" } });
    fireEvent.click(screen.getByRole("button", { name: "Look inside" }));
    await waitFor(() => expect(app.inspectPlugin).toHaveBeenCalledWith("/Users/me/pkg"));
    const desktop = setup(preview(), async () => "/picked");
    await act(async () => startInstall(desktop.client, desktop.store, { fail: () => undefined }));
    expect(desktop.app.inspectPlugin).toHaveBeenCalledWith("/picked");
  });
});
