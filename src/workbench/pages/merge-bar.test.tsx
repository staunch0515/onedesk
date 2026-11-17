// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PageDescriptor } from "../protocol";
import { createMockClient } from "../protocol/mock";
import type { TabState } from "../state/store";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { ViewPage } from "./view-page";

const tab: TabState = { id: "t1", target: "resource:r1", title: "R", icon: "file", pinned: false, envId: null, params: {}, basis: "1" };
const page = (values: Record<string, unknown>, basis: string): PageDescriptor =>
  ({
    target: tab.target,
    title: "R",
    icon: "file",
    found: true,
    state: "ok",
    breadcrumb: [],
    page: "view",
    resourceId: "r1",
    basis,
    view: [
      {
        type: "form",
        id: "f",
        label: "F",
        fields: [
          { name: "name", label: "Name", kind: "text", bind: "name" },
          { name: "text", label: "Text", kind: "longtext", bind: "body.text" },
        ],
      },
    ],
    actions: [{ id: "save", label: "Save", icon: "save", role: "save" }],
    resultTabs: [],
    usesEnv: false,
    hasInfo: false,
    readOnly: false,
    recompute: false,
    values,
    autosave: false,
  }) as unknown as PageDescriptor;

function setup() {
  const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
  const { store, rerender } = renderInShell(client, <ViewPage tab={tab} descriptor={page({ name: "A", "body.text": "t" }, "1")} />);
  store.set({ tabs: [tab], activeTabId: "t1" });
  const show = (values: Record<string, unknown>, basis: string) => act(async () => rerender(<ViewPage tab={tab} descriptor={page(values, basis)} />));
  const type = (label: string, value: string) => act(async () => void fireEvent.change(screen.getByLabelText(label), { target: { value } }));
  return { store, show, type };
}

describe("unsaved content changed elsewhere (D374)", () => {
  it("a field changed elsewhere that was not typed here just shows the new value; no bar, the typed value stays", async () => {
    const { store, show, type } = setup();
    await type("Text", "mine");
    await show({ name: "B", "body.text": "t" }, "2");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("B");
    expect((screen.getByLabelText("Text") as HTMLTextAreaElement).value).toBe("mine");
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
    expect(store.get().drafts.t1).toEqual({ "body.text": "mine" });
  });

  it("the same field changed elsewhere asks: the bar names the field and nothing is overwritten either way", async () => {
    const { store, show, type } = setup();
    await type("Text", "mine");
    await show({ name: "A", "body.text": "theirs" }, "2");
    expect(screen.getByText("Changed elsewhere")).toBeTruthy();
    expect(screen.getByText(/Text\. Keep your version/)).toBeTruthy();
    expect(store.get().merge.t1?.conflicts).toEqual(["body.text"]);
    expect((screen.getByLabelText("Text") as HTMLTextAreaElement).value).toBe("mine");
    expect(store.get().drafts.t1).toEqual({ "body.text": "mine" });
  });

  it("\"Keep mine\" keeps the typed value and remembers the field for the save (overwrite)", async () => {
    const { store, show, type } = setup();
    await type("Text", "mine");
    await show({ name: "A", "body.text": "theirs" }, "2");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Keep mine" })));
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
    expect(store.get().merge.t1).toEqual({ conflicts: [], keep: ["body.text"] });
    expect(store.get().drafts.t1).toEqual({ "body.text": "mine" });
    expect(store.get().tabs[0]?.basis).toBe("1");
  });

  it("\"Use the new one\" drops the typed value of that field, shows the new one and moves the basis on", async () => {
    const { store, show, type } = setup();
    await type("Name", "my name");
    await type("Text", "mine");
    await show({ name: "A", "body.text": "theirs" }, "2");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Use the new one" })));
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
    expect((screen.getByLabelText("Text") as HTMLTextAreaElement).value).toBe("theirs");
    expect(store.get().drafts.t1).toEqual({ name: "my name" });
    expect(store.get().merge.t1).toBeUndefined();
    expect(store.get().tabs[0]?.basis).toBe("2");
  });

  it("changed elsewhere to exactly what was typed: the draft is dropped, no bar", async () => {
    const { store, show, type } = setup();
    await type("Text", "same");
    await show({ name: "A", "body.text": "same" }, "2");
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
    expect(store.get().drafts.t1).toEqual({});
  });
});
