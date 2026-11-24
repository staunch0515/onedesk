import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";
import "./lineage-list.css";

export interface LineageItem {
  key: string;
  /** The level's name (an environment, a folder…); indented one step per level. */
  label: ReactNode;
  /** What this level says, in the second column. */
  value: ReactNode;
}

/**
 * A line of descent as two columns, top level first: the name, one step further in per level, and the value
 * (numbers right-aligned, text left). D472: how a parameter is set along the parent environments.
 */
export function LineageList({ items, label, numeric, className }: { items: LineageItem[]; label?: string; numeric?: boolean; className?: string }) {
  return (
    <table className={cx("od-lineage", className)} aria-label={label}>
      <tbody>
        {items.map((item, depth) => (
          <tr key={item.key} className="od-lineage__row">
            <th
              scope="row"
              className="od-lineage__name"
              style={{ "--od-lineage-depth": depth } as CSSProperties} // od-allow-inline-style: nesting level of this row
            >
              {item.label}
            </th>
            <td className={cx("od-lineage__value", numeric && "od-lineage__value--numeric")}>{item.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
