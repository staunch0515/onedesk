// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "../../design";
import { I18nProvider } from "../i18n";
import { ProtocolProvider } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { WorkbenchProvider } from "../state/context";
import { createStore } from "../state/store";
import { CommandDialogs } from "./command-dialogs";

function show(locale: "en-US" | "zh-CN", message: string) {
  const store = createStore(null, () => undefined);
  store.set({ confirmCommand: { message, command: "deleted.purge", danger: true, context: {} } });
  render(
    <ProtocolProvider client={createMockClient({ fresh: true, quiet: true })}>
      <I18nProvider locale={locale}>
        <ToastProvider closeLabel="Close" viewportLabel="Notifications" duration={1000}>
          <WorkbenchProvider store={store}>
            <CommandDialogs />
          </WorkbenchProvider>
        </ToastProvider>
      </I18nProvider>
    </ProtocolProvider>,
  );
}

describe("purge confirmation", () => {
  it("words the kernel's key, never shows the key itself, and names the action", async () => {
    show("en-US", "deleted.purge.confirm");
    expect(await screen.findByText(/cannot be undone/i)).toBeTruthy();
    expect(screen.queryByText("deleted.purge.confirm")).toBeNull();
    expect(screen.getByText(/backups/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeTruthy();
    expect(screen.getByText("Delete permanently?")).toBeTruthy();
  });

  it("falls back to the generic title and button for an unknown message", async () => {
    show("en-US", "Some plugin question");
    expect(await screen.findByText("Some plugin question")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });
});
