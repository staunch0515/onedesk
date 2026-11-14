import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "./cx";
import "./table.css";

export interface TableColumn<Row> {
  key: string;
  header: ReactNode;
  /** Cell content; defaults to `String(row[key])`. */
  render?: (row: Row) => ReactNode;
  /** Numeric columns are right-aligned with tabular figures. */
  numeric?: boolean;
  align?: "start" | "center" | "end";
  /** Shrink the column to its content (actions, status). */
  shrink?: boolean;
  /** Muted secondary text (dates, ids). */
  muted?: boolean;
  /** Monospace text (URLs, ids). */
  mono?: boolean;
}

export interface TableProps<Row> {
  columns: Array<TableColumn<Row>>;
  rows: Row[];
  getRowKey: (row: Row) => string;
  /** Selected row keys (highlighted, `aria-selected`). */
  selectedKeys?: ReadonlySet<string> | string[];
  /** Rows shown greyed out (e.g. resources of a disabled plugin) — still visible, never hidden. */
  isRowMuted?: (row: Row) => boolean;
  /** Makes rows interactive: click, Enter or Space activates. */
  onRowActivate?: (row: Row) => void;
  /** Shown in place of the body when `rows` is empty (typically an EmptyState). */
  empty?: ReactNode;
  /** Accessible table name. */
  label?: string;
  /** Keep the header visible while the surrounding container scrolls. */
  stickyHeader?: boolean;
  className?: string;
}

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

  const onKeyDown = (row: Row) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowActivate?.(row);
    }
  };

  return (
    <div className={cx("od-table-wrap", className)}>
      <table className={cx("od-table", stickyHeader && "od-table--sticky", interactive && "od-table--interactive")} aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cx("od-table__th", `od-table__cell--${alignOf(c)}`, c.shrink && "od-table__cell--shrink")}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="od-table__empty-row">
              <td colSpan={columns.length} className="od-table__empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const key = getRowKey(row);
              const isSelected = selected.has(key);
              return (
                <tr
                  key={key}
                  className={cx("od-table__row", isSelected && "od-table__row--selected", isRowMuted?.(row) && "od-table__row--muted")}
                  aria-selected={selectedKeys ? isSelected : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  onClick={interactive ? () => onRowActivate?.(row) : undefined}
                  onKeyDown={interactive ? onKeyDown(row) : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx(
                        "od-table__td",
                        `od-table__cell--${alignOf(c)}`,
                        c.numeric && "od-tabular",
                        c.shrink && "od-table__cell--shrink",
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
