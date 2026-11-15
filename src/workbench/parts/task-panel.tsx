import { Button, EmptyState, FloatingPanel, IconButton, TaskItem } from "../../design";
import { useI18n } from "../i18n";
import type { RunStatus } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";

/** Task panel (§8): running and just-finished runs with progress, cancel, clear finished. */
export function TaskPanel() {
  const { client, store, actions } = useWorkbench();
  const { t, tx, time, number, duration, runError } = useI18n();
  const tasks = useQuery((c) => c.run.tasks(), [], ["runs"]);
  const list = tasks.data ?? [];
  const statusName: Record<RunStatus, string> = { running: t("run.running"), success: t("run.success"), error: t("run.error"), cancelled: t("run.cancelled") };
  return (
    <FloatingPanel
      label={t("tasks.title")}
      title={t("tasks.title")}
      closeLabel={t("common.close")}
      onClose={() => store.set({ tasksOpen: false })}
      actions={
        <Button size="sm" variant="ghost" icon="list-x" disabled={!list.some((r) => r.status !== "running")} onClick={() => client.run.clearFinished().catch(actions.fail)}>
          {t("tasks.clear")}
        </Button>
      }
    >
      {list.length === 0 && <EmptyState layout="inline" message={t("tasks.empty")} />}
      {list.map((r) => (
        <TaskItem
          key={r.id}
          status={r.status}
          statusLabel={statusName[r.status]}
          title={`#${r.seq} ${r.title}`}
          subtitle={[tx(r.actionLabel), r.envName, time(r.startedAt)].filter(Boolean).join(" · ")}
          progress={r.progress?.fraction !== undefined ? r.progress.fraction * 100 : undefined}
          detail={
            r.status === "running"
              ? r.progress?.message
              : r.status === "error"
                ? (r.error ? runError(r.error) : undefined)
                : [r.summary?.rows !== undefined ? t("result.rows", { count: number(r.summary.rows) }) : r.summary?.message, r.summary?.durationMs !== undefined ? duration(r.summary.durationMs) : undefined].filter(Boolean).join(" · ")
          }
          onOpen={() => actions.open(`run:${r.id}`)}
          actions={r.status === "running" && r.cancellable ? <IconButton icon="square" size="sm" label={t("tasks.cancel")} onClick={() => client.run.cancel(r.id).catch(actions.fail)} /> : undefined}
        />
      ))}
    </FloatingPanel>
  );
}
