import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeProvider, ToastProvider, useToast, type Density, type ThemePreference } from "../design";
import { BUILT_IN_LOCALE, I18nProvider, useI18n } from "./i18n";
import { ProtocolProvider, useClient, type LanguageInfo, type Locale, type ProtocolClient } from "./protocol";
import type { Settings } from "./parts/status-bar";
import { WorkbenchProvider } from "./state/context";
import { noticeKeeper } from "./state/notices";
import type { Store } from "./state/store";
import { Workbench } from "./workbench";

export async function readSettings(client: ProtocolClient): Promise<Settings> {
  const [language, theme, density] = await Promise.all([client.workspace.getConfig("ui.language"), client.workspace.getConfig("ui.theme"), client.workspace.getConfig("ui.density")]);
  return {
    // Whatever is configured; `Shell` falls back to English when no enabled language plugin offers it (D379).
    locale: language && language.trim() !== "" ? language : BUILT_IN_LOCALE,
    theme: (["system", "light", "dark"].includes(theme ?? "") ? theme : "system") as ThemePreference,
    density: (density === "compact" ? "compact" : "comfortable") as Density,
  };
}

const ENGLISH: LanguageInfo = { locale: BUILT_IN_LOCALE, name: "English" };

/**
 * The languages on offer (`i18n.languages`, refreshed on the `languages` topic) and the chosen one's texts (D379).
 * The chosen language is the configured one if it is on offer, else English; its texts overlay the built-in English.
 */
export function useLanguage(configured: Locale): { languages: LanguageInfo[]; locale: Locale; texts: Record<string, string> | undefined } {
  const client = useClient();
  const [languages, setLanguages] = useState<LanguageInfo[]>([ENGLISH]);
  const [loaded, setLoaded] = useState(!client.i18n);
  useEffect(() => {
    const api = client.i18n;
    if (!api) return;
    let live = true;
    const load = () =>
      api.languages().then(
        (list) => live && (setLanguages(list.some((l) => l.locale === BUILT_IN_LOCALE) ? list : [ENGLISH, ...list]), setLoaded(true)),
        () => live && setLoaded(true),
      );
    void load();
    const off = client.events.subscribe("languages", () => void load());
    return () => {
      live = false;
      off();
    };
  }, [client]);

  // Until the list is known the configured language is trusted, so the first paint is not English-then-Chinese.
  const locale = !loaded || languages.some((l) => l.locale === configured) ? configured : BUILT_IN_LOCALE;
  const [shell, setShell] = useState<{ locale: Locale; texts: Record<string, string> } | null>(null);
  const plugin = languages.find((l) => l.locale === locale)?.plugin;
  useEffect(() => {
    const api = client.i18n;
    if (!api || locale === BUILT_IN_LOCALE) {
      setShell(null);
      return;
    }
    let live = true;
    // `plugin` in the key list: the same locale from another plugin (or another version) reloads the texts.
    void api.shell(locale).then(
      (r) => live && setShell({ locale, texts: r.texts }),
      () => live && setShell(null),
    );
    return () => {
      live = false;
    };
  }, [client, locale, plugin]);
  return { languages, locale, texts: shell?.locale === locale ? shell.texts : undefined };
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
    if (!startupError) return;
    live.current.toast({ tone: "warning", title: live.current.t("startup.failed", { reason: startupError }) });
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
  const language = useLanguage(settings.locale);
  useEffect(() => {
    document.documentElement.lang = language.locale;
  }, [language.locale]);

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
    <I18nProvider locale={language.locale} texts={language.texts}>
      <ThemeProvider theme={settings.theme} density={settings.density}>
        <Toasts store={store}>
          <ConnectionNotices startupError={startupError} />
          <WorkbenchProvider store={store}>
            <Workbench settings={{ ...settings, locale: language.locale }} languages={language.languages} onSetting={onSetting} />
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
