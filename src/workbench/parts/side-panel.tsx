import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, ContextMenu, EmptyState, IconButton, Input, LoadingState, SidePanel, Tree, type MenuEntry, type TreeDropPosition, type TreeRow } from "../../design";
import { useI18n } from "../i18n";
import { loadChildren, type MenuCommand, type TreeInfo, type TreeNode } from "../protocol";
import { useUi, useWorkbench } from "../state/context";

const ROOT = "";
const EMPTY: string[] = [];
/** Safety cap for "expand all" on provided trees with many nodes. */
const LOAD_ALL_CAP = 3000;

/** Children by parent key, per tree. Kept across activity switches so a tree does not flash empty. */
const cache = new Map<string, Map<string, TreeNode[]>>();

export function menuEntries(commands: MenuCommand[], tx: (l: MenuCommand["label"]) => string, run: (id: string) => void): MenuEntry[] {
  return commands.flatMap((c, i): MenuEntry[] => [
    ...(c.separatorBefore && i > 0 ? [{ type: "separator", key: `sep-${c.id}` } as MenuEntry] : []),
    { key: c.id, label: tx(c.label), icon: c.icon, danger: c.danger, disabled: c.disabled, shortcut: c.shortcut, onSelect: () => run(c.id) },
  ]);
}

export function TreePanel({ tree }: { tree: TreeInfo }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx } = useI18n();
  const expanded = useUi((s) => s.expanded[tree.id] ?? EMPTY);
  const selected = useUi((s) => s.selected[tree.id] ?? null);
  const renaming = useUi((s) => (s.renaming?.tree === tree.id ? s.renaming.key : null));
  const activeNode = useUi((s) => {
    const node = s.tabs.find((x) => x.id === s.activeTabId)?.node;
    return node?.tree === tree.id ? node.key : null;
  });
  const activeEnv = useUi((s) => s.tabs.find((x) => x.id === s.activeTabId && x.usesEnv)?.envId ?? null);
  const [nodes, setNodes] = useState<Map<string, TreeNode[]>>(() => cache.get(tree.id) ?? new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ point: { x: number; y: number }; node: TreeNode | null } | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const pending = useRef(new Set<string>());

  const commit = useCallback(
    (update: (map: Map<string, TreeNode[]>) => void) => {
      const next = new Map(nodesRef.current);
      update(next);
      nodesRef.current = next;
      cache.set(tree.id, next);
      setNodes(next);
    },
    [tree.id],
  );

  const load = useCallback(
    async (parentKey: string) => {
      if (pending.current.has(parentKey)) return;
      pending.current.add(parentKey);
      setLoading((s) => new Set(s).add(parentKey));
      try {
        const children = await loadChildren(client, tree.id, parentKey === ROOT ? null : parentKey);
        commit((map) => map.set(parentKey, children));
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
    [client, tree.id, commit, actions],
  );

  // Root and every expanded node that is on screen get their children.
  useEffect(() => {
    if (!nodes.has(ROOT)) void load(ROOT);
    const known = new Set([...nodes.values()].flat().map((n) => n.key));
    for (const key of expanded) if (known.has(key) && !nodes.has(key)) void load(key);
  }, [nodes, expanded, load]);

  // The kernel says the tree changed: read every loaded level again.
  useEffect(() => {
    const refresh = () => {
      const keys = [...nodesRef.current.keys()];
      void Promise.all(keys.map((k) => loadChildren(client, tree.id, k === ROOT ? null : k).then((children) => [k, children] as const))).then((entries) => {
        commit((map) => {
          map.clear();
          for (const [k, children] of entries) map.set(k, children);
        });
      }, actions.fail);
    };
    // Shown again after another view: events were missed meanwhile, so read the cached levels again.
    if (nodesRef.current.size > 0) refresh();
    const offs = [client.events.subscribe(`tree:${tree.id}`, refresh), client.events.subscribe("connection", refresh)];
    return () => offs.forEach((off) => off());
  }, [client, tree.id, commit, actions]);

  const index = useMemo(() => {
    const map = new Map<string, TreeNode>();
    for (const list of nodes.values()) for (const n of list) map.set(n.key, n);
    return map;
  }, [nodes]);

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
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeNode, client, store, tree.id]);

  const loadAll = useCallback(async () => {
    const queue = [ROOT];
    let count = 0;
    while (queue.length > 0 && count < LOAD_ALL_CAP) {
      const key = queue.shift()!;
      let children = nodesRef.current.get(key);
      if (!children) {
        children = await loadChildren(client, tree.id, key === ROOT ? null : key);
        const loaded = children;
        commit((map) => map.set(key, loaded));
      }
      count += children.length;
      for (const c of children) if (c.expandable) queue.push(c.key);
    }
  }, [client, tree.id, commit]);

  const needle = filter.trim().toLowerCase();
  useEffect(() => {
    if (needle) loadAll().catch(actions.fail);
  }, [needle, loadAll, actions]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const open = new Set(expanded);
    const matches = (n: TreeNode): boolean => n.label.toLowerCase().includes(needle) || (nodes.get(n.key) ?? []).some(matches);
    const walk = (parentKey: string, depth: number) => {
      for (const n of nodes.get(parentKey) ?? []) {
        if (needle && !matches(n)) continue;
        const isOpen = n.expandable && (needle ? (nodes.get(n.key) ?? []).some(matches) : open.has(n.key));
        out.push({
          key: n.key,
          label: n.label,
          icon: n.icon === "folder" && isOpen ? "folder-open" : n.icon,
          depth,
          expandable: n.expandable,
          expanded: isOpen,
          loading: loading.has(n.key),
          state: n.state,
          stateLabel: n.stateReason ? tx(n.stateReason) : undefined,
          badge: n.badge,
          marked: tree.id === "environments" && n.key === activeEnv,
          draggable: n.draggable && !needle,
        });
        if (isOpen) walk(n.key, depth + 1);
      }
    };
    walk(ROOT, 0);
    return out;
  }, [nodes, expanded, needle, loading, tx, tree.id, activeEnv]);

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
    const drag = index.get(dragKey);
    const target = targetKey ? index.get(targetKey) : null;
    if (!drag || (targetKey && !target)) return false;
    const container = position === "inside" ? target : target?.parentKey ? index.get(target.parentKey) : null;
    if (!container) return true; // top level of a stored tree
    if (!container.accepts.includes("*") && !container.accepts.includes(drag.kind)) return false;
    for (let p: TreeNode | undefined = container; p; p = p.parentKey ? index.get(p.parentKey) : undefined) if (p.key === dragKey) return false;
    return true;
  };

  const drop = (dragKey: string, targetKey: string | null, position: TreeDropPosition) => {
    client.tree.move(tree.id, dragKey, targetKey, position).then(() => {
      if (position === "inside" && targetKey && !expanded.includes(targetKey)) actions.setExpanded(tree.id, [...expanded, targetKey]);
    }, actions.fail);
  };

  const expandAll = () => {
    loadAll().then(() => {
      actions.setExpanded(tree.id, [...nodesRef.current.values()].flat().filter((n) => n.expandable).map((n) => n.key));
    }, actions.fail);
  };

  const commands = menu ? (menu.node ? menu.node.menu : tree.menu) : [];
  const title = tx(tree.title);
  const demo = client.demo?.tree(tree.id) ?? false;
  const rootLoading = !nodes.has(ROOT);

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
          {!tree.toolbar.some((c) => c.id === "node.newGroup") && (
            <IconButton icon="folder-plus" size="sm" label={t("tree.newGroup")} disabled={!tree.groups} onClick={() => void actions.command("node.newGroup", { tree: tree.id, nodeKey: selected })} />
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
        <Tree
          rows={rows}
          label={title}
          selectedKey={selected}
          onActivate={activate}
          onToggle={toggle}
          onContextMenu={(key, point) => {
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
      )}
      <ContextMenu
        point={menu?.point ?? null}
        onClose={() => setMenu(null)}
        items={menuEntries(commands, tx, (id) => void actions.command(id, { tree: tree.id, nodeKey: menu?.node?.key ?? null }))}
      />
    </SidePanel>
  );
}
