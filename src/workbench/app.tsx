import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeProvider, ToastProvider, useToast, type Density, type ThemePreference } from "../design";
import { I18nProvider, useI18n } from "./i18n";
import { ProtocolProvider, useClient, type Locale, type ProtocolClient } from "./protocol";
import type { Settings } from "./parts/status-bar";
import { WorkbenchProvider } from "./state/context";
import { noticeKeeper } from "./state/notices";
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

function Toasts({ store, children }: { store: Store; children: React.ReactNode }) {
  const { t } = useI18n();
  // Every toast is also kept for the status bar's notice list (D376).
  const keep = useMemo(() => noticeKeeper(store), [store]);
  return (
    <ToastProvider closeLabel={t("common.close")} viewportLabel={t("common.notifications")} duration={3500} onToast={keep}>
      {children}
    </ToastProvider>
  );
}

/** Says so when the workspace service could not be reached at start, when it stops and when it is back. */
function ConnectionNotices({ startupError }: { startupError?: string }) {
  const client = useClient();
  const { toast } = useToast();
  const { t } = useI18n();
  const live = useRef({ toast, t });
  live.current = { toast, t };
  useEffect(() => {
    if (startupError) live.current.toast({ tone: "warning", title: live.current.t("startup.failed", { reason: startupError }) });
  }, [startupError]);
  useEffect(
    () =>
      client.events.subscribe("connection", (_topic, payload) => {
        const { toast: show, t: tr } = live.current;
        if (payload === "lost") show({ tone: "warning", title: tr("connection.lost") });
        else if (payload === "restored") show({ tone: "success", title: tr("connection.restored") });
      }),
    [client],
  );
  return null;
}

function Shell({ store, initial, startupError }: { store: Store; initial: Settings; startupError?: string }) {
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
      // A refused write must not look like success: read the stored settings again and tell the caller.
      return client.workspace.setConfig(name, value).catch(async (error) => {
        await readSettings(client).then(setSettings, () => undefined);
        throw error;
      });
    },
    [client],
  );

  return (
    <I18nProvider locale={settings.locale}>
      <ThemeProvider theme={settings.theme} density={settings.density}>
        <Toasts store={store}>
          <ConnectionNotices startupError={startupError} />
          <WorkbenchProvider store={store}>
            <Workbench settings={settings} onSetting={onSetting} />
          </WorkbenchProvider>
        </Toasts>
      </ThemeProvider>
    </I18nProvider>
  );
}

export function App({ client, store, settings, startupError }: { client: ProtocolClient; store: Store; settings: Settings; startupError?: string }) {
  return (
    <ProtocolProvider client={client}>
      <Shell store={store} initial={settings} startupError={startupError} />
    </ProtocolProvider>
  );
}
