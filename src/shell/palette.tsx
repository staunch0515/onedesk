/**
 * ⌘K command palette: resources (kernel.search), actions of the current resource, pages, new resource,
 * theme and density, plugin menu items. cmdk filters (and keeps the first match selected). Kernel results carry the
 * query that found them as a keyword, and that query is part of their item id: cmdk reads keywords only when an item
 * mounts, so each new result set mounts fresh items and matches found in body text or tags are not filtered out.
 */
import { useEffect, useMemo, useState } from "react";
import { CommandPalette, Kbd, Stack, Text, useTheme, type CommandGroup, type CommandItem } from "../design";
import type { Resource } from "../plugin-api";
import { groupLabel } from "./format";
import { useKernelTick } from "./hooks";
import { t } from "./i18n";
import { useShell } from "./shell-context";

export function ShellPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { kernel, route, navigate, openNewResource, runAction } = useShell();
  const { theme, density, setTheme, setDensity } = useTheme();
  const runTick = useKernelTick(kernel, ["action.started", "action.completed"]);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<{ query: string; results: Resource[] }>({ query: "", results: [] });
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState<Resource | null>(null);

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  // Current resource (for its actions). Loaded before the palette opens, so the first item cmdk selects is stable.
  const currentId = route.page === "resource" ? route.id : null;
  useEffect(() => {
    if (!currentId) {
      setCurrent(null);
      return;
    }
    let live = true;
    void kernel.resources.get(currentId).then((r) => live && setCurrent(r));
    return () => {
      live = false;
    };
  }, [open, currentId, kernel]);

  // Kernel search as the user types; the empty query (recent resources) is preloaded while closed.
  useEffect(() => {
    if (!open && search !== "") return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      kernel.search(search, { limit: 8 }).then(
        (results) => {
          if (!live) return;
          setFound({ query: search.trim(), results });
          setLoading(false);
        },
        () => live && setLoading(false),
      );
    }, search ? 80 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, search, kernel]);

  const groups = useMemo<CommandGroup[]>(() => {
    const go = (page: string, icon: string, target: Parameters<typeof navigate>[0]): CommandItem => ({
      id: `page:${page}`,
      label: t("palette.goto", { page }),
      icon,
      onSelect: () => void navigate(target),
    });
    const resourceItems: CommandItem[] = found.results.map((r) => ({
      id: `${r.id}@${found.query}`,
      label: r.name,
      description: [kernel.registry.kind(r.kind)?.name ?? r.kind, groupLabel(r.group)].join(" · "),
      icon: kernel.registry.kind(r.kind)?.icon ?? "file",
      keywords: found.query ? [found.query] : undefined,
      onSelect: () => void navigate({ page: "resource", id: r.id }),
    }));
    // Mounted together with the results it belongs to; listed after them (lower score), so a found resource is
    // what Enter opens.
    const searchAll: CommandItem[] = found.query
      ? [
          {
            id: `search-all@${found.query}`,
            label: t("palette.searchAll", { query: found.query }),
            icon: "search",
            onSelect: () => void navigate({ page: "search", query: found.query }),
          },
        ]
      : [];
    // A resource runs one action at a time (as on the resource page): while one runs, its actions are disabled.
    const busy = current ? kernel.actions.running().some((r) => r.resourceId === current.id) : false;
    const actionItems: CommandItem[] =
      current && kernel.registry.kind(current.kind)
        ? kernel.registry.actionsFor(current.kind).map((a) => ({
            id: a.key,
            label: a.label,
            description: busy ? t("action.runningElsewhere") : current.name,
            icon: a.icon ?? "play",
            disabled: busy,
            shortcut: a.isDefaultFor.includes(current.kind) ? ["⌘", "↵"] : undefined,
            onSelect: () => {
              if (!kernel.actions.running().some((r) => r.resourceId === current.id)) runAction(a.key, current);
            },
          }))
        : [];
    const pages: CommandItem[] = [
      go(t("nav.allResources"), "layout-grid", { page: "all" }),
      go(t("nav.collections"), "library", { page: "collections" }),
      go(t("nav.plugins"), "puzzle", { page: "plugins" }),
      go(t("nav.settings"), "settings", { page: "settings" }),
    ];
    const create: CommandItem[] = [
      { id: "new", label: t("new.title"), icon: "plus", shortcut: ["⌘", "N"], onSelect: () => openNewResource() },
      ...kernel.registry.kinds().map((k) => ({
        id: `new:${k.id}`,
        label: t("palette.createKind", { kind: k.name }),
        icon: k.icon ?? "plus",
        onSelect: () => openNewResource({ kind: k.id }),
      })),
    ];
    const themes: Array<[typeof theme, string, string]> = [
      ["light", t("settings.theme.light"), "sun"],
      ["dark", t("settings.theme.dark"), "moon"],
    ];
    const prefs: CommandItem[] = [
      ...themes
        .filter(([value]) => value !== theme)
        .map(([value, label, icon]) => ({ id: `theme:${value}`, label: t("palette.themeTo", { theme: label }), icon, onSelect: () => setTheme(value) })),
      ...(theme !== "system" ? [{ id: "theme:system", label: t("palette.themeSystem"), icon: "monitor", onSelect: () => setTheme("system") }] : []),
      density === "compact"
        ? { id: "density:comfortable", label: t("palette.densityTo", { density: t("settings.density.comfortable") }), icon: "rows-3", onSelect: () => setDensity("comfortable") }
        : { id: "density:compact", label: t("palette.densityTo", { density: t("settings.density.compact") }), icon: "rows-4", onSelect: () => setDensity("compact") },
    ];
    const pluginItems: CommandItem[] = kernel.registry.menuItems().map((m) => ({
      id: `menu:${m.pluginId}/${m.id}`,
      label: m.label,
      icon: m.icon ?? "puzzle",
      onSelect: () => runAction(m.actionKey),
    }));
    return [
      { id: "resources", heading: t("palette.resources"), items: resourceItems },
      { id: "search", heading: t("palette.searchGroup"), items: searchAll },
      { id: "actions", heading: t("palette.actions"), items: actionItems },
      { id: "create", heading: t("palette.create"), items: create },
      { id: "pages", heading: t("palette.pages"), items: pages },
      { id: "plugins", heading: t("palette.pluginItems"), items: pluginItems },
      { id: "prefs", heading: t("palette.preferences"), items: prefs },
    ];
  }, [found, search, current, runTick, kernel, theme, density, navigate, openNewResource, runAction, setTheme, setDensity]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      label={t("palette.label")}
      placeholder={t("palette.placeholder")}
      emptyText={t("palette.empty")}
      search={search}
      onSearchChange={setSearch}
      loading={loading && found.results.length === 0}
      loadingLabel={t("palette.loading")}
      listLabel={t("palette.listLabel")}
      footer={
        <Stack direction="row" gap="md" align="center">
          <Stack direction="row" gap="xs" align="center">
            <Kbd keys={["↑", "↓"]} />
            <Text size="xs" tone="muted">
              {t("palette.hintMove")}
            </Text>
          </Stack>
          <Stack direction="row" gap="xs" align="center">
            <Kbd keys={["↵"]} />
            <Text size="xs" tone="muted">
              {t("palette.hintRun")}
            </Text>
          </Stack>
          <Stack direction="row" gap="xs" align="center">
            <Kbd keys={["Esc"]} />
            <Text size="xs" tone="muted">
              {t("palette.hintClose")}
            </Text>
          </Stack>
        </Stack>
      }
    />
  );
}
