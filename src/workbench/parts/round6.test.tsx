// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InstallPreview, Run } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { DeletedPage } from "../pages/deleted-page";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { InfoPanelPart } from "./info-panel";
import { PageHost } from "./page-host";
import { InstallDialogs, inspectFolder } from "./install-dialogs";
import { parsePrograms } from "./programs-notice";
import { liveText, useLiveLog } from "./result-area";

const preview: InstallPreview = {
  valid: true,
  id: "com.example.command",
  version: "0.1.0",
  fingerprint: "fp",
  name: "Command",
  description: "Runs programs",
  icon: "terminal",
  author: "Example",
  permissions: [{ id: "programs", detail: "echo, sh, hello (plugin)", granted: false, required: true }],
  installed: [],
  addedPermissions: ["programs"],
  provides: { kinds: [], actions: [], trees: [], resultTabs: [], other: [] },
};

describe("programs permission", () => {
  it("parses names and marks the plugin's own", () => {
    expect(parsePrograms("echo, hello (plugin)")).toEqual([{ name: "echo", bundled: false }, { name: "hello", bundled: true }]);
    expect(parsePrograms(undefined)).toEqual([]);
  });

  it("gets its own warning paragraph in the install dialog", async () => {
    const app = { inspectPlugin: vi.fn(async () => preview), installPlugin: vi.fn(), removePlugin: vi.fn() };
    const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { app: app as never });
    const { store } = renderInShell(client, <InstallDialogs />);
    await act(async () => inspectFolder(client, store, "/pkg"));
    expect(await screen.findByText("It runs external programs, and those programs can reach everything on this computer that you can reach.")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("from the plugin")).toBeTruthy();
  });
});

describe("live output", () => {
  const run = (message: string | undefined, status: Run["status"] = "running", id = "r1"): Run => ({ id, status, progress: message === undefined ? undefined : { message } }) as Run;
  function Probe({ r }: { r: Run }) {
    return <pre data-testid="log">{useLiveLog(r).join("|")}</pre>;
  }
  it("collects progress messages in order and drops them when the run ends", async () => {
    const { rerender } = render(<Probe r={run("a")} />);
    rerender(<Probe r={run("b")} />);
    rerender(<Probe r={run("b")} />);
    rerender(<Probe r={run("c")} />);
    await waitFor(() => expect(screen.getByTestId("log").textContent).toBe("a|b|c"));
    rerender(<Probe r={run(undefined, "success")} />);
    await waitFor(() => expect(screen.getByTestId("log").textContent).toBe(""));
  });
});

describe("live text", () => {
  it("does not double the line breaks of whole-line chunks", () => {
    expect(liveText(["1\n", "2\n", "3\n"])).toBe("1\n2\n3");
    expect(liveText(["a", "b\n"])).toBe("a\nb");
  });
});

describe("references", () => {
  const ref = (fieldLabel?: { "en-US": string }) => ({ source: { id: "s1", name: "Source" }, field: "body.text", text: "x", state: "ok" as const, ...(fieldLabel ? { fieldLabel } : {}) });
  it("shows the field label and nothing when there is none", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const incoming = vi.fn(async () => [ref({ "en-US": "Notes" }), { ...ref(), source: { id: "s2", name: "Other" } }]);
    const client = kernelLikeClient(mock, { refs: { outgoing: async () => [], incoming } });
    renderInShell(client, <InfoPanelPart resourceId="q-orders-today" />);
    expect(await screen.findByText("In Notes")).toBeTruthy();
    expect(screen.queryByText(/body\.text/)).toBeNull();
    expect(screen.getAllByText(/^In /)).toHaveLength(1);
  });
});

describe("permanent delete", () => {
  it("says how many items still refer to it", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const gone = { id: "d1", name: "Old note", kind: "x:y", kindLabel: "x", icon: "file", tree: "resources", location: ["Root"], updatedAt: 1, deletedAt: 1 } as never;
    const incoming = vi.fn(async () => [ref("a"), ref("a"), ref("b")]);
    function ref(id: string) {
      return { source: { id, name: id }, field: "body.text", text: "x", state: "deleted" as const };
    }
    const client = kernelLikeClient(mock, { resource: { ...mock.resource, listDeleted: async () => [gone] }, refs: { outgoing: async () => [], incoming } });
    const tab = { id: "t", target: "core:deleted" } as never;
    const descriptor = { target: "core:deleted", title: "Deleted", icon: "trash-2", found: true, state: "ok", breadcrumb: [], page: "deleted", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as never;
    renderInShell(client, <DeletedPage tab={tab} descriptor={descriptor} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    expect(await screen.findByText(/2 other item\(s\) still refer to it/)).toBeTruthy();
    expect(incoming).toHaveBeenCalledWith("d1");
  });
});

describe("plugin topic", () => {
  it("resolves the page again when its plugin says it changed", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const handlers: Record<string, Array<() => void>> = {};
    const resolve = vi.fn(async (target: string) => ({ target, title: "T", icon: "file", found: true, state: "ok", breadcrumb: [], page: "view", view: [], actions: [{ id: "run", label: "Run", role: "run", action: "com.example.command:run" }], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false }) as never);
    const events = { subscribe: (topic: string, h: () => void) => ((handlers[topic] ??= []).push(h), () => undefined) };
    const client = kernelLikeClient(mock, { page: { ...mock.page, resolve }, events: events as never });
    renderInShell(client, <PageHost tab={{ id: "t1", target: "node:x", reload: 0 } as never} />);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(handlers["plugin:com.example.command"]?.length).toBeGreaterThan(0));
    await act(async () => handlers["plugin:com.example.command"]!.forEach((h) => h()));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  });
});
