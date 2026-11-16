import { Banner, Pane, Text } from "../../design";
import { useI18n } from "../i18n";

/** `PluginPermission.detail` of `pages` (round 8): `<plugin id>:<page>` entries, comma separated. */
export function parsePages(detail: string | undefined): string[] {
  return (detail ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The note for the `pages` permission: a type that uses another plugin's page lets that plugin's code read this
 * kind of content, so the pages are listed by name (D357).
 */
export function PagesNotice({ detail }: { detail: string | undefined }) {
  const { t } = useI18n();
  return (
    <Banner tone="warning" title={t("pages.warning")}>
      <Pane gap="xs">
        {parsePages(detail).map((name) => (
          <Text key={name} size="sm" mono>{name}</Text>
        ))}
      </Pane>
    </Banner>
  );
}
