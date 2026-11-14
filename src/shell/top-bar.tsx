import { useEffect, useState } from "react";
import { Button, Input, Kbd, Stack, Text, TopBar, Tooltip } from "../design";
import { t } from "./i18n";
import { useShell } from "./shell-context";

/** Global search (Enter → results page), New, and the command palette entry. */
export function ShellTopBar() {
  const { kernel, route, navigate, openNewResource, openPalette } = useShell();
  const routeQuery = route.page === "search" ? route.query : "";
  const [query, setQuery] = useState(routeQuery);
  useEffect(() => setQuery(routeQuery), [routeQuery]);

  return (
    <TopBar
      start={
        <Text tone="muted" size="sm" truncate>
          {kernel.context.workspace.name}
        </Text>
      }
      center={
        <Input
          type="text"
          role="searchbox"
          icon="search"
          aria-label={t("topbar.searchLabel")}
          placeholder={t("topbar.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void navigate({ page: "search", query: query.trim() });
            } else if (e.key === "Escape" && query) {
              e.preventDefault();
              setQuery("");
            }
          }}
        />
      }
      end={
        <Stack direction="row" gap="sm" align="center">
          <Tooltip content={t("topbar.paletteLabel")} shortcut={["⌘", "K"]} side="bottom">
            <Button variant="ghost" onClick={openPalette} aria-label={t("topbar.paletteLabel")}>
              {t("topbar.palette")}
              <Kbd keys={["⌘", "K"]} />
            </Button>
          </Tooltip>
          <Tooltip content={t("new.title")} shortcut={["⌘", "N"]} side="bottom">
            <Button variant="primary" icon="plus" onClick={() => openNewResource()}>
              {t("topbar.new")}
            </Button>
          </Tooltip>
        </Stack>
      }
    />
  );
}
