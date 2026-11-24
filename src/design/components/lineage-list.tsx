import type { ReactNode } from "react";
import { cx } from "./cx";
import "./lineage-list.css";

export interface LineageItem {
  key: string;
  /** The level's name (an environment, a folder…). */
  label: ReactNode;
  /** What this level says; shown under the label. */
  value: ReactNode;
  /** A mark after the label, e.g. "in effect". */
  badge?: ReactNode;
  /** The level the reader is looking at; drawn stronger. */
  current?: boolean;
}

/**
 * A line of descent, top level first: each level is drawn one step in from its parent, joined by a rule, so
 * "root › parent › this" reads as a family line (D472: how a parameter is set along the environments).
 */
export function LineageList({ items, label, className }: { items: LineageItem[]; label?: string; className?: string }) {
  const level = (i: number): ReactNode => {
    const item = items[i];
    if (!item) return null;
    return (
      <li className={cx("od-lineage__item", item.current && "od-lineage__item--current")}>
        <div className="od-lineage__head">
          <span className="od-lineage__label">{item.label}</span>
          {item.badge}
        </div>
        <div className="od-lineage__value">{item.value}</div>
        {i + 1 < items.length && <ol className="od-lineage od-lineage--nested">{level(i + 1)}</ol>}
      </li>
    );
  };
  return (
    <ol className={cx("od-lineage", className)} aria-label={label}>
      {level(0)}
    </ol>
  );
}
