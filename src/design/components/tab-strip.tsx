import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { DragGhost } from "./drag-ghost";
import { Icon } from "./icon";
import { beginPointerDrag, setDragCursor } from "./pointer-drag";
import "./tab-strip.css";

export interface TabStripItem {
  id: string;
  label: string;
  /** Kind icon (lucide name). */
  icon: string;
  /** Unsaved changes: a dot replaces the close button until the tab is hovered. */
  dirty?: boolean;
  /** Pinned tabs show only the icon and have no close button. */
  pinned?: boolean;
  /** Greyed label (e.g. the target no longer exists). */
  muted?: boolean;
  /** Small running indicator. */
  busy?: boolean;
  tooltip?: string;
}

export interface TabStripProps {
  tabs: TabStripItem[];
  activeId: string | null;
  /** Accessible name of the tab list. */
  label: string;
  closeLabel: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Move `id` in front of `beforeId` (null = to the end). */
  onReorder?: (id: string, beforeId: string | null) => void;
  /** Whether the tab may be placed there (e.g. pinned tabs stay in front). */
  canReorder?: (id: string, beforeId: string | null) => boolean;
  onContextMenu?: (id: string, point: { x: number; y: number }) => void;
  /** Buttons at the right end (all tabs, close all, collapse). */
  trailing?: ReactNode;
  /** Collapsed: only a thin line remains (I.2). */
  collapsed?: boolean;
  dropDeniedLabel?: string;
  className?: string;
}

interface DragState {
  id: string;
  x: number;
  y: number;
  beforeId: string | null;
  ok: boolean;
}

const DRAG_THRESHOLD = 5;

/** Workbench tab bar (I.0h, I.2): kind icon, close button, unsaved dot, pinned tabs, overflow scroll, drag to reorder. */
export function TabStrip({
  tabs,
  activeId,
  label,
  closeLabel,
  onSelect,
  onClose,
  onReorder,
  canReorder,
  onContextMenu,
  trailing,
  collapsed,
  dropDeniedLabel,
  className,
}: TabStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
  const latest = useRef({ tabs, onReorder, canReorder });
  latest.current = { tabs, onReorder, canReorder };

  useEffect(() => {
    if (!activeId) return;
    scrollRef.current?.querySelector(`[data-tab-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // Vertical wheel scrolls the strip sideways. Registered natively: React's wheel listener is passive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const startDrag = (e: ReactPointerEvent, tab: TabStripItem) => {
    if (e.button !== 0 || !onReorder) return;
    const locate = (ev: PointerEvent): string | null | undefined => {
      const el = scrollRef.current;
      if (!el) return undefined;
      const box = el.getBoundingClientRect();
      if (ev.clientY < box.top - box.height || ev.clientY > box.bottom + box.height) return undefined;
      for (const node of el.querySelectorAll<HTMLElement>("[data-tab-id]")) {
        const r = node.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) return node.dataset.tabId!;
      }
      return null;
    };
    const check = (beforeId: string | null | undefined) => {
      if (beforeId === undefined) return false;
      const list = latest.current.tabs;
      const index = list.findIndex((t) => t.id === tab.id);
      const next = list[index + 1]?.id ?? null;
      if (beforeId === tab.id || beforeId === next) return true; // same place: allowed, no-op
      return latest.current.canReorder?.(tab.id, beforeId) ?? true;
    };
    beginPointerDrag(e, {
      threshold: DRAG_THRESHOLD,
      onStart: () => {
        suppressClick.current = true;
      },
      onMove: (ev) => {
        const beforeId = locate(ev);
        const ok = check(beforeId);
        setDragCursor(ok ? "move" : "denied");
        setDrag({ id: tab.id, x: ev.clientX, y: ev.clientY, beforeId: beforeId ?? null, ok });
        const el = scrollRef.current;
        if (el) {
          const box = el.getBoundingClientRect();
          if (ev.clientX < box.left + 24) el.scrollLeft -= 12;
          else if (ev.clientX > box.right - 24) el.scrollLeft += 12;
        }
      },
      onEnd: (ev, cancelled) => {
        setDrag(null);
        window.setTimeout(() => (suppressClick.current = false), 0);
        if (cancelled || !ev) return;
        const beforeId = locate(ev);
        if (beforeId === undefined || !check(beforeId) || beforeId === tab.id) return;
        latest.current.onReorder?.(tab.id, beforeId);
      },
    });
  };

  if (collapsed) return <div className={cx("od-tabstrip", "od-tabstrip--collapsed", className)}>{trailing}</div>;

  const dragged = drag ? tabs.find((t) => t.id === drag.id) : undefined;
  return (
    <div className={cx("od-tabstrip", className)}>
      <div ref={scrollRef} className="od-tabstrip__scroll" role="tablist" aria-label={label}>
        {tabs.map((tab, i) => {
          const active = tab.id === activeId;
          const insertBefore = drag?.ok && drag.beforeId === tab.id && drag.id !== tab.id;
          const insertAfter = drag?.ok && drag.beforeId === null && i === tabs.length - 1 && drag.id !== tab.id;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-tab-id={tab.id}
              title={tab.tooltip ?? tab.label}
              className={cx(
                "od-tab",
                active && "od-tab--active",
                tab.pinned && "od-tab--pinned",
                tab.dirty && "od-tab--dirty",
                tab.muted && "od-tab--muted",
                drag?.id === tab.id && "od-tab--dragging",
                insertBefore && "od-tab--insert-before",
                insertAfter && "od-tab--insert-after",
              )}
              onPointerDown={(e) => startDrag(e, tab)}
              onClick={() => {
                if (!suppressClick.current) onSelect(tab.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && !tab.pinned) onClose(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect(tab.id);
                else if (e.key === "ArrowRight" && tabs[i + 1]) onSelect(tabs[i + 1]!.id);
                else if (e.key === "ArrowLeft" && tabs[i - 1]) onSelect(tabs[i - 1]!.id);
              }}
              onContextMenu={(e) => {
                if (!onContextMenu) return;
                e.preventDefault();
                onContextMenu(tab.id, { x: e.clientX, y: e.clientY });
              }}
            >
              <Icon name={tab.busy ? "loader" : tab.icon} size="md" className={cx("od-tab__icon", tab.busy && "od-tab__icon--busy")} />
              {!tab.pinned && <span className="od-tab__label">{tab.label}</span>}
              {tab.pinned ? (
                tab.dirty && <span className="od-tab__pin-dot" aria-hidden="true" />
              ) : (
                <button
                  type="button"
                  className="od-tab__close"
                  aria-label={`${closeLabel} ${tab.label}`}
                  tabIndex={-1}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <Icon name="x" size="sm" className="od-tab__close-x" />
                  <span className="od-tab__dirty-dot" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {trailing && <div className="od-tabstrip__trailing">{trailing}</div>}
      {drag && dragged && <DragGhost x={drag.x} y={drag.y} label={dragged.label} icon={dragged.icon} denied={!drag.ok} deniedLabel={dropDeniedLabel} />}
    </div>
  );
}
