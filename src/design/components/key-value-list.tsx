import type { ReactNode } from "react";
import { cx } from "./cx";
import "./key-value-list.css";

export interface KeyValueItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
  /** Monospace label (e.g. a raw field name shown because no label is known). */
  monoLabel?: boolean;
}

export interface KeyValueListProps {
  items: KeyValueItem[];
  /** `columns`: label left, value right (wide areas). `stacked`: label above value. */
  layout?: "columns" | "stacked";
  className?: string;
}

/** Read-only label/value pairs (a description list). Values wrap; nothing is cut off. */
export function KeyValueList({ items, layout = "columns", className }: KeyValueListProps) {
  return (
    <dl className={cx("od-kv", `od-kv--${layout}`, className)}>
      {items.map((item) => (
        <div key={item.key} className="od-kv__row">
          <dt className={cx("od-kv__label", item.monoLabel && "od-mono")}>{item.label}</dt>
          <dd className="od-kv__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
