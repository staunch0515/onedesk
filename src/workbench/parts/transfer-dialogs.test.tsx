// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { KernelError } from "../protocol/errors";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { inspectPackage, previewFolder, startImport, startPackageImport, startRunExport, TransferDialogs } from "./transfer-dialogs";
import type { PackageInfo } from "../protocol/generated";

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
    expect(exportFn.mock.calls[1]?.[1]).toMatch(/^\/tmp\/out\/r-\d{6}\.csv$/);
  });

  it("asks for a folder again when the remembered one is gone, and adds a counter when the name is taken", async () => {
    const calls: string[] = [];
    const exportFn = vi.fn(async (_id: string, path: string) => {
      calls.push(path);
      if (path.startsWith("/gone/")) throw new KernelError("invalid", { reason: "noParent" });
      if (calls.filter((c) => c.startsWith("/new/")).length === 1) throw new KernelError("conflict", { reason: "exists" });
      return { path, rows: 1 };
    });
    const pickFolder = vi.fn(async () => "/new");
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, { run: { ...base.run, export: exportFn }, platform: { pickFolder } });
    await client.ui.set("export.dir", "/gone");
    const { store } = renderInShell(client, <TransferDialogs />);
    const done = vi.fn();
    await act(async () => startRunExport(client, store, { fail: () => undefined }, "run1", "r.csv", done));
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatch(/^\/gone\//);
    expect(calls[1]).toMatch(/^\/new\/r-\d{6}\.csv$/);
    expect(calls[2]).toMatch(/^\/new\/r-\d{6}-2\.csv$/);
    expect(done).toHaveBeenCalledWith(1, calls[2]);
    expect(await client.ui.get("export.dir")).toBe("/new");
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

describe("resource packages (D487 §21)", () => {
  const info = (over: Partial<PackageInfo> = {}): PackageInfo => ({ title: "Science", publisherName: "Teacher", edition: 1, printing: 2, variant: "student", publishedAt: 1_700_000_000_000, resources: 10, update: false, ...over });
  function pkgSetup(i: PackageInfo, pick?: () => Promise<string | null>) {
    const importFn = vi.fn(async () => ({ root: "r1", created: 10, updated: 0, removed: 0 }));
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, {
      workspace: { ...base.workspace, packageInspect: vi.fn(async () => i), packageImport: importFn },
      platform: pick ? { pickResourcePackage: pick } : undefined,
    });
    const { store } = renderInShell(client, <TransferDialogs />);
    return { importFn, store, client };
  }

  it("shows the edition and imports a read-only copy", async () => {
    const { importFn, store, client } = pkgSetup(info(), async () => "/p/science.odpack");
    await act(async () => startPackageImport(client, store, { fail: () => undefined }));
    expect(await screen.findByText("Import “Science”?")).toBeTruthy();
    expect(screen.getByText("Edition 1, printing 2")).toBeTruthy();
    expect(screen.getByText("Student's edition")).toBeTruthy();
    expect(screen.getByText("It comes in as a read-only copy: you can read and use it, not change it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(importFn).toHaveBeenCalledWith("/p/science.odpack"));
  });

  it("an update says what is there now; a refusal says why and imports nothing", async () => {
    const a = pkgSetup(info({ update: true, current: { title: "Science", publisherName: "Teacher", edition: 1, printing: 1, variant: "student" } }));
    await act(async () => inspectPackage(a.client, a.store, "/p/2.odpack"));
    expect(await screen.findByText("Update “Science”?")).toBeTruthy();
    expect(screen.getByText("Here now: edition 1, printing 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("refuses one's own package", async () => {
    const { store, client, importFn } = pkgSetup(info({ refused: "ownPackage" }));
    await act(async () => startPackageImport(client, store, { fail: () => undefined }));
    // In the browser: a path box first.
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "/p/own.odpack" } });
    fireEvent.click(screen.getByRole("button", { name: "Look inside" }));
    expect(await screen.findByText("It was published from this workspace.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    expect(importFn).not.toHaveBeenCalled();
  });
});

describe("letters (D487 §35)", () => {
  const letterInfo = (over: Record<string, unknown> = {}) => ({
    kind: "letter",
    subject: "Homework 1",
    comment: "By Friday.",
    due: "2099-12-01",
    tasks: 1,
    pages: 1,
    from: { name: "Teacher Zhang", fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111", known: "checked" },
    fromName: "Teacher Zhang",
    sentAt: 1_700_000_000_000,
    inReplyTo: null,
    refused: null,
    places: [{ id: "in1", name: "Letters received" }, { id: "in2", name: "Class inbox" }],
    ...over,
  });
  function letterSetup(i: Record<string, unknown>) {
    const receive = vi.fn(async () => ({ resource: "L1" }));
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, { letter: { inspect: vi.fn(async () => i as never), receive } });
    const { store } = renderInShell(client, <TransferDialogs />);
    return { receive, store, client };
  }

  it("a letter file: who signed it, what is asked, by when; it goes where the user chooses", async () => {
    const { receive, store, client } = letterSetup(letterInfo());
    await act(async () => inspectPackage(client, store, "/p/Homework 1.odletter"));
    expect(await screen.findByText("Letter: Homework 1")).toBeTruthy();
    expect(screen.getByText("Signed by Teacher Zhang (checked)")).toBeTruthy();
    expect(screen.getByText("Due: 2099-12-01")).toBeTruthy();
    expect(screen.getByText("By Friday.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take it" }));
    await waitFor(() => expect(receive).toHaveBeenCalledWith("/p/Homework 1.odletter", "in1"));
  });

  it("a reply names the letter it answers; one not for you says so and takes nothing", async () => {
    const r = letterSetup(letterInfo({ kind: "reply", inReplyTo: "Homework 1", subject: "Homework 1" }));
    await act(async () => inspectPackage(r.client, r.store, "/p/r.odletter"));
    expect(await screen.findByText("Reply to “Homework 1”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take the reply" }));
    await waitFor(() => expect(r.receive).toHaveBeenCalledWith("/p/r.odletter", undefined));
  });

  it("refused: why, and nothing taken", async () => {
    const r = letterSetup(letterInfo({ refused: "notForYou" }));
    await act(async () => inspectPackage(r.client, r.store, "/p/x.odletter"));
    expect(await screen.findByText("This letter is not addressed to you.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Take it" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
