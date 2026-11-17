import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Rows drawn above and below the visible ones, so fast scrolling does not show blanks. */
export const OVERSCAN_ROWS = 8;
/** Rows drawn before the size of the scroller is known (the very first render, or where there is no layout): enough for any screen, cheap for any list. */
export const UNMEASURED_ROWS = 300;

export interface WindowRange {
  /** First row drawn. */
  start: number;
  /** One past the last row drawn. */
  end: number;
  /** Height of the rows before `start` / after `end`, in px (drawn as empty space). */
  before: number;
  after: number;
}

/**
 * Which rows of a list of `count` fixed-height rows must exist for a viewport scrolled to `scrollTop`.
 * Pure, so the arithmetic is tested without a browser. Without a usable height (not laid out yet) the first `UNMEASURED_ROWS` rows are drawn.
 */
export function computeWindow(input: { count: number; rowHeight: number; scrollTop: number; viewport: number; overscan?: number; /** Space above the first row inside the scroller (its padding), in px. */ inset?: number }): WindowRange {
  const { count, rowHeight, viewport } = input;
  const overscan = input.overscan ?? OVERSCAN_ROWS;
  if (count <= 0) return { start: 0, end: 0, before: 0, after: 0 };
  if (!(rowHeight > 0) || !(viewport > 0)) return { start: 0, end: Math.min(count, UNMEASURED_ROWS), before: 0, after: 0 };
  const top = Math.max(0, input.scrollTop - (input.inset ?? 0));
  const first = Math.min(count - 1, Math.floor(top / rowHeight));
  const last = Math.min(count, Math.ceil((top + viewport) / rowHeight));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, Math.max(last, first + 1) + overscan);
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight };
}

/** The scroll position that brings row `index` fully into view with the least movement (`viewport` excludes a sticky header). */
export function scrollTopFor(input: { index: number; rowHeight: number; scrollTop: number; viewport: number; inset?: number }): number {
  const { index, rowHeight, viewport } = input;
  const top = (input.inset ?? 0) + index * rowHeight;
  if (top < input.scrollTop) return top;
  if (top + rowHeight > input.scrollTop + viewport) return Math.max(0, top + rowHeight - viewport);
  return input.scrollTop;
}

function readPx(el: Element, variable: string): number {
  const raw = window.getComputedStyle(el).getPropertyValue(variable).trim();
  return raw.endsWith("px") ? Number.parseFloat(raw) : Number.NaN;
}

export interface VirtualOptions {
  count: number;
  /** CSS custom property (a design token) that holds the row height, e.g. `--tree-row-height`. */
  rowHeightVar: string;
  /** Overrides the token (tests). */
  rowHeight?: number;
  /** Height of a sticky header inside the scroller, in px (not part of the rows' viewport). */
  header?: number;
}

export interface VirtualWindow extends WindowRange {
  rowHeight: number;
  /** Brings a row into view even if it is not drawn at the moment. */
  /** Returns false when it could not act yet (size not known). */
  reveal: (index: number) => boolean;
}

/**
 * Windowing for a scroller whose rows all have the same height (D373). `ref` is the scrolling element; the row height
 * comes from a token so the rows keep their look. Not laid out (no height known): all rows are drawn.
 */
export function useVirtualWindow(ref: RefObject<HTMLElement | null>, { count, rowHeightVar, rowHeight: override, header = 0 }: VirtualOptions): VirtualWindow {
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewport: 0, rowHeight: override ?? 0, inset: 0 });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rowHeight = override ?? readPx(el, rowHeightVar);
    const inset = Number.parseFloat(window.getComputedStyle(el).paddingTop) || 0;
    const next = { scrollTop: el.scrollTop, viewport: Math.max(0, el.clientHeight - header), rowHeight: Number.isFinite(rowHeight) ? rowHeight : 0, inset };
    setMetrics((m) => (m.scrollTop === next.scrollTop && m.viewport === next.viewport && m.rowHeight === next.rowHeight && m.inset === next.inset ? m : next));
  }, [ref, rowHeightVar, override, header]);

  useLayoutEffect(measure, [measure, count]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, measure]);

  const range = computeWindow({ count, rowHeight: metrics.rowHeight, scrollTop: metrics.scrollTop, viewport: metrics.viewport, inset: metrics.inset });
  const latest = useRef({ metrics, count, header });
  latest.current = { metrics, count, header };
  const reveal = useCallback(
    (index: number) => {
      const el = ref.current;
      const { metrics: m, count: n } = latest.current;
      if (!el || !(m.rowHeight > 0) || index < 0 || index >= n) return false;
      const target = scrollTopFor({ index, rowHeight: m.rowHeight, scrollTop: el.scrollTop, viewport: m.viewport, inset: m.inset });
      if (target !== el.scrollTop) {
        el.scrollTop = target;
        measure(); // draw the new window now, without waiting for the scroll event
      }
      return true;
    },
    [ref, measure],
  );
  return { ...range, rowHeight: metrics.rowHeight, reveal };
}
