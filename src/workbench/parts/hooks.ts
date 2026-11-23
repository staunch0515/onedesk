import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "../state/context";
import { clamp, LIMITS, DEFAULT_LAYOUT } from "../state/store";

type SizeKey = "sideWidth" | "infoWidth" | "panelHeight";

const RANGE: Record<SizeKey, { min: number; max: number }> = { sideWidth: LIMITS.side, infoWidth: LIMITS.info, panelHeight: LIMITS.panel };

/** Wires a Splitter to a remembered size. `direction` -1 when dragging towards the start grows the pane. */
export function useResize(key: SizeKey, direction: 1 | -1) {
  const { store } = useWorkbench();
  const start = useRef(0);
  return {
    onDragStart: () => {
      start.current = store.get()[key];
    },
    onDrag: (delta: number) => {
      const { min, max } = RANGE[key];
      // Never let a pane push its neighbour out of the window.
      const room = key === "panelHeight" ? window.innerHeight - 280 : window.innerWidth - 640;
      store.set({ [key]: Math.round(clamp(start.current + direction * delta, min, Math.max(min, Math.min(max, room)))) });
    },
    onReset: () => store.set({ [key]: DEFAULT_LAYOUT[key] }),
  };
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether the window is at least `min` px wide; follows resizing. */
export function useWindowAtLeast(min: number): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= min);
  useEffect(() => {
    const update = () => setWide(window.innerWidth >= min);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [min]);
  return wide;
}
