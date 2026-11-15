import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { ToastProvider } from "../../design";
import { I18nProvider } from "../i18n";
import { ProtocolProvider, type ProtocolClient } from "../protocol";
import { WorkbenchProvider } from "../state/context";
import { createStore, type Store } from "../state/store";

/** A client that behaves like a kernel-backed one for the shell (`demo.target` false) on top of the mock client the test gives (only tests may import the mock). */
export function kernelLikeClient(mock: ProtocolClient, overrides: Partial<ProtocolClient>): ProtocolClient {
  return { ...mock, demo: { tree: () => false, target: () => false }, ...overrides } as ProtocolClient;
}

/** Renders `ui` inside the same providers the app uses. */
export function renderInShell(client: ProtocolClient, ui: ReactNode, locale: "en-US" | "zh-CN" = "en-US"): { store: Store } {
  const store = createStore(null, () => undefined);
  render(
    <ProtocolProvider client={client}>
      <I18nProvider locale={locale}>
        <ToastProvider closeLabel="Close" viewportLabel="Notifications" duration={1000}>
          <WorkbenchProvider store={store}>{ui}</WorkbenchProvider>
        </ToastProvider>
      </I18nProvider>
    </ProtocolProvider>,
  );
  return { store };
}
