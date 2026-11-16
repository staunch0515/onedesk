import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { DragGhost } from "./drag-ghost";
import { Icon } from "./icon";
import { beginPointerDrag, setDragCursor } from "./pointer-drag";
import { Spinner } from "./spinner";
import { useVirtualWindow } from "./virtual";
import "./tree.css";

export type TreeNodeState = "ok" | "disabled" | "missing-plugin" | "broken" | "conflict";
export type TreeDropPosition = "before" | "inside" | "after";

export interface TreeRow {
  key: string;
  label: string;
  icon: string;
  /** 0 for nodes directly under the root. */
  depth: number;
  expandable: boolean;
  expanded?: boolean;
  loading?: boolean;
  state?: TreeNodeState;
  /** Tooltip / accessible text for a non-normal state, e.g. "Plugin not installed". */
  stateLabel?: string;
  /** Short text at the right end (count, version). */
  badge?: string;
  /** Marks the node as "in use" (e.g. the environment of the active tab). */
  marked?: boolean;
  draggable?: boolean;
  /** A placeholder at the end of a level that has more batches: when it comes into view the owner is asked for the next batch. Not selectable. */
  more?: boolean;
}

export interface TreeProps {
  rows: TreeRow[];
  /** Accessible name of the tree. */
  label: string;
  selectedKey?: string | null;
  /** Click or Enter on a row. */
  onActivate: (key: string) => void;
  onToggle: (key: string) => void;
  /** A `more` row came (near) into view: read the next batch of that level. */
  onNeedMore?: (key: string) => void;
  onContextMenu?: (key: string | null, point: { x: number; y: number }) => void;
  /** Whether `dragKey` may be dropped at this place. `targetKey` null = the empty area (root). */
  canDrop?: (dragKey: string, targetKey: string | null, position: TreeDropPosition) => boolean;
  onDrop?: (dragKey: string, targetKey: string | null, position: TreeDropPosition) => void;
  /** Text of the uniform "cannot drop here" hint. */
  dropDeniedLabel?: string;
  /** Substring to highlight in labels (tree filter). */
  highlight?: string;
  /** Key of the row being renamed inline. */
  editingKey?: string | null;
  onRenameCommit?: (key: string, name: string) => void;
  onRenameCancel?: () => void;
  renameLabel?: string;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  className?: string;
}

const STATE_ICON: Partial<Record<TreeNodeState, string>> = {
  "missing-plugin": "puzzle",
  broken: "unlink",
  conflict: "git-merge",
  disabled: "circle-slash",
};

const EXPAND_ON_HOVER_MS = 700;
const DRAG_THRESHOLD = 5;

interface DragState {
  key: string;
  label: string;
  icon: string;
  x: number;
  y: number;
  target: string | null;
  position: TreeDropPosition;
  ok: boolean;
  /** Pointer is over this tree (rows or empty area). */
  inside: boolean;
}

