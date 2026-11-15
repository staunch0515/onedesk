/**
 * Pointer-based dragging shared by Splitter, Tree and TabStrip. HTML5 drag-and-drop is avoided on
 * purpose: the Tauri webview intercepts it for file drops, and the cursor cannot be controlled.
 * While a drag is active <body> carries a class that fixes the cursor and blocks text selection.
 */
export type DragCursor = "resize-x" | "resize-y" | "move" | "denied";

const BODY_CLASS: Record<DragCursor, string> = {
  "resize-x": "od-dragging-resize-x",
  "resize-y": "od-dragging-resize-y",
  move: "od-dragging-move",
  denied: "od-dragging-denied",
};

export function setDragCursor(cursor: DragCursor | null): void {
  const list = document.body.classList;
  for (const cls of Object.values(BODY_CLASS)) list.remove(cls);
  if (cursor) list.add(BODY_CLASS[cursor]);
}

export interface PointerDragHandlers {
  /** Distance in px the pointer must travel before the drag starts (0 = immediately). */
  threshold?: number;
  onStart?: (event: PointerEvent) => void;
  onMove: (event: PointerEvent, delta: { x: number; y: number }) => void;
  /** `cancelled` is true for Escape and pointercancel. */
  onEnd?: (event: PointerEvent | null, cancelled: boolean) => void;
}

/** Call from a pointerdown handler. Returns nothing; listeners clean themselves up. */
export function beginPointerDrag(origin: { clientX: number; clientY: number }, handlers: PointerDragHandlers): void {
  const threshold = handlers.threshold ?? 0;
  let started = false;
  const delta = (ev: PointerEvent) => ({ x: ev.clientX - origin.clientX, y: ev.clientY - origin.clientY });
  const move = (ev: PointerEvent) => {
    const d = delta(ev);
    if (!started) {
      if (Math.hypot(d.x, d.y) < threshold) return;
      started = true;
      handlers.onStart?.(ev);
    }
    handlers.onMove(ev, d);
  };
  const finish = (ev: PointerEvent | null, cancelled: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    if (started) {
      setDragCursor(null);
      handlers.onEnd?.(ev, cancelled);
    }
  };
  const up = (ev: PointerEvent) => finish(ev, false);
  const cancel = (ev: PointerEvent) => finish(ev, true);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && started) {
      ev.preventDefault();
      ev.stopPropagation();
      finish(null, true);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
