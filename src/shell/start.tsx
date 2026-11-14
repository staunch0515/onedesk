/** Boot screen → blocked page (migration error) or the app. */
import { useCallback, useEffect, useState } from "react";
import { Banner, ErrorState, LoadingState, Page, PageBody, PageHeader, Stack, Text, ThemeProvider, type Density, type ThemePreference } from "../design";
import type { AppStatus } from "../kernel/contracts";
import { App, DENSITY_PREF, readDensity, readTheme, THEME_PREF } from "./app";
import { boot, type BootResult } from "./bootstrap";
import { errorInfo } from "./format";
import { t } from "./i18n";

export function BlockedPage({ status }: { status: AppStatus }) {
  return (
    <Page>
      <PageHeader icon="database" title={t("blocked.title")} />
      <PageBody width="readable">
        <Stack gap="lg">
          <Banner tone="danger" title={t("blocked.reason", { reason: status.migrationError ?? "" })}>
            {t("blocked.backup")}
          </Banner>
          <Stack gap="sm">
            <Text mono as="p">
              {t("blocked.dataDir", { dir: status.dataDir })}
            </Text>
            <Text mono as="p">
              {t("blocked.dbPath", { path: status.dbPath })}
            </Text>
            <Text as="p" tone="muted">
              {t("blocked.version", { current: status.schemaVersion, latest: status.latestSchemaVersion })}
            </Text>
          </Stack>
          <Text as="p">{t("blocked.resolution")}</Text>
        </Stack>
      </PageBody>
    </Page>
  );
}

type StartState =
  | { type: "loading" }
  | { type: "failed"; error: unknown }
  | { type: "ready"; boot: Extract<BootResult, { type: "ready" }>; theme: ThemePreference; density: Density }
  | { type: "blocked"; status: AppStatus };

// One boot per page load (StrictMode runs effects twice; two kernels on one database must never exist).
let booting: Promise<BootResult> | null = null;
function bootOnce(retry: boolean): Promise<BootResult> {
  if (!booting || retry) booting = boot();
  return booting;
}

export function Start() {
  const [state, setState] = useState<StartState>({ type: "loading" });
  const run = useCallback((retry = false) => {
    setState({ type: "loading" });
    bootOnce(retry).then(
      async (result) => {
        if (result.type === "blocked") {
          setState({ type: "blocked", status: result.status });
          return;
        }
        const [theme, density] = await Promise.all([result.kernel.prefs.get(THEME_PREF), result.kernel.prefs.get(DENSITY_PREF)]);
        setState({ type: "ready", boot: result, theme: readTheme(theme), density: readDensity(density) });
      },
      (error: unknown) => {
        console.error("[onedesk] boot failed", error);
        setState({ type: "failed", error });
      },
    );
  }, []);
  useEffect(() => run(), [run]);

  if (state.type === "ready") {
    return <App kernel={state.boot.kernel} services={state.boot.services} initialTheme={state.theme} initialDensity={state.density} />;
  }
  let content;
  if (state.type === "blocked") content = <BlockedPage status={state.status} />;
  else if (state.type === "failed") {
    const info = errorInfo(state.error);
    content = <ErrorState title={t("app.bootFailed")} reason={info.message} resolution={info.hint ?? t("app.bootFailedResolution")} onRetry={() => run(true)} retryLabel={t("app.retry")} />;
  } else content = <LoadingState label={t("app.loading")} />;
  return <ThemeProvider>{content}</ThemeProvider>;
}
