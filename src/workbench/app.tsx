import { useCallback, useEffect, useState } from "react";
import { ThemeProvider, ToastProvider, type Density, type ThemePreference } from "../design";
import { I18nProvider, useI18n } from "./i18n";
import { ProtocolProvider, useClient, type Locale, type ProtocolClient } from "./protocol";
import type { Settings } from "./parts/status-bar";
import { WorkbenchProvider } from "./state/context";
import type { Store } from "./state/store";
import { Workbench } from "./workbench";

export async function readSettings(client: ProtocolClient): Promise<Settings> {
  const [language, theme, density] = await Promise.all([client.workspace.getConfig("ui.language"), client.workspace.getConfig("ui.theme"), client.workspace.getConfig("ui.density")]);
  return {
    locale: language === "zh-CN" ? "zh-CN" : "en-US",
    theme: (["system", "light", "dark"].includes(theme ?? "") ? theme : "system") as ThemePreference,
    density: (density === "compact" ? "compact" : "comfortable") as Density,
  };
}

function Toasts({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <ToastProvider closeLabel={t("common.close")} viewportLabel={t("common.notifications")} duration={3500}>
      {children}
    </ToastProvider>
  );
}

function Shell({ store, initial }: { store: Store; initial: Settings }) {
  const client = useClient();
  const [settings, setSettings] = useState(initial);

  // Language, theme and density are workspace configuration (D192): follow them when they change anywhere.
  useEffect(() => client.events.subscribe("config", () => void readSettings(client).then(setSettings)), [client]);
  useEffect(() => {
    document.documentElement.lang = settings.locale;
  }, [settings.locale]);

  const onSetting = useCallback(
    (name: "ui.language" | "ui.theme" | "ui.density", value: string) => {
      // Apply at once; the config event confirms it.
      setSettings((s) => ({ ...s, ...(name === "ui.language" ? { locale: value as Locale } : name === "ui.theme" ? { theme: value as ThemePreference } : { density: value as Density }) }));
      void client.workspace.setConfig(name, value);
    },
    [client],
  );

  return (
    <I18nProvider locale={settings.locale}>
      <ThemeProvider theme={settings.theme} density={settings.density}>
        <Toasts>
          <WorkbenchProvider store={store}>
            <Workbench settings={settings} onSetting={onSetting} />
          </WorkbenchProvider>
        </Toasts>
      </ThemeProvider>
    </I18nProvider>
  );
}

export function App({ client, store, settings }: { client: ProtocolClient; store: Store; settings: Settings }) {
  return (
    <ProtocolProvider client={client}>
      <Shell store={store} initial={settings} />
    </ProtocolProvider>
  );
}
