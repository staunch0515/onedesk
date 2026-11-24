// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../design";
import { I18nProvider } from "../i18n";
import { ProtocolProvider, type ProtocolClient } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { WorkbenchProvider } from "../state/context";
import { createStore } from "../state/store";
import type { PageDescriptor } from "../protocol";
import { InfoPanelPart, NewInfoPanelPart } from "./info-panel";

function setup(history: ProtocolClient["resource"]["history"], restore = vi.fn(async () => undefined)) {
  const mock = createMockClient({ fresh: true, quiet: true });
  const client: ProtocolClient = { ...mock, resource: { ...mock.resource, history, restore } };
  const store = createStore(null, () => undefined);
  render(
    <ProtocolProvider client={client}>
      <I18nProvider locale="en-US">
        <ToastProvider closeLabel="Close" viewportLabel="Notifications" duration={1000}>
          <WorkbenchProvider store={store}>
            <InfoPanelPart resourceId="q-orders-today" />
          </WorkbenchProvider>
        </ToastProvider>
      </I18nProvider>
    </ProtocolProvider>,
  );
  return { restore };
}

const entries = [
  { id: "h2", at: 2000, actor: "user", op: "update", field: "name", before: "old", after: "new" },
  { id: "h1", at: 1000, actor: "user", op: "update", field: "body.text", before: "x".repeat(100), after: "y" },
];

describe("info panel history", () => {
  it("is collapsed by default and reads history only when opened", async () => {
    const history = vi.fn(async () => entries);
    setup(history);
    await screen.findByText("Show changes");
    expect(history).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show changes" }));
    await screen.findByText("name");
    expect(history).toHaveBeenCalled();
  });

  it("lists newest first, shortens long values and restores an entry", async () => {
    const { restore } = setup(async () => entries);
    fireEvent.click(await screen.findByRole("button", { name: "Show changes" }));
    const fields = await screen.findAllByText(/^(name|body\.text)$/);
    expect(fields.map((f) => f.textContent)).toEqual(["name", "body.text"]);
    expect(screen.getByText(/^x{40}… → y$/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[1]!);
    await waitFor(() => expect(restore).toHaveBeenCalledWith("q-orders-today", "h1"));
  });

  it("says so when nothing changed yet", async () => {
    setup(async () => []);
    fireEvent.click(await screen.findByRole("button", { name: "Show changes" }));
    await screen.findByText("No changes yet");
  });
});

describe("info panel references", () => {
  it("lists what the resource refers to and who refers to it, with the state of each", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const ref = (state: "ok" | "deleted" | "missing", text: string, id?: string) => ({ source: { id: "q-orders-today", name: "Orders" }, field: "body.text", text, ...(id ? { target: { id, name: `Name ${text}` } } : {}), state });
    const open = vi.fn();
    const client: ProtocolClient = {
      ...mock,
      refs: {
        outgoing: async () => [ref("ok", "a", "t1"), ref("deleted", "b", "t2"), ref("missing", "c")],
        incoming: async () => [{ source: { id: "s1", name: "Other note" }, field: "body.text", text: "Orders", target: { id: "q-orders-today", name: "Orders" }, state: "ok" }],
      },
    };
    const store = createStore(null, () => undefined);
    render(
      <ProtocolProvider client={client}>
        <I18nProvider locale="en-US">
          <ToastProvider closeLabel="Close" viewportLabel="Notifications" duration={1000}>
            <WorkbenchProvider store={store}>
              <InfoPanelPart resourceId="q-orders-today" />
            </WorkbenchProvider>
          </ToastProvider>
        </I18nProvider>
      </ProtocolProvider>,
    );
    expect(await screen.findByText("Name a")).toBeTruthy();
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByText("Broken")).toBeTruthy();
    expect(screen.getByText("[[c]]")).toBeTruthy();
    fireEvent.click(await screen.findByText("Other note"));
    expect(store.get().tabs.some((t) => t.target === "resource:s1")).toBe(true);
    void open;
  });
});

describe("info panel of a resource not saved yet (D469)", () => {
  it("name, description and tags go into the tab's draft; location and kind are shown", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const store = createStore(null, () => undefined);
    const descriptor = { target: "new:k", title: "Untitled prompt", icon: "file", kindLabel: "Prompt", found: true, state: "ok", breadcrumb: [{ label: "Team" }, { label: "Untitled prompt" }] } as unknown as PageDescriptor;
    render(
      <ProtocolProvider client={mock}>
        <I18nProvider locale="en-US">
          <ToastProvider closeLabel="Close" viewportLabel="Notifications" duration={1000}>
            <WorkbenchProvider store={store}>
              <NewInfoPanelPart tabId="t1" descriptor={descriptor} />
            </WorkbenchProvider>
          </ToastProvider>
        </I18nProvider>
      </ProtocolProvider>,
    );
    expect(screen.getByText(/Not saved yet/)).toBeTruthy();
    expect(screen.getByText("Top level / Team")).toBeTruthy();
    expect(screen.getByText("Prompt")).toBeTruthy();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Untitled prompt");
    fireEvent.change(name, { target: { value: "Weekly" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Fridays" } });
    const tags = screen.getByLabelText("Tags");
    fireEvent.change(tags, { target: { value: "a, b，c" } });
    fireEvent.blur(tags);
    await waitFor(() => expect(store.get().drafts.t1).toEqual({ name: "Weekly", description: "Fridays", tags: ["a", "b", "c"] }));
  });
});
