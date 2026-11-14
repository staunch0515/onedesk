/**
 * Left menu: one entry per resource, grouped by `group`, collapsible, drag-sortable (pointer + keyboard).
 * Order and collapsed state live in kernel.prefs. Resources of disabled plugins are hidden here (D15).
 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useState } from "react";
import { DragHandle, DropdownMenu, EmptyState, ErrorState, IconButton, LoadingState, NavGroup, NavItem, Sidebar, Stack, Text } from "../design";
import type { Resource } from "../plugin-api";
import { errorInfo, groupLabel } from "./format";
import { useAsync, useKernelTick } from "./hooks";
import { t } from "./i18n";
import { buildMenu, MENU_PREFS_KEY, moveGroup, moveItem, normalizeMenuPrefs, setCollapsed, type MenuGroup, type MenuPrefs } from "./menu-model";
import { useShell, type Route } from "./shell-context";
import { useDeleteResource } from "./delete-resource";

let menuReadyLogged = false;

function SortableResourceItem({ resource, selected, onSelect }: { resource: Resource; selected: boolean; onSelect: () => void }) {
  const { kernel } = useShell();
  const deleteResource = useDeleteResource();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: resource.id });
  const [menuOpen, setMenuOpen] = useState(false);
  const kind = kernel.registry.kind(resource.kind);
  const invalid = Object.keys(kernel.resources.validate(resource.kind, resource.body)).length > 0;
  const style = { transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 1 : undefined };
  return (
    <NavItem
      ref={setNodeRef}
      style={style} // od-allow-inline-style: dnd-kit drag transform (D31)
      label={resource.name}
      icon={kind?.icon ?? "file"}
      selected={selected}
      disabled={invalid}
      warning={invalid ? t("nav.invalidBody") : undefined}
      onSelect={onSelect}
      dragHandle={<DragHandle ref={setActivatorNodeRef} label={t("nav.dragHandle")} {...attributes} {...listeners} />}
      actionsOpen={menuOpen}
      actions={
        <DropdownMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          align="start"
          trigger={<IconButton icon="ellipsis" label={t("nav.itemActions", { name: resource.name })} size="sm" />}
          items={[{ key: "delete", label: t("common.delete"), icon: "trash-2", danger: true, onSelect: () => void deleteResource(resource) }]}
        />
      }
    />
  );
}

function MenuGroupView({
  group,
  index,
  count,
  prefs,
  route,
  onPrefs,
  onMoveGroup,
  resourcesById,
}: {
  group: MenuGroup;
  index: number;
  count: number;
  prefs: MenuPrefs;
  route: Route;
  onPrefs: (next: MenuPrefs) => void;
  onMoveGroup: (delta: -1 | 1) => void;
  resourcesById: Map<string, Resource>;
}) {
  const { navigate, openNewResource } = useShell();
  const [menuOpen, setMenuOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const label = groupLabel(group.key);
  const nameOf = (id: string | number) => resourcesById.get(String(id))?.name ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("dnd.pickedUp", { name: nameOf(active.id) }),
    onDragOver: ({ over }) => (over ? t("dnd.over", { name: nameOf(over.id) }) : undefined),
    onDragEnd: ({ active }) => t("dnd.dropped", { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t("dnd.cancelled", { name: nameOf(active.id) }),
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) onPrefs(moveItem(prefs, group, String(e.active.id), String(e.over.id)));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t("dnd.instructions") } }}
    >
      <NavGroup
        label={label}
        open={!prefs.collapsed.includes(group.key)}
        onOpenChange={(open) => onPrefs(setCollapsed(prefs, group.key, !open))}
        actions={
          <Stack direction="row" gap="xs">
            <IconButton icon="plus" size="sm" label={t("nav.newInGroup", { group: label })} onClick={() => openNewResource({ group: group.key })} />
            <DropdownMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="end"
              trigger={<IconButton icon="ellipsis" size="sm" label={t("nav.groupActions", { group: label })} />}
              items={[
                { key: "up", label: t("nav.moveUp"), icon: "arrow-up", disabled: index === 0, onSelect: () => onMoveGroup(-1) },
                { key: "down", label: t("nav.moveDown"), icon: "arrow-down", disabled: index === count - 1, onSelect: () => onMoveGroup(1) },
              ]}
            />
          </Stack>
        }
      >
        <SortableContext items={group.items.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          {group.items.map((r) => (
            <SortableResourceItem
              key={r.id}
              resource={r}
              selected={route.page === "resource" && route.id === r.id}
              onSelect={() => void navigate({ page: "resource", id: r.id })}
            />
          ))}
        </SortableContext>
      </NavGroup>
    </DndContext>
  );
}

export function SidebarMenu() {
  const { kernel, route, navigate, openNewResource } = useShell();
  const tick = useKernelTick(kernel, ["resource.created", "resource.updated", "resource.deleted", "plugin.changed"]);
  const data = useAsync(async () => {
    const [resources, stored] = await Promise.all([kernel.resources.list(), kernel.prefs.get(MENU_PREFS_KEY)]);
    return { resources, prefs: normalizeMenuPrefs(stored) };
  }, [kernel, tick]);
  // Local copy so drag and collapse respond immediately; persisted in the background.
  const [localPrefs, setLocalPrefs] = useState<MenuPrefs | null>(null);
  const prefs = localPrefs ?? data.data?.prefs ?? null;
  const resources = data.data?.resources;
  const groups = useMemo(() => (resources && prefs ? buildMenu(resources, prefs) : []), [resources, prefs]);
  const resourcesById = useMemo(() => new Map((resources ?? []).map((r) => [r.id, r])), [resources]);

  const ready = data.status === "ready";
  useEffect(() => {
    if (ready && !menuReadyLogged) {
      menuReadyLogged = true;
      console.info(`[onedesk] menu-ready ${Math.round(performance.now())}`);
    }
  }, [ready]);

  const savePrefs = (next: MenuPrefs) => {
    setLocalPrefs(next);
    void kernel.prefs.set(MENU_PREFS_KEY, next);
  };

  const isPage = (page: Route["page"]) => route.page === page;
  const footer = (
    <NavGroup>
      <NavItem icon="layout-grid" label={t("nav.allResources")} selected={isPage("all")} onSelect={() => void navigate({ page: "all" })} />
      <NavItem icon="library" label={t("nav.collections")} selected={isPage("collections")} onSelect={() => void navigate({ page: "collections" })} />
      <NavItem icon="puzzle" label={t("nav.plugins")} selected={isPage("plugins")} onSelect={() => void navigate({ page: "plugins" })} />
      <NavItem icon="settings" label={t("nav.settings")} selected={isPage("settings")} onSelect={() => void navigate({ page: "settings" })} />
    </NavGroup>
  );

  let body;
  if (data.status === "error" && !data.data) {
    const info = errorInfo(data.error);
    body = (
      <ErrorState
        layout="inline"
        title={t("nav.loadFailed")}
        reason={info.message}
        resolution={info.hint}
        onRetry={data.reload}
        retryLabel={t("common.retry")}
      />
    );
  } else if (!resources || !prefs) {
    body = <LoadingState layout="inline" label={t("common.loading")} />;
  } else if (groups.length === 0) {
    body = <EmptyState layout="inline" message={t("nav.emptyMenu")} />;
  } else {
    body = groups.map((g, i) => (
      <MenuGroupView
        key={g.key || "__ungrouped"}
        group={g}
        index={i}
        count={groups.length}
        prefs={prefs}
        route={route}
        onPrefs={savePrefs}
        onMoveGroup={(delta) => savePrefs(moveGroup(prefs, groups, g.key, delta))}
        resourcesById={resourcesById}
      />
    ));
  }

  return (
    <Sidebar
      label={t("app.sidebarLabel")}
      headerJustify="between"
      header={
        <>
          <Text weight="semibold">{t("app.name")}</Text>
          <IconButton icon="plus" size="sm" label={t("new.title")} shortcut={["⌘", "N"]} onClick={() => openNewResource()} />
        </>
      }
      footer={footer}
    >
      {body}
    </Sidebar>
  );
}
