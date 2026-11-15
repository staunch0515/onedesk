import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { beginPointerDrag, setDragCursor } from "./pointer-drag";
import "./splitter.css";

export interface SplitterProps {
  /** "x": a vertical line dragged left/right. "y": a horizontal line dragged up/down. */
  axis: "x" | "y";
  /** Accessible name, e.g. "Resize side panel". */
  label: string;
  onDragStart?: () => void;
  /** Distance in px from where the drag started (positive = right / down). */
  onDrag: (delta: number) => void;
  onDragEnd?: () => void;
  /** Double-click: restore the default size. */
  onReset?: () => void;
  className?: string;
}

/**
 * Draggable divider (I.7): one cursor for the whole drag, no text selection, a thin line with a
 * wider invisible hit area. The owner keeps the size; this component only reports the distance.
 */
export function Splitter({ axis, label, onDragStart, onDrag, onDragEnd, onReset, className }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ onDrag, onDragEnd });
  latest.current = { onDrag, onDragEnd };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    beginPointerDrag(e, {
      onStart: () => {
        setDragCursor(axis === "x" ? "resize-x" : "resize-y");
        setDragging(true);
        onDragStart?.();
      },
      onMove: (_ev, d) => latest.current.onDrag(axis === "x" ? d.x : d.y),
      onEnd: () => {
        setDragging(false);
        latest.current.onDragEnd?.();
      },
    });
  };

  return (
    <div
      className={cx("od-splitter", `od-splitter--${axis}`, dragging && "od-splitter--dragging", className)}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  );
}

export interface SizedProps {
  axis: "x" | "y";
  /** Size in px along the axis (user-dragged, remembered by the owner). */
  size: number;
  children: ReactNode;
  className?: string;
}

/** A pane with a fixed size along one axis; it never grows or shrinks with its content (I.7). */
export function Sized({ axis, size, children, className }: SizedProps) {
  const style = { "--od-size": `${Math.round(size)}px` } as CSSProperties;
  return (
    <div
      className={cx("od-sized", `od-sized--${axis}`, className)}
      style={style} // od-allow-inline-style: user-dragged pane size (I.7)
    >
      {children}
    </div>
  );
}
