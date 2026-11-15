// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  ...over,
});

function setup(p: ImportPreview, pick?: () => Promise<string | null>) {
  const importFn = vi.fn(async () => ({ created: 3, updated: 1, skipped: p.skipped, group: { id: "g1", name: "Personal" } }));
  const base = createMockClient({ fresh: true, quiet: true });
  const client = kernelLikeClient(base, {
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

  it("says why a refused export was refused", async () => {
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, { run: { ...base.run, export: async () => { throw new KernelError("denied", { reason: "noExport", layer: "c1" }); } }, platform: { pickSaveFile: async () => "/tmp/r.csv" } });
    const { store } = renderInShell(client, <TransferDialogs />);
    const fail = vi.fn();
    await act(async () => startRunExport(client, store, { fail }, "run1", "r.csv", vi.fn()));
    expect(fail).toHaveBeenCalled();
  });
});
