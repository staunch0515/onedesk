import { Button, EmptyState, FloatingPanel, Icon, Pane, Text, type ToastTone } from "../../design";
import { useI18n } from "../i18n";
import { useUi, useWorkbench } from "../state/context";

const TONE_ICON: Record<ToastTone, string> = { neutral: "info", info: "info", success: "circle-check", warning: "triangle-alert", danger: "circle-alert" };
const TONE_TEXT: Record<ToastTone, "default" | "info" | "success" | "warning" | "danger"> = { neutral: "default", info: "info", success: "success", warning: "warning", danger: "danger" };

/** The notices of this session (D376): time, level and text of each toast shown, newest first; can be cleared; never stored. */
export function NoticePanel() {
  const { store } = useWorkbench();
  const { t, time } = useI18n();
  const notices = useUi((s) => s.notices);
  const level: Record<ToastTone, string> = { neutral: t("notices.neutral"), info: t("notices.info"), success: t("notices.success"), warning: t("notices.warning"), danger: t("notices.danger") };
  return (
    <FloatingPanel
      label={t("notices.title")}
      title={t("notices.title")}
      closeLabel={t("common.close")}
      onClose={() => store.set({ noticesOpen: false })}
      actions={
        <Button size="sm" variant="ghost" icon="list-x" disabled={notices.length === 0} onClick={() => store.set({ notices: [] })}>
          {t("notices.clear")}
        </Button>
      }
    >
      {notices.length === 0 && <EmptyState layout="inline" message={t("notices.empty")} />}
      {notices.map((n) => (
        <Pane key={n.id} direction="row" gap="sm" pad="sm" align="start">
          <Icon name={TONE_ICON[n.tone]} size="md" label={level[n.tone]} />
          <Pane grow>
            <Text tone={TONE_TEXT[n.tone]}>{n.text}</Text>
            {n.detail && (
              <Text size="sm" tone="muted">
                {n.detail}
              </Text>
            )}
          </Pane>
          <Text size="xs" tone="subtle" tabular>
            {time(n.at)}
          </Text>
        </Pane>
      ))}
    </FloatingPanel>
  );
}
