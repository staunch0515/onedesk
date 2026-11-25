import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "./button";
import { cx } from "./cx";
import "./sequence-view.css";

/** One item of a sequence: its title (with its number), how deep it is (1–9), and whether it starts a book of its own. */
export interface SequenceEntry {
  key: string;
  title: string;
  level: number;
  book?: boolean;
}

export interface SequenceViewProps {
  /** Names the whole (the list of titles and the reading area). */
  label: string;
  items: SequenceEntry[];
  /** Show the list of titles beside the reading area. */
  toc?: boolean;
  /** `scroll`: one item after another; `pages`: one item at a time. */
  mode?: "scroll" | "pages";
  /** The item shown first. */
  startKey?: string | null;
  /** The content of an item; only asked for items in (or near) view. */
  renderContent: (key: string) => ReactNode;
  /** Buttons beside an item's title (e.g. open it). */
  renderActions?: (key: string) => ReactNode;
  /** Called once the reader has stopped on an item for a second. */
  onPosition?: (key: string) => void;
  labels: { toc: string; previous: string; next: string; page: (n: number, total: number) => string };
}

/** Items loaded on each side of those in view. */
const AROUND = 3;
/** How long the reader stays on an item before it counts as the place reached. */
const SETTLE_MS = 1000;

/**
 * D487 §13: a run of items read one after another — a book, or a part of one. Only the items in view (and a few on
 * each side) are drawn with their content; the list of titles jumps to an item and marks where the reader is.
 */
export function SequenceView({ label, items, toc, mode = "scroll", startKey, renderContent, renderActions, onPosition, labels }: SequenceViewProps) {
  const startIndex = Math.max(0, items.findIndex((x) => x.key === startKey));
  const [current, setCurrent] = useState(startIndex);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([startIndex]));
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<number, HTMLElement>());
  const jumped = useRef<number | null>(null);
  const keys = useMemo(() => items.map((x) => x.key).join("\n"), [items]);

  // Tell where the reader stopped (once it has stayed there a moment).
  const reported = useRef<string | null>(startKey ?? null);
  useEffect(() => {
    const key = items[current]?.key;
    if (!key || !onPosition || key === reported.current) return;
    const timer = setTimeout(() => {
      reported.current = key;
      onPosition(key);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [current, items, onPosition]);

  // Scroll: which items are in view, and the first of them is where the reader is.
  useEffect(() => {
    if (mode !== "scroll" || !scroller.current || typeof IntersectionObserver === "undefined") return;
    const seen = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset["index"]);
          if (e.isIntersecting) seen.add(i);
          else seen.delete(i);
        }
        if (seen.size > 0) {
          setVisible(new Set(seen));
          // An item jumped to stays the current one while it is in view (the last ones cannot reach the top).
          if (jumped.current !== null && !seen.has(jumped.current)) jumped.current = null;
          setCurrent(jumped.current ?? Math.min(...seen));
        }
      },
      { root: scroller.current },
    );
    sections.current.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [mode, keys]);

  // Start where asked — unless that is where the reader already is (the place just told comes back as the start).
  const here = useRef(current);
  here.current = current;
  const started = useRef(false);
  useEffect(() => {
    const again = started.current;
    started.current = true;
    if (again && items[here.current]?.key === startKey && reported.current === startKey) return;
    if (mode === "scroll") sections.current.get(startIndex)?.scrollIntoView?.({ block: "start" });
    setCurrent(startIndex);
    // Only when the items or the start change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, startKey]);

  // Switching between scroll and pages keeps the place.
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    setVisible(new Set([here.current]));
    if (mode === "scroll") sections.current.get(here.current)?.scrollIntoView?.({ block: "start" });
  }, [mode]);

  const go = useCallback(
    (i: number) => {
      const to = Math.max(0, Math.min(items.length - 1, i));
      jumped.current = to;
      setCurrent(to);
      setVisible(new Set([to]));
      if (mode === "scroll") sections.current.get(to)?.scrollIntoView?.({ block: "start" });
    },
    [items.length, mode],
  );

  const near = (i: number) => {
    if (mode === "pages") return i === current;
    for (const v of visible) if (Math.abs(v - i) <= AROUND) return true;
    return Math.abs(current - i) <= AROUND;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== "pages") return;
    if (e.key === "ArrowRight" || e.key === "PageDown") {
      e.preventDefault();
      go(current + 1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      go(current - 1);
    }
  };

  const item = (x: SequenceEntry, i: number) => (
    <section
      key={x.key}
      ref={(el) => {
        if (el) sections.current.set(i, el);
        else sections.current.delete(i);
      }}
      data-index={i}
      className={cx("od-sequence__item", x.book && "od-sequence__item--book")}
      aria-label={x.title}
    >
      <div className="od-sequence__head">
        <h2 className={cx("od-sequence__title", `od-sequence__title--l${Math.min(Math.max(x.level, 1), 9)}`)}>{x.title}</h2>
        {renderActions && <span className="od-sequence__actions">{renderActions(x.key)}</span>}
      </div>
      {near(i) ? <div className="od-sequence__content">{renderContent(x.key)}</div> : <div className="od-sequence__placeholder" />}
    </section>
  );

  return (
    <div className="od-sequence" aria-label={label}>
      {toc && (
        <nav className="od-sequence__toc" aria-label={labels.toc}>
          <ol>
            {items.map((x, i) => (
              <li key={x.key}>
                <button
                  type="button"
                  className={cx("od-sequence__toc-item", `od-sequence__toc-item--l${Math.min(Math.max(x.level, 1), 9)}`, x.book && "od-sequence__toc-item--book")}
                  aria-current={i === current ? "location" : undefined}
                  onClick={() => go(i)}
                >
                  {x.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div ref={scroller} className={cx("od-sequence__reader", mode === "pages" && "od-sequence__reader--pages")} tabIndex={0} onKeyDown={onKeyDown}>
        {mode === "pages" ? (
          <>
            {items[current] && item(items[current], current)}
            {items.length > 0 && (
              <div className="od-sequence__pager">
                <Button size="sm" variant="ghost" icon="chevron-left" disabled={current <= 0} onClick={() => go(current - 1)}>
                  {labels.previous}
                </Button>
                <span className="od-sequence__page">{labels.page(current + 1, items.length)}</span>
                <Button size="sm" variant="ghost" icon="chevron-right" disabled={current >= items.length - 1} onClick={() => go(current + 1)}>
                  {labels.next}
                </Button>
              </div>
            )}
          </>
        ) : (
          items.map(item)
        )}
      </div>
    </div>
  );
}