function Highlighted({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="od-tree__mark">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/**
 * Generic tree (I.3): unlimited nesting, fixed row height, hover changes only the row background.
 * The owner passes the visible rows already flattened; this component draws them and reports
 * clicks, toggles, context menus and drops. Dragging is pointer-based with one shared ghost and a
 * uniform "cannot drop here" state.
 */
export function Tree({
  rows,
  label,
  selectedKey,
  onActivate,
  onToggle,
  onNeedMore,
  onContextMenu,
  canDrop,
  onDrop,
  dropDeniedLabel,
  highlight,
  editingKey,
  onRenameCommit,
  onRenameCancel,
  renameLabel,
  empty,
  className,
}: TreeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
  const hoverTimer = useRef<{ key: string; id: number } | null>(null);
  const latest = useRef({ rows, canDrop, onDrop, onToggle });
  latest.current = { rows, canDrop, onDrop, onToggle };
  // Only the rows in (and just around) the viewport exist in the page; the rest is empty space of the same height (D373).
  const win = useVirtualWindow(rootRef, { count: rows.length, rowHeightVar: "--tree-row-height" });
  const reveal = win.reveal;
  const visible = rows.slice(win.start, win.end);

  // The row that comes into view at the end of a level asks for the next batch.
  const needMore = visible.find((r) => r.more)?.key;
  useEffect(() => {
    if (needMore) onNeedMore?.(needMore);
  }, [needMore, onNeedMore]);

  // A selection made elsewhere (following the active tab, "reveal in tree") is scrolled into view, drawn or not.
  const selectedIndex = selectedKey ? rows.findIndex((r) => r.key === selectedKey) : -1;
  const selectedRow = selectedKey ?? null;
  useEffect(() => {
    if (selectedRow && selectedIndex >= 0) reveal(selectedIndex);
    // Only when the selection (or where it sits) changes, not on every scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow, selectedIndex]);

  const clearHoverTimer = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current.id);
    hoverTimer.current = null;
  };
  useEffect(() => clearHoverTimer, []);

  const startDrag = (e: ReactPointerEvent, row: TreeRow) => {
    if (e.button !== 0 || !row.draggable || !onDrop || editingKey === row.key) return;
    const locate = (ev: PointerEvent): Pick<DragState, "target" | "position" | "inside"> => {
      const root = rootRef.current;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!root || !el || !root.contains(el)) return { target: null, position: "inside", inside: false };
      const rowEl = el.closest<HTMLElement>("[data-tree-key]");
      if (!rowEl) return { target: null, position: "inside", inside: true };
      const key = rowEl.dataset.treeKey!;
      const target = latest.current.rows.find((r) => r.key === key);
      const rect = rowEl.getBoundingClientRect();
      const ratio = (ev.clientY - rect.top) / Math.max(1, rect.height);
      const edge = target?.expandable ? 0.25 : 0.5;
      const position: TreeDropPosition = ratio < edge ? "before" : ratio >= 1 - edge ? "after" : "inside";
      return { target: key, position, inside: true };
    };
    beginPointerDrag(e, {
      threshold: DRAG_THRESHOLD,
      onStart: () => {
        suppressClick.current = true;
      },
      onMove: (ev) => {
        const at = locate(ev);
        const ok = at.inside && at.target !== row.key && (latest.current.canDrop?.(row.key, at.target, at.position) ?? false);
        setDragCursor(ok ? "move" : "denied");
        setDrag({ key: row.key, label: row.label, icon: row.icon, x: ev.clientX, y: ev.clientY, ...at, ok });
        // Hovering a collapsed group for a moment opens it, so nodes can be dropped deeper.
        const over = at.target ? latest.current.rows.find((r) => r.key === at.target) : undefined;
        if (over && over.expandable && !over.expanded && at.position === "inside") {
          if (hoverTimer.current?.key !== over.key) {
            clearHoverTimer();
            hoverTimer.current = { key: over.key, id: window.setTimeout(() => latest.current.onToggle(over.key), EXPAND_ON_HOVER_MS) };
          }
        } else clearHoverTimer();
      },
      onEnd: (ev, cancelled) => {
        clearHoverTimer();
        setDrag(null);
        window.setTimeout(() => (suppressClick.current = false), 0);
        if (cancelled || !ev) return;
        const at = locate(ev);
        if (at.inside && at.target !== row.key && latest.current.canDrop?.(row.key, at.target, at.position)) {
          latest.current.onDrop?.(row.key, at.target, at.position);
        }
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editingKey || (e.target as HTMLElement).tagName === "INPUT") return;
    const index = rows.findIndex((r) => r.key === (focusKey ?? selectedKey));
    const row = index >= 0 ? rows[index] : undefined;
    const go = (i: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!next) return;
      setFocusKey(next.key);
      if (win.rowHeight > 0) reveal(rows.indexOf(next));
      else rootRef.current?.querySelector(`[data-tree-key="${CSS.escape(next.key)}"]`)?.scrollIntoView?.({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown":
        go(index + 1);
        break;
      case "ArrowUp":
        go(index < 0 ? 0 : index - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "ArrowRight":
        if (row?.expandable && !row.expanded) onToggle(row.key);
        else go(index + 1);
        break;
      case "ArrowLeft":
        if (row?.expandable && row.expanded) onToggle(row.key);
        else if (row) {
          for (let i = index - 1; i >= 0; i--) {
            if (rows[i]!.depth < row.depth) {
              go(i);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        if (row) onActivate(row.key);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const contextMenu = (e: MouseEvent, key: string | null) => {
    if (!onContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    if (key) setFocusKey(key);
    onContextMenu(key, { x: e.clientX, y: e.clientY });
  };

  return (
    <div
      ref={rootRef}
      className={cx("od-tree", drag?.inside && drag.target === null && (drag.ok ? "od-tree--drop-root" : "od-tree--drop-denied"), className)}
      role="tree"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => contextMenu(e, null)}
    >
      {rows.length === 0 && empty}
      {win.before > 0 && (
        <div
          className="od-tree__gap"
          style={{ height: win.before }} // od-allow-inline-style: height of the rows left out above
          aria-hidden="true"
        />
      )}
      {visible.map((row) => {
        const state = row.state ?? "ok";
        const stateIcon = STATE_ICON[state];
        const dropClass =
          drag && drag.target === row.key
            ? drag.ok
              ? `od-tree__row--drop-${drag.position}`
              : "od-tree__row--drop-denied"
            : undefined;
        const style = { "--od-depth": row.depth } as CSSProperties;
        return (
          <div
            key={row.key}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.expandable ? Boolean(row.expanded) : undefined}
            aria-selected={selectedKey === row.key}
            // A disabled item is greyed out, not blocked (D220): it still opens, e.g. to be enabled again.
            data-tree-key={row.key}
            data-state={state}
            data-more={row.more ? "" : undefined}
            title={row.stateLabel ? `${row.label} — ${row.stateLabel}` : undefined}
            className={cx(
              "od-tree__row",
              selectedKey === row.key && "od-tree__row--selected",
              focusKey === row.key && "od-tree__row--focused",
              state !== "ok" && `od-tree__row--${state}`,
              row.more && "od-tree__row--more",
              drag?.key === row.key && "od-tree__row--dragging",
              dropClass,
            )}
            style={style} // od-allow-inline-style: nesting depth drives the indent
            onPointerDown={(e) => startDrag(e, row)}
            onClick={() => {
              if (row.more || suppressClick.current || editingKey === row.key) return;
              setFocusKey(row.key);
              onActivate(row.key);
            }}
            onContextMenu={(e) => contextMenu(e, row.key)}
          >
            <span
              className={cx("od-tree__twist", row.expandable && "od-tree__twist--on", row.expanded && "od-tree__twist--open")}
              onClick={(e) => {
                if (!row.expandable) return;
                e.stopPropagation();
                onToggle(row.key);
              }}
            >
              {row.expandable && (row.loading ? <Spinner size="sm" /> : <Icon name="chevron-right" size="sm" />)}
            </span>
            <Icon name={row.icon} size="md" className="od-tree__icon" />
            {editingKey === row.key ? (
              <input
                className="od-tree__rename"
                defaultValue={row.label}
                aria-label={renameLabel}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRenameCommit?.(row.key, e.currentTarget.value.trim());
                  else if (e.key === "Escape") onRenameCancel?.();
                  e.stopPropagation();
                }}
                onBlur={(e) => onRenameCommit?.(row.key, e.currentTarget.value.trim())}
              />
            ) : (
              <span className="od-tree__label">
                <Highlighted text={row.label} query={highlight} />
              </span>
            )}
            {row.marked && <span className="od-tree__dot" aria-hidden="true" />}
            {row.badge && <span className="od-tree__badge">{row.badge}</span>}
            {stateIcon && state !== "disabled" && <Icon name={stateIcon} size="sm" className="od-tree__state" label={row.stateLabel} />}
          </div>
        );
      })}
      {win.after > 0 && (
        <div
          className="od-tree__gap"
          style={{ height: win.after }} // od-allow-inline-style: height of the rows left out below
          aria-hidden="true"
        />
      )}
      {drag && <DragGhost x={drag.x} y={drag.y} label={drag.label} icon={drag.icon} denied={!drag.ok} deniedLabel={dropDeniedLabel} />}
    </div>
  );
}
