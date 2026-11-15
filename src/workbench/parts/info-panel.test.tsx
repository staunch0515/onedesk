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
import { InfoPanelPart } from "./info-panel";

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
