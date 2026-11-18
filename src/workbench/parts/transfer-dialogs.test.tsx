// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { KernelError } from "../protocol/errors";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { previewFolder, startImport, startRunExport, TransferDialogs } from "./transfer-dialogs";

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  valid: true,
  source: "Personal",
  exportedAt: 1_700_000_000_000,
  create: 3,
  update: 1,
  skipped: [{ name: "Weekly sync", kind: "x.sync", reason: "unknownKind" }],
  fingerprint: "fp1",
  grantHosts: ["api.example.com:443"],
  secretNames: ["token", "other"],
  ...over,
});

function setup(p: ImportPreview, pick?: () => Promise<string | null>) {
  const importFn = vi.fn(async () => ({ created: 3, updated: 1, skipped: p.skipped, group: { id: "g1", name: "Personal" } }));
  const base = createMockClient({ fresh: true, quiet: true });
  const client = kernelLikeClient(base, {
    secrets: { list: async () => [{ name: "token", updatedAt: 1, usedBy: [] }], set: async () => undefined, delete: async () => undefined },
    workspace: { ...base.workspace, importPreview: vi.fn(async () => p), import: importFn },
    platform: pick ? { pickFolder: pick } : undefined,
  });
  const { store } = renderInShell(client, <TransferDialogs />);
  return { importFn, store, client };
}

describe("import flow", () => {
  it("shows what would happen first and imports with the preview's fingerprint", async () => {
    const { importFn, store, client } = setup(preview());
    await act(async () => previewFolder(client, store, "/exp"));
    expect(await screen.findByText("Import from “Personal”?")).toBeTruthy();
    expect(screen.getByText("3 new, 1 updated, 1 not imported")).toBeTruthy();
    expect(screen.getByText("Weekly sync")).toBeTruthy();
    expect(screen.getByText("No installed plugin handles this type")).toBeTruthy();
    expect(screen.getByText("api.example.com:443")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("on this computer")).toHaveLength(1));
    expect(screen.getAllByText("not set here")).toHaveLength(1);
    expect(importFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(importFn).toHaveBeenCalledWith("/exp", "fp1"));
  });

  it("refuses an export it cannot read, with the reason, and offers no import", async () => {
    const { store, client } = setup(preview({ valid: false, problem: { code: "invalid", params: { reason: "notExport" } } }));
    await act(async () => previewFolder(client, store, "/bad"));
    expect(await screen.findByText("This folder is not an OneDesk export.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for a path in the browser and previews the folder typed", async () => {
    const { store, client } = setup(preview());
    await act(async () => startImport(client, store, { fail: () => undefined }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "/exp" } });
    fireEvent.click(screen.getByRole("button", { name: "Look inside" }));
    expect(await screen.findByText("Import from “Personal”?")).toBeTruthy();
  });
});

describe("result export", () => {
  beforeEach(() => localStorage.clear());
  it("uses the save dialog on the desktop and reports the rows written", async () => {
    const exportFn = vi.fn(async (_id: string, path: string) => ({ path, rows: 7 }));
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, { run: { ...base.run, export: exportFn }, platform: { pickSaveFile: async () => "/tmp/r.csv" } });
    const { store } = renderInShell(client, <TransferDialogs />);
    const done = vi.fn();
    await act(async () => startRunExport(client, store, { fail: () => undefined }, "run1", "r.csv", done));
    expect(exportFn).toHaveBeenCalledWith("run1", "/tmp/r.csv");
    expect(done).toHaveBeenCalledWith(7, "/tmp/r.csv");
  });

  it("asks for a folder once, remembers it, and exports straight there the second time", async () => {
    const exportFn = vi.fn(async (_id: string, path: string) => ({ path, rows: 3 }));
    const pickFolder = vi.fn(async () => "/tmp/out");
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, { run: { ...base.run, export: exportFn }, platform: { pickFolder } });
    const { store } = renderInShell(client, <TransferDialogs />);
    await act(async () => startRunExport(client, store, { fail: () => undefined }, "run1", "r.csv", vi.fn()));
    await act(async () => startRunExport(client, store, { fail: () => undefined }, "run2", "r.csv", vi.fn()));
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(exportFn).toHaveBeenCalledTimes(2);
    expect(exportFn.mock.calls[1][1]).toMatch(/^\/tmp\/out\/r-\d{6}\.csv$/);
  });

  it("says why a refused export was refused", async () => {
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, { run: { ...base.run, export: async () => { throw new KernelError("denied", { reason: "noExport", layer: "c1" }); } }, platform: { pickSaveFile: async () => "/tmp/r.csv" } });
    const { store } = renderInShell(client, <TransferDialogs />);
    const fail = vi.fn();
    await act(async () => startRunExport(client, store, { fail }, "run1", "r.csv", vi.fn()));
    expect(fail).toHaveBeenCalled();
  });
});
