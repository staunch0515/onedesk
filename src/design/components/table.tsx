import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cx } from "./cx";
import "./table.css";

export type TableColumnWidth = "auto" | "xs" | "sm" | "md" | "lg";

export interface TableColumn<Row> {
  key: string;
  header: ReactNode;
  /** Cell content; defaults to `String(row[key])`. */
  render?: (row: Row) => ReactNode;
  /** Numeric columns are right-aligned with tabular figures. */
  numeric?: boolean;
  align?: "start" | "center" | "end";
  /**
   * Fixed width from the --table-col-* tokens (xs fits an icon button, md a date-time).
   * `auto` columns share the remaining space. The layout is fixed, so tables with the same
   * columns line up whether or not they have rows.
   */
  width?: TableColumnWidth;
  /** Muted secondary text (dates, ids). */
  muted?: boolean;
  /** Monospace text (URLs, ids). */
  mono?: boolean;
}

export interface TableProps<Row> {
  columns: Array<TableColumn<Row>>;
  rows: Row[];
  getRowKey: (row: Row) => string;
  /** Selected row keys (highlighted; `aria-selected` in interactive tables). */
  selectedKeys?: ReadonlySet<string> | string[];
  /** Rows shown greyed out (e.g. resources of a disabled plugin) — still visible, never hidden. */
  isRowMuted?: (row: Row) => boolean;
  /**
   * Makes the table an interactive grid: one Tab stop, ↑/↓/Home/End move between rows,
   * click, Enter or Space activates. Controls inside cells keep their own clicks and keys.
   */
  onRowActivate?: (row: Row) => void;
  /** Shown in place of the body when `rows` is empty (typically an EmptyState). */
  empty?: ReactNode;
  /** Accessible table name. */
  label?: string;
  /** Keep the header visible while the surrounding container scrolls. */
  stickyHeader?: boolean;
  className?: string;
}

/** Elements that handle their own activation; row click/keys must not steal from them. */
const INTERACTIVE = "button, a, input, select, textarea, label, [role=menuitem], [role=checkbox], [role=switch], [role=combobox]";

export function Table<Row>({
  columns,
  rows,
  getRowKey,
  selectedKeys,
  isRowMuted,
  onRowActivate,
  empty,
  label,
  stickyHeader = false,
  className,
}: TableProps<Row>) {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys ?? []);
  const interactive = Boolean(onRowActivate);
  const alignOf = (c: TableColumn<Row>) => c.align ?? (c.numeric ? "end" : "start");
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Roving tabindex: the active row is the only Tab stop. Starts at the first selected row.
  const firstSelected = rows.findIndex((r) => selected.has(getRowKey(r)));
  const [active, setActive] = useState<number | null>(null);
  const activeIndex = Math.min(active ?? Math.max(firstSelected, 0), Math.max(rows.length - 1, 0));

  const focusRow = (index: number) => {
    const target = bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr.od-table__row")[index];
    if (!target) return;
    setActive(index);
    target.focus();
  };

  const onKeyDown = (row: Row, index: number) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        onRowActivate?.(row);
        return;
      case "ArrowDown":
        e.preventDefault();
        focusRow(Math.min(index + 1, rows.length - 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        focusRow(Math.max(index - 1, 0));
        return;
      case "Home":
        e.preventDefault();
        focusRow(0);
        return;
      case "End":
        e.preventDefault();
        focusRow(rows.length - 1);
        return;
    }
  };

  const onClick = (row: Row, index: number) => (e: MouseEvent<HTMLTableRowElement>) => {
    const target = e.target as Element;
    // React bubbles events from portals (e.g. a row's DropdownMenu items) through the row: ignore those.
    if (!e.currentTarget.contains(target)) return;
    const control = target.closest(INTERACTIVE);
    if (control && e.currentTarget.contains(control)) return;
    setActive(index);
    onRowActivate?.(row);
  };

  return (
    <div className={cx("od-table-wrap", className)}>
      <table
        className={cx("od-table", stickyHeader && "od-table--sticky", interactive && "od-table--interactive")}
        aria-label={label}
        role={interactive ? "grid" : undefined}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} className={cx(c.width && c.width !== "auto" && `od-table__col--${c.width}`)} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx("od-table__th", `od-table__cell--${alignOf(c)}`)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {rows.length === 0 ? (
            <tr className="od-table__empty-row">
              <td colSpan={columns.length} className="od-table__empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const key = getRowKey(row);
              const isSelected = selected.has(key);
              return (
                <tr
                  key={key}
                  className={cx("od-table__row", isSelected && "od-table__row--selected", isRowMuted?.(row) && "od-table__row--muted")}
                  aria-selected={interactive ? isSelected : undefined}
                  tabIndex={interactive ? (index === activeIndex ? 0 : -1) : undefined}
                  onFocus={interactive ? (e) => e.target === e.currentTarget && setActive(index) : undefined}
                  onClick={interactive ? onClick(row, index) : undefined}
                  onKeyDown={interactive ? onKeyDown(row, index) : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx(
                        "od-table__td",
                        `od-table__cell--${alignOf(c)}`,
                        c.numeric && "od-tabular",
                        c.muted && "od-table__cell--muted",
                        c.mono && "od-mono",
                      )}
                    >
                      {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
