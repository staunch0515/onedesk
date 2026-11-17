import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { ToastProvider } from "../../design";
import { I18nProvider } from "../i18n";
import { DEMO_LANGUAGES } from "../i18n/lang-files";
import { ProtocolProvider, type ProtocolClient } from "../protocol";
import { WorkbenchProvider } from "../state/context";
import { noticeKeeper } from "../state/notices";
import { createStore, type Store } from "../state/store";

/** A client that behaves like a kernel-backed one for the shell (`demo.target` false) on top of the mock client the test gives (only tests may import the mock). */
export function kernelLikeClient(mock: ProtocolClient, overrides: Partial<ProtocolClient>): ProtocolClient {
  return { ...mock, demo: { tree: () => false, target: () => false }, ...overrides } as ProtocolClient;
}

/** Renders `ui` inside the same providers the app uses. `rerender` shows other content in the same providers (state is kept). */
export function renderInShell(client: ProtocolClient, ui: ReactNode, locale: string = "en-US"): { store: Store; rerender: (ui: ReactNode) => void } {
  const store = createStore(null, () => undefined);
  const wrap = (content: ReactNode) => (
    <ProtocolProvider client={client}>
      <I18nProvider locale={locale} texts={DEMO_LANGUAGES.find((l) => l.locale === locale)?.texts}>
        <ToastProvider closeLabel="Close" viewportLabel="Notifications" duration={1000} onToast={noticeKeeper(store)}>
          <WorkbenchProvider store={store}>{content}</WorkbenchProvider>
        </ToastProvider>
      </I18nProvider>
    </ProtocolProvider>
  );
  const view = render(wrap(ui));
  return { store, rerender: (next) => view.rerender(wrap(next)) };
}
