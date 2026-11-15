import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Kbd } from "./kbd";
import "./option-list.css";

export interface OptionListItem {
  key: string;
  label: ReactNode;
  icon?: string;
  /** Second line under the label. */
  description?: ReactNode;
  /** Right-aligned short text. */
  meta?: ReactNode;
  selected?: boolean;
  muted?: boolean;
  /** Controls after the row (icon buttons); not part of the row's click target. */
  trailing?: ReactNode;
  onSelect?: () => void;
}

export interface OptionListProps {
  items: OptionListItem[];
  /** Accessible name. */
  label: string;
  /** Key of the keyboard-highlighted row (SearchBox). */
  activeKey?: string | null;
  empty?: ReactNode;
  /** Limits the height and scrolls inside (for popovers). */
  scroll?: boolean;
  className?: string;
}

/** Vertical list of clickable rows: icon, label, optional second line, meta. Used in popovers and panels. */
export function OptionList({ items, label, activeKey, empty, scroll, className }: OptionListProps) {
  return (
    <div className={cx("od-option-list", scroll && "od-option-list--scroll", className)} role="listbox" aria-label={label}>
      {items.length === 0 && empty && <div className="od-option-list__empty">{empty}</div>}
      {items.map((item) => (
        <div
          key={item.key}
          className={cx(
            "od-option",
            item.selected && "od-option--selected",
            item.muted && "od-option--muted",
            activeKey === item.key && "od-option--active",
          )}
          role="option"
          aria-selected={Boolean(item.selected)}
        >
          <button type="button" className="od-option__main" onClick={item.onSelect} disabled={!item.onSelect} data-option-key={item.key}>
            {item.icon && <Icon name={item.icon} size="md" className="od-option__icon" />}
            <span className="od-option__text">
              <span className="od-option__label">{item.label}</span>
              {item.description && <span className="od-option__description">{item.description}</span>}
            </span>
            {item.meta && <span className="od-option__meta">{item.meta}</span>}
          </button>
          {item.trailing && <span className="od-option__trailing">{item.trailing}</span>}
        </div>
      ))}
    </div>
  );
}

export interface SearchBoxProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  /** Accessible name of the input. */
  label: string;
  shortcut?: string[];
  results: OptionListItem[];
  /** Shown in the dropdown when there is text but no result. */
  emptyText: ReactNode;
  resultsLabel: string;
  loading?: boolean;
  ref?: Ref<HTMLInputElement>;
  className?: string;
}

/** Global search field with a result dropdown (I.0h): ↑ ↓ move, Enter opens, Escape closes. */
export function SearchBox({ value, onValueChange, placeholder, label, shortcut, results, emptyText, resultsLabel, ref, className }: SearchBoxProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActive(results[0]?.key ?? null);
  }, [results]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const index = results.findIndex((r) => r.key === active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const next = results[(index + (e.key === "ArrowDown" ? 1 : -1) + results.length) % Math.max(1, results.length)];
      if (next) {
        setActive(next.key);
        rootRef.current?.querySelector(`[data-option-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      const hit = results[index];
      if (hit?.onSelect) {
        e.preventDefault();
        hit.onSelect();
        setOpen(false);
        e.currentTarget.blur();
      }
    } else if (e.key === "Escape") {
      if (value) onValueChange("");
      setOpen(false);
      e.currentTarget.blur();
    }
  };

  const showDropdown = open && value.trim().length > 0;
  return (
    <div ref={rootRef} className={cx("od-search-box", className)}>
      <div className="od-search-box__field">
        <Icon name="search" size="md" className="od-search-box__icon" />
        <input
          ref={ref}
          className="od-search-box__input"
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={undefined}
          aria-label={label}
          placeholder={placeholder}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            onValueChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {shortcut && !value && <Kbd keys={shortcut} />}
      </div>
      {showDropdown && (
        <div className="od-search-box__dropdown">
          <OptionList
            label={resultsLabel}
            activeKey={active}
            scroll
            empty={emptyText}
            items={results.map((r) => ({
              ...r,
              onSelect: r.onSelect
                ? () => {
                    r.onSelect!();
                    setOpen(false);
                  }
                : undefined,
            }))}
          />
        </div>
      )}
    </div>
  );
}
