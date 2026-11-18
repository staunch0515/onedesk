import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startInstall } from "./install-dialogs";
import { Badge, Banner, ContextMenu, EmptyState, IconButton, Input, LoadingState, SidePanel, Tree, useToast, type MenuEntry, type TreeDropPosition, type TreeRow } from "../../design";
import { useI18n } from "../i18n";
import { loadBatch, loadLevel, loadMore, type Level, type MenuCommand, type TreeInfo, type TreeNode } from "../protocol";
import { useUi, useWorkbench } from "../state/context";

const ROOT = "";
/** Key prefix of the "more is being read" row at the end of a level that has more batches (never a real key). */
export const MORE_PREFIX = "\u0000more:";
const EMPTY: string[] = [];
/** "Expand all" and the filter read levels in full only up to this many nodes; the rest stays unread (the filter says so). */
const LOAD_ALL_CAP = 3000;
/** Finding the node of the active tab reads a level on up to this many nodes. */
const FOLLOW_CAP = 20000;

/** Children by parent key, per tree. Kept across activity switches so a tree does not flash empty. */
const cache = new Map<string, Map<string, Level>>();

/**
 * Rows that are not resources: the "more is being read" row, and a plugin's own nodes (`@<resource>/<key>`, and `!…` for a
 * failed read). They are not places to drop onto, cannot be dragged, and have no tree-wide menu.
 */
export function isSyntheticKey(key: string): boolean {
  return key.startsWith(MORE_PREFIX) || key.startsWith("@") || key.startsWith("!");
}

export function menuEntries(commands: MenuCommand[], tx: (l: MenuCommand["label"]) => string, run: (id: string) => void): MenuEntry[] {
  return commands.flatMap((c, i): MenuEntry[] => [
    ...(c.separatorBefore && i > 0 ? [{ type: "separator", key: `sep-${c.id}` } as MenuEntry] : []),
    { key: c.id, label: tx(c.label), icon: c.icon, danger: c.danger, disabled: c.disabled, shortcut: c.shortcut, onSelect: () => run(c.id) },
  ]);
}

