import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./suggest-list.css";

export interface SuggestItem {
  key: string;
  icon?: string;
  title: string;
  /** A muted line under the title (e.g. where it is). */
  detail?: string;
}

export interface SuggestListProps {
  label: string;
  items: SuggestItem[];
  active: number;
  /** Shown when there is nothing to offer. */
  empty?: string;
  onPick: (index: number) => void;
  onHover?: (index: number) => void;
}

/** D482: candidates offered while typing, floating over the field; the field keeps the keyboard. */
export function SuggestList({ label, items, active, empty, onPick, onHover }: SuggestListProps) {
  return (
    <ul className="od-suggest" role="listbox" aria-label={label}>
      {items.length === 0 && empty && <li className="od-suggest__empty">{empty}</li>}
      {items.map((it, i) => (
        <li
          key={it.key}
          role="option"
          aria-selected={i === active}
          className={cx("od-suggest__item", i === active && "od-suggest__item--active")}
          // Keep the focus (and the caret) in the field.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover?.(i)}
          onClick={() => onPick(i)}
        >
          {it.icon && <Icon name={it.icon} size="sm" />}
          <span className="od-suggest__text">
            <span className="od-suggest__title">{it.title}</span>
            {it.detail && <span className="od-suggest__detail">{it.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The field and its candidate list; `fill` keeps a field that fills the page doing so. */
export function SuggestAnchor({ fill, children }: { fill?: boolean; children: ReactNode }) {
  return <div className={cx("od-suggest-anchor", fill && "od-suggest-anchor--fill")}>{children}</div>;
}
