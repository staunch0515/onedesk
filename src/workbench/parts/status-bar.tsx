import { DropdownMenu, StatusBar, StatusItem, type Density, type ThemePreference } from "../../design";
import { LOCALES, useI18n } from "../i18n";
import type { Locale } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";

export interface Settings {
  locale: Locale;
  theme: ThemePreference;
  density: Density;
}

export function StatusBarPart({ settings, onSetting, resolvedTheme }: { settings: Settings; onSetting: (name: "ui.language" | "ui.theme" | "ui.density", value: string) => void; resolvedTheme: "light" | "dark" }) {
  const { client, store, actions } = useWorkbench();
  const { t, number, duration, runError } = useI18n();
  const tab = useUi((s) => s.tabs.find((x) => x.id === s.activeTabId) ?? null);
  const tasksOpen = useUi((s) => s.tasksOpen);
  const workspaces = useQuery((c) => c.workspace.list(), []);
  const tasks = useQuery((c) => c.run.tasks(), [], ["runs"]);
  const envId = tab?.usesEnv ? tab.envId : null;
  const envs = useQuery((c) => c.params.envOptions(), [], ["env", "tree:environments"]);
  const source = useQuery((c) => (envId ? c.params.resolve(envId, "datasource") : Promise.resolve(null)), [envId], ["env", "tree:datasources"]);
  const runId = tab?.runId ?? (tab?.target.startsWith("run:") ? tab.target.slice(4) : null);
  const run = useQuery((c) => (runId ? c.run.get(runId) : Promise.resolve(null)), [runId], runId ? [`run:${runId}`] : []);

  const running = (tasks.data ?? []).filter((r) => r.status === "running").length;
  const failed = (tasks.data ?? []).filter((r) => r.status === "error").length;
  const env = envs.data?.find((e) => e.id === envId);
  const r = run.data;

  return (
    <StatusBar
      label={t("status.label")}
      start={
        <>
          <StatusItem icon="box" title={t("status.workspace")}>
            {workspaces.data?.find((w) => w.current)?.name ?? "…"}
          </StatusItem>
          {tab?.usesEnv && (
            <StatusItem icon="layers" tone={env ? "default" : "warning"} title={t("status.environment")} onClick={env ? () => actions.open(`resource:${env.id}`) : undefined}>
              {env?.name ?? t("status.noEnvironment")}
            </StatusItem>
          )}
          {tab?.usesEnv && source.data?.found && (
            <StatusItem icon="database" title={t("status.dataSource", { name: source.data.sourceName })} onClick={() => actions.open(`resource:${source.data!.value}`)}>
              {source.data.display}
            </StatusItem>
          )}
        </>
      }
      center={
        r ? (
          r.status === "running" ? (
            <StatusItem icon="loader" busy tone="accent">
              {`${r.title} — ${r.progress?.message ?? t("result.running")}${r.progress?.fraction !== undefined ? ` (${Math.round(r.progress.fraction * 100)}%)` : ""}`}
            </StatusItem>
          ) : r.status === "error" ? (
            <StatusItem icon="circle-alert" tone="danger" title={t("status.showResult")} onClick={() => store.set({ panelOpen: true })}>
              {`#${r.seq} ${r.error ? runError(r.error) : t("run.error")}`}
            </StatusItem>
          ) : (
            <StatusItem icon={r.status === "success" ? "circle-check" : "circle-slash"} tone={r.status === "success" ? "success" : "default"} title={t("status.showResult")} onClick={() => store.set({ panelOpen: true })}>
              {[`#${r.seq}`, r.summary?.rows !== undefined ? t("result.rows", { count: number(r.summary.rows) }) : (r.summary?.message ?? ""), r.summary?.durationMs !== undefined ? duration(r.summary.durationMs) : ""].filter(Boolean).join(" · ")}
            </StatusItem>
          )
        ) : undefined
      }
      end={
        <>
          <StatusItem icon="flask-conical" tone="warning" title={client.demo ? t("status.partialDemoHint") : t("status.mockHint", { version: client.version })}>
            {client.demo ? t("status.partialDemo") : t("status.mock")}
          </StatusItem>
          <StatusItem icon={running > 0 ? "loader" : failed > 0 ? "circle-alert" : "list-checks"} busy={running > 0} tone={running > 0 ? "accent" : "default"} pressed={tasksOpen} title={t("status.tasksHint")} onClick={() => store.set({ tasksOpen: !tasksOpen })}>
            {running > 0 ? t("status.running", { count: running }) : t("status.tasks", { count: tasks.data?.length ?? 0 })}
          </StatusItem>
          <StatusItem icon={settings.density === "compact" ? "rows-4" : "rows-3"} title={t("status.density")} onClick={() => onSetting("ui.density", settings.density === "compact" ? "comfortable" : "compact")}>
            {settings.density === "compact" ? t("status.compact") : t("status.comfortable")}
          </StatusItem>
          <StatusItem icon={resolvedTheme === "dark" ? "moon" : "sun"} title={t("status.theme")} onClick={() => onSetting("ui.theme", resolvedTheme === "dark" ? "light" : "dark")} />
          <DropdownMenu
            side="top"
            align="end"
            items={LOCALES.map((l) => ({ key: l.value, label: l.label, icon: l.value === settings.locale ? "check" : "languages", onSelect: () => onSetting("ui.language", l.value) }))}
            trigger={
              <StatusItem icon="languages" title={t("status.language")} aria-label={t("status.language")}>
                {LOCALES.find((l) => l.value === settings.locale)?.label}
              </StatusItem>
            }
          />
        </>
      }
    />
  );
}