export function TreePanel({ tree }: { tree: TreeInfo }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx, locale, error } = useI18n();
  const { toast } = useToast();
  const expanded = useUi((s) => s.expanded[tree.id] ?? EMPTY);
  const selected = useUi((s) => s.selected[tree.id] ?? null);
  const renaming = useUi((s) => (s.renaming?.tree === tree.id ? s.renaming.key : null));
  const activeNode = useUi((s) => {
    const node = s.tabs.find((x) => x.id === s.activeTabId)?.node;
    return node?.tree === tree.id ? node.key : null;
  });
  const activeEnv = useUi((s) => s.tabs.find((x) => x.id === s.activeTabId && x.usesEnv)?.envId ?? null);
  const [levels, setLevels] = useState<Map<string, Level>>(() => cache.get(tree.id) ?? new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ point: { x: number; y: number }; node: TreeNode | null } | null>(null);
  const nodesRef = useRef(levels);
  nodesRef.current = levels;
  const pending = useRef(new Set<string>());

  const commit = useCallback(
    (update: (map: Map<string, Level>) => void) => {
      const next = new Map(nodesRef.current);
      update(next);
      nodesRef.current = next;
      cache.set(tree.id, next);
      setLevels(next);
    },
    [tree.id],
  );

  const load = useCallback(
    async (parentKey: string) => {
      if (pending.current.has(parentKey)) return;
      pending.current.add(parentKey);
      setLoading((s) => new Set(s).add(parentKey));
      try {
        // Only the first batch: the rest is read when its end scrolls into view (D373).
        const level = await loadBatch(client, tree.id, parentKey === ROOT ? null : parentKey, undefined, locale);
        // (A longer read of the same level, made meanwhile while following the active tab, is kept.)
        commit((map) => {
          if (!map.has(parentKey)) map.set(parentKey, level);
        });
      } catch (error) {
        actions.fail(error);
      } finally {
        pending.current.delete(parentKey);
        setLoading((s) => {
          const next = new Set(s);
          next.delete(parentKey);
          return next;
        });
      }
    },
    [client, tree.id, commit, actions, locale],
  );

  // The next batch of a long level, asked for by the row at its end coming into view.
  const loadNext = useCallback(
    async (parentKey: string) => {
      const level = nodesRef.current.get(parentKey);
      if (!level || level.next === undefined || pending.current.has(MORE_PREFIX + parentKey)) return;
      pending.current.add(MORE_PREFIX + parentKey);
      try {
        const more = await loadMore(client, tree.id, parentKey === ROOT ? null : parentKey, level, locale);
        // A refresh may have replaced the level meanwhile; then this batch is stale and the new level is shown as is.
        if (nodesRef.current.get(parentKey) === level) commit((map) => map.set(parentKey, more));
      } catch (error) {
        actions.fail(error);
      } finally {
        pending.current.delete(MORE_PREFIX + parentKey);
      }
    },
    [client, tree.id, commit, actions, locale],
  );
  const needMore = useCallback((key: string) => void loadNext(key.slice(MORE_PREFIX.length)), [loadNext]);

  // Root and every expanded node that is on screen get their children.
  useEffect(() => {
    if (!levels.has(ROOT)) void load(ROOT);
    const known = new Set([...levels.values()].flatMap((l) => l.nodes).map((n) => n.key));
    for (const key of expanded) if (known.has(key) && !levels.has(key)) void load(key);
  }, [levels, expanded, load]);

  // The kernel says the tree changed: read every loaded level again.
  useEffect(() => {
    const refresh = () => {
      const keys = [...nodesRef.current.keys()];
      // Each level is read again as far as it had been read, so the scroll position and what is on screen stay.
      void Promise.all(keys.map((k) => loadLevel(client, tree.id, k === ROOT ? null : k, locale, nodesRef.current.get(k)?.nodes.length ?? 0).then((level) => [k, level] as const))).then((entries) => {
        commit((map) => {
          map.clear();
          for (const [k, level] of entries) map.set(k, level);
        });
      }, actions.fail);
    };
    // Shown again after another view: events were missed meanwhile, so read the cached levels again.
    if (nodesRef.current.size > 0) refresh();
    const offs = [client.events.subscribe(`tree:${tree.id}`, refresh), client.events.subscribe("connection", refresh)];
    return () => offs.forEach((off) => off());
    // `locale` is a dependency on purpose: after a language switch the loaded levels are read again in the new language.
  }, [client, tree.id, commit, actions, locale]);

  const index = useMemo(() => {
    const map = new Map<string, TreeNode>();
    for (const level of levels.values()) for (const n of level.nodes) map.set(n.key, n);
    return map;
  }, [levels]);

  // Follow the active tab (like VS Code): open the path to its node and highlight it.
  useEffect(() => {
    if (!activeNode) return;
    let cancelled = false;
    client.tree.path(tree.id, activeNode).then((path) => {
      if (cancelled) return;
      store.set((s) => {
        const open = s.expanded[tree.id] ?? [];
        const missing = path.slice(0, -1).filter((k) => !open.includes(k));
        if (missing.length === 0 && s.selected[tree.id] === activeNode) return {};
        return { expanded: missing.length > 0 ? { ...s.expanded, [tree.id]: [...open, ...missing] } : s.expanded, selected: { ...s.selected, [tree.id]: activeNode } };
      });
      // The node may sit in a later batch of its level: read on until it turns up (to the end of the level, at most FOLLOW_CAP nodes).
      void (async () => {
        for (let i = 0; i < path.length && !cancelled; i++) {
          const parent = i === 0 ? ROOT : path[i - 1]!;
          let level = nodesRef.current.get(parent) ?? (await loadBatch(client, tree.id, parent === ROOT ? null : parent, undefined, locale));
          while (!level.nodes.some((n) => n.key === path[i]) && level.next !== undefined && level.nodes.length < FOLLOW_CAP && !cancelled) {
            level = await loadMore(client, tree.id, parent === ROOT ? null : parent, level, locale);
          }
          const found = level;
          if (!cancelled && found.nodes.length > (nodesRef.current.get(parent)?.nodes.length ?? -1)) commit((map) => map.set(parent, found));
        }
      })().catch(() => undefined);
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeNode, client, store, tree.id, commit, locale]);

  const loadAll = useCallback(async () => {
    const queue = [ROOT];
    let count = 0;
    while (queue.length > 0 && count < LOAD_ALL_CAP) {
      const key = queue.shift()!;
      const parent = key === ROOT ? null : key;
      let level = nodesRef.current.get(key) ?? (await loadBatch(client, tree.id, parent, undefined, locale));
      // Read this level on while the cap allows; a level longer than that stays partly unread.
      while (level.next !== undefined && count + level.nodes.length < LOAD_ALL_CAP) level = await loadMore(client, tree.id, parent, level, locale);
      const loaded = level;
      commit((map) => map.set(key, loaded));
      count += loaded.nodes.length;
      for (const c of loaded.nodes) if (c.expandable) queue.push(c.key);
    }
  }, [client, tree.id, commit, locale]);

  const needle = filter.trim().toLowerCase();
  useEffect(() => {
    if (needle) loadAll().catch(actions.fail);
  }, [needle, loadAll, actions]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const open = new Set(expanded);
    const childrenOf = (key: string) => levels.get(key)?.nodes ?? [];
    // A plugin's tree may repeat a key or give a node the key of one of its ancestors: every key is drawn once and a node is never its own ancestor.
    const shown = new Set<string>();
    const matches = (n: TreeNode, trail: ReadonlySet<string>): boolean => {
      if (trail.has(n.key)) return false;
      if (n.label.toLowerCase().includes(needle)) return true;
      const inner = new Set(trail).add(n.key);
      return childrenOf(n.key).some((c) => matches(c, inner));
    };
    const walk = (parentKey: string, depth: number, trail: ReadonlySet<string>) => {
      for (const n of childrenOf(parentKey)) {
        if (trail.has(n.key) || shown.has(n.key)) continue;
        const inner = new Set(trail).add(n.key);
        if (needle && !matches(n, trail)) continue;
        shown.add(n.key);
        const isOpen = n.expandable && (needle ? childrenOf(n.key).some((c) => matches(c, inner)) : open.has(n.key));
        out.push({
          key: n.key,
          label: n.label || (n.state === "load-failed" || n.state === "broken" ? t("tree.loadFailed") : n.label),
          icon: n.icon === "folder" && isOpen ? "folder-open" : n.icon,
          depth,
          expandable: n.expandable,
          expanded: isOpen,
          loading: loading.has(n.key),
          state: n.state,
          stateLabel: n.stateReason ? (n.state === "load-failed" && typeof n.stateReason === "string" ? error({ code: n.stateReason, params: {} }) : tx(n.stateReason)) : undefined,
          badge: n.badge,
          marked: tree.id === "environments" && n.key === activeEnv,
          draggable: n.draggable && !needle,
        });
        if (isOpen) walk(n.key, depth + 1, inner);
      }
      // A level with more batches ends in a row that asks for the next one when it comes into view.
      if (!needle && levels.get(parentKey)?.next !== undefined) {
        out.push({ key: MORE_PREFIX + parentKey, label: t("tree.loadingMore"), icon: "ellipsis", depth, expandable: false, more: true });
      }
    };
    walk(ROOT, 0, new Set([ROOT]));
    return out;
  }, [levels, expanded, needle, loading, tx, t, tree.id, activeEnv]);
  /** The filter only looks at what has been read; a level too long to read in full says so. */
  const partial = needle !== "" && [...levels.values()].some((l) => l.next !== undefined);

  const toggle = (key: string) => {
    if (needle) return;
    actions.setExpanded(tree.id, expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key]);
  };

  const activate = (key: string) => {
    const node = index.get(key);
    if (!node) return;
    store.set((s) => ({ selected: { ...s.selected, [tree.id]: key } }));
    if (node.target) actions.open(node.target);
    else if (node.expandable) toggle(key);
  };

  const canDrop = (dragKey: string, targetKey: string | null, position: TreeDropPosition) => {
    if (tree.source !== "stored") return false;
    if (isSyntheticKey(dragKey) || (targetKey !== null && isSyntheticKey(targetKey))) return false;
    const drag = index.get(dragKey);
    const target = targetKey ? index.get(targetKey) : null;
    if (!drag || (targetKey && !target)) return false;
    const container = position === "inside" ? target : target?.parentKey ? index.get(target.parentKey) : null;
    if (!container) return true; // top level of a stored tree
    for (let p: TreeNode | undefined = container; p; p = p.parentKey ? index.get(p.parentKey) : undefined) if (p.key === dragKey) return false;
    // A `dropAny` node (D390) takes any resource node dropped onto it; its plugin decides what that means.
    if (position === "inside" && container.dropAny) return true;
    return container.accepts.includes("*") || container.accepts.includes(drag.kind);
  };

  const drop = (dragKey: string, targetKey: string | null, position: TreeDropPosition) => {
    client.tree.move(tree.id, dragKey, targetKey, position, locale).then((out) => {
      // The plugin took the drop itself (a reference was added, nothing moved): show what it said.
      if (out && out.message !== undefined) toast({ tone: "success", title: tx(out.message) });
      if (position === "inside" && targetKey && !expanded.includes(targetKey)) actions.setExpanded(tree.id, [...expanded, targetKey]);
    }, actions.fail);
  };

  const expandAll = () => {
    loadAll().then(() => {
      actions.setExpanded(tree.id, [...nodesRef.current.values()].flatMap((l) => l.nodes).filter((n) => n.expandable).map((n) => n.key));
    }, actions.fail);
  };

  const commands = menu ? (menu.node ? menu.node.menu : tree.menu) : [];
  const title = tx(tree.title);
  const demo = client.demo?.tree(tree.id) ?? false;
  const rootLoading = !levels.has(ROOT);

  return (
    <SidePanel
      label={title}
      title={
        <>
          {title}
          {demo && (
            <Badge tone="warning" icon="flask-conical">
              {t("demo.badge")}
            </Badge>
          )}
        </>
      }
      actions={
        <>
          {tree.groups && !tree.toolbar.some((c) => c.id === "node.newGroup") && (
            <IconButton icon="folder-plus" size="sm" label={t("tree.newGroup")} disabled={!tree.groups} onClick={() => void actions.command("node.newGroup", { tree: tree.id, nodeKey: selected })} />
          )}
          {tree.id === "plugins" && client.app && (
            <IconButton icon="package-plus" size="sm" label={t("install.action")} onClick={() => void startInstall(client, store, actions)} />
          )}
          {tree.toolbar.map((c) => (
            <IconButton key={c.id} icon={c.icon ?? "circle"} size="sm" label={tx(c.label)} disabled={c.disabled} onClick={() => void actions.command(c.id, { tree: tree.id, nodeKey: selected })} />
          ))}
          <IconButton icon="chevrons-up-down" size="sm" label={t("tree.expandAll")} onClick={expandAll} />
          <IconButton icon="chevrons-down-up" size="sm" label={t("tree.collapseAll")} onClick={() => actions.setExpanded(tree.id, [])} />
        </>
      }
      filter={<Input size="sm" icon="list-filter" placeholder={t("tree.filter")} aria-label={t("tree.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setFilter("")} />}
    >
      {rootLoading ? (
        <LoadingState layout="inline" label={t("common.loading")} />
      ) : (
        <>
        {partial && (
          <Banner tone="info">
            {t("tree.filterPartial")}
          </Banner>
        )}
        <Tree
          rows={rows}
          onNeedMore={needMore}
          label={title}
          selectedKey={selected}
          onActivate={activate}
          onToggle={toggle}
          onContextMenu={(key, point) => {
            if (key?.startsWith(MORE_PREFIX)) return; // the "reading more" row has no menu, not even the tree's
            if (key) store.set((s) => ({ selected: { ...s.selected, [tree.id]: key } }));
            setMenu({ point, node: key ? (index.get(key) ?? null) : null });
          }}
          canDrop={canDrop}
          onDrop={drop}
          dropDeniedLabel={t("tree.cannotDrop")}
          highlight={needle || undefined}
          editingKey={renaming}
          renameLabel={t("tree.rename")}
          onRenameCommit={(key, name) => {
            if (store.get().renaming?.key !== key) return;
            store.set({ renaming: null });
            const node = index.get(key);
            if (name && node && name !== node.label) client.tree.rename(tree.id, key, name).catch(actions.fail);
          }}
          onRenameCancel={() => store.set({ renaming: null })}
          empty={<EmptyState layout="inline" message={needle ? t("tree.noMatch", { query: filter.trim() }) : t("tree.empty")} />}
        />
        </>
      )}
      <ContextMenu
        point={menu?.point ?? null}
        onClose={() => setMenu(null)}
        items={menuEntries(commands, tx, (id) => void actions.command(id, { tree: tree.id, nodeKey: menu?.node?.key ?? null, target: menu?.node?.target }))}
      />
    </SidePanel>
  );
}
