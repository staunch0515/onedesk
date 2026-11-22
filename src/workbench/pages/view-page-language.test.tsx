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

describe("required parameter fields (D414)", () => {
  it("marks the label and stops a run while a required value is empty; runs once it is filled", async () => {
    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const start = vi.fn(async () => "run1");
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, run: { ...base.run, start } };
    const page = {
      ...descriptor,
      view: [{ type: "form", id: "p", layout: "strip", label: "Parameters", fields: [{ name: "id", label: "Id", kind: "text", param: true, required: true, maxLength: 5 }] }],
      actions: [{ id: "run", label: "Run", role: "run", action: "p:run", primary: true }],
    } as unknown as PageDescriptor;
    const { store } = renderInShell(client, <ViewPage tab={tab} descriptor={page} />);
    store.set({ tabs: [tab], activeTabId: "t1" });
    expect(screen.getByText("Id", { exact: false }).textContent).toContain("*");
    const box = screen.getByLabelText("Id") as HTMLInputElement;
    expect(box.maxLength).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(screen.getByText("Fill in: Id")).toBeTruthy());
    expect(start).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(start).toHaveBeenCalled());
  });
});

describe("required fields and the actions they stop (D436)", () => {
  const form = { type: "form", id: "p", layout: "strip", label: "Parameters", fields: [{ name: "id", label: "Id", kind: "text", param: true, required: true }, { name: "body", label: "Body", kind: "text", bind: "body" }] };
  const setup = async (actions: unknown[]) => {
    const { vi } = await import("vitest");
    const start = vi.fn(async () => "run1");
    const save = vi.fn(async () => ({ page: { target: tab.target, title: "R", basis: "2" } }));
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, run: { ...base.run, start }, page: { ...base.page, save } };
    const page = { ...descriptor, view: [form], actions, values: { body: "a" } } as unknown as PageDescriptor;
    const { store } = renderInShell(client, <ViewPage tab={tab} descriptor={page} />);
    store.set({ tabs: [tab], activeTabId: "t1", drafts: { t1: { body: "b" } } });
    return { start, save };
  };
  it("an empty required parameter does not stop saving", async () => {
    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    const { save, start } = await setup([{ id: "save", label: "Save", role: "save" }, { id: "run", label: "Run", role: "run", action: "p:run" }]);
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(start).not.toHaveBeenCalled();
  });
  it("still stops a run", async () => {
    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    const { save, start } = await setup([{ id: "save", label: "Save", role: "save" }, { id: "run", label: "Run", role: "run", action: "p:run" }]);
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(screen.getByText("Fill in: Id")).toBeTruthy());
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("a page button that declares a command (D429)", () => {
  it("runs the command on this page with the input values as args, and does not start a run", async () => {
    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    const { vi } = await import("vitest");
    const execute = vi.fn(async () => []);
    const start = vi.fn(async () => "run1");
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const client = { ...base, command: { ...base.command, execute }, run: { ...base.run, start } };
    const page = {
      ...descriptor,
      view: [{ type: "form", id: "f", layout: "stack", fields: [{ name: "newName", label: "New name", kind: "text", bind: "newName" }] }],
      values: { newName: "a.txt" },
      actions: [{ id: "rename", label: "Rename it", role: "command", command: "org.example:rename" }],
    } as unknown as PageDescriptor;
    const { store } = renderInShell(client, <ViewPage tab={tab} descriptor={page} />);
    store.set({ tabs: [tab], activeTabId: "t1" });
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "b.txt" } });
    fireEvent.click(screen.getByRole("button", { name: /Rename it/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("org.example:rename", expect.objectContaining({ target: "resource:r1", args: expect.objectContaining({ newName: "b.txt" }) })));
    expect(start).not.toHaveBeenCalled();
  });
});
