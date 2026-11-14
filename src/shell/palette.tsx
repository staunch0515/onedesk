/**
 * ⌘K command palette: resources (kernel.search), actions of the current resource, pages, new resource,
 * theme and density, plugin menu items. cmdk filters (and keeps the first match selected); kernel results carry
 * the query as a keyword so matches found in body text are not filtered out again.
 */
import { useEffect, useMemo, useState } from "react";
import { CommandPalette, Kbd, Stack, Text, useTheme, type CommandGroup, type CommandItem } from "../design";
import type { Resource } from "../plugin-api";
import { groupLabel } from "./format";
import { t } from "./i18n";
import { useShell } from "./shell-context";

export function ShellPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { kernel, route, navigate, openNewResource, runAction } = useShell();
  const { theme, density, setTheme, setDensity } = useTheme();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState<Resource | null>(null);

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  // Current resource (for its actions).
  const currentId = route.page === "resource" ? route.id : null;
  useEffect(() => {
    if (!open || !currentId) {
      setCurrent(null);
      return;
    }
    let live = true;
    void kernel.resources.get(currentId).then((r) => live && setCurrent(r));
    return () => {
      live = false;
    };
  }, [open, currentId, kernel]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      kernel.search(search, { limit: 8 }).then(
        (found) => {
          if (!live) return;
          setResults(found);
          setLoading(false);
        },
        () => live && setLoading(false),
      );
    }, 80);
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
    const resourceItems: CommandItem[] = results.map((r) => ({
      id: r.id,
      label: r.name,
      description: [kernel.registry.kind(r.kind)?.name ?? r.kind, groupLabel(r.group)].join(" · "),
      icon: kernel.registry.kind(r.kind)?.icon ?? "file",
      // Already matched by the kernel (body text too): the query itself as keyword keeps cmdk from hiding it.
      keywords: search.trim() ? [search.trim()] : undefined,
      onSelect: () => void navigate({ page: "resource", id: r.id }),
    }));
    if (search.trim()) {
      resourceItems.push({
        id: "search-all",
        label: t("palette.searchAll", { query: search.trim() }),
        icon: "search",
        keywords: [search.trim()],
        onSelect: () => void navigate({ page: "search", query: search.trim() }),
      });
    }
    const actionItems: CommandItem[] =
      current && kernel.registry.kind(current.kind)
        ? kernel.registry.actionsFor(current.kind).map((a) => ({
            id: a.key,
            label: a.label,
            description: current.name,
            icon: a.icon ?? "play",
            shortcut: a.isDefaultFor.includes(current.kind) ? ["⌘", "↵"] : undefined,
            onSelect: () => runAction(a.key, current),
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
      { id: "actions", heading: t("palette.actions"), items: actionItems },
      { id: "create", heading: t("palette.create"), items: create },
      { id: "pages", heading: t("palette.pages"), items: pages },
      { id: "plugins", heading: t("palette.pluginItems"), items: pluginItems },
      { id: "prefs", heading: t("palette.preferences"), items: prefs },
    ];
  }, [results, search, current, kernel, theme, density, navigate, openNewResource, runAction, setTheme, setDensity]);

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
      loading={loading && results.length === 0}
      loadingLabel={t("palette.loading")}
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
