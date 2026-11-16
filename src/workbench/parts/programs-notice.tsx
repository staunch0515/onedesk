import { Badge, Banner, Pane, Text } from "../../design";
import { useI18n } from "../i18n";

/** One program a plugin asks to run (`PluginPermission.detail` of `programs`: names, comma separated, bundled ones marked `(plugin)`). */
export function parsePrograms(detail: string | undefined): Array<{ name: string; bundled: boolean }> {
  return (detail ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.endsWith("(plugin)") ? { name: s.slice(0, -"(plugin)".length).trim(), bundled: true } : { name: s, bundled: false }));
}

/**
 * The separate paragraph for the `programs` permission (D331): programs run with everything the user can reach on this
 * computer, so they get a warning of their own and are listed by name (D332).
 */
export function ProgramsNotice({ detail }: { detail: string | undefined }) {
  const { t } = useI18n();
  const programs = parsePrograms(detail);
  return (
    <Banner tone="warning" title={t("programs.warning")}>
      <Pane direction="row" gap="xs" wrap align="center">
        {programs.map((x) => (
          <Pane key={x.name} direction="row" gap="xs" align="center">
            <Text size="sm" mono>{x.name}</Text>
            {x.bundled && <Badge>{t("programs.bundled")}</Badge>}
          </Pane>
        ))}
      </Pane>
    </Banner>
  );
}
