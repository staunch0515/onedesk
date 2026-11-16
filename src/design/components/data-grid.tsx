import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { beginPointerDrag, setDragCursor } from "./pointer-drag";
import { useVirtualWindow } from "./virtual";
import "./data-grid.css";

export type DataGridValue = string | number | boolean | null | undefined;

export interface DataGridColumn<Row> {
  key: string;
  header: ReactNode;
  /** Value used for sorting and, without `render`, for display. */
  value?: (row: Row) => DataGridValue;
  render?: (row: Row) => ReactNode;
  /** Right-aligned, tabular digits. */
  numeric?: boolean;
  mono?: boolean;
  muted?: boolean;
  /** Default width in px; the user can drag it. */
  width?: number;
  sortable?: boolean;
  resizable?: boolean;
}

export type DataGridSort = { key: string; direction: "asc" | "desc" } | null;

export interface DataGridProps<Row> {
  columns: Array<DataGridColumn<Row>>;
  rows: Row[];
  getRowKey: (row: Row, index: number) => string;
  /** Accessible name. */
  label: string;
  /** User-dragged widths by column key (remembered by the owner, I.7). */
  widths?: Record<string, number>;
  onWidthsChange?: (widths: Record<string, number>) => void;
  /** Uncontrolled initial sort. */
  defaultSort?: DataGridSort;
  /** Shows a leading row-number column. */
  rowNumbers?: boolean;
  /** dense: result grids. regular: lists with controls inside the cells. */
  size?: "dense" | "regular";
  selectedKey?: string | null;
  /** Click selects; double-click or Enter activates (ui-spec §7a). `activateOnClick` makes a single click activate. */
  onRowSelect?: (row: Row) => void;
  onRowActivate?: (row: Row) => void;
  activateOnClick?: boolean;
  isRowMuted?: (row: Row) => boolean;
  /** Text for null values. */
  nullText?: string;
  empty?: ReactNode;
  /** Draw a border around the grid (when it is not edge-to-edge in a panel). */
  framed?: boolean;
  /** Grow with the rows instead of filling (and scrolling inside) the parent. */
  autoHeight?: boolean;
  className?: string;
}

const DEFAULT_WIDTH = 160;
const MIN_WIDTH = 56;
const MAX_WIDTH = 1200;
/** Mirrors --grid-rownum-width. */
const ROWNUM_WIDTH = 48;

function compare(a: DataGridValue, b: DataGridValue): number {
  const an = a === null || a === undefined || a === "";
  const bn = b === null || b === undefined || b === "";
  if (an || bn) return an === bn ? 0 : an ? 1 : -1; // empty values last
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Empty space standing in for the rows that are not drawn. */
function GridGap({ height, columns }: { height: number; columns: number }) {
  return (
    <tr className="od-grid__gap" aria-hidden="true">
      <td
        colSpan={columns}
        style={{ height }} // od-allow-inline-style: height of the rows left out
      />
    </tr>
  );
}

/**
 * Data grid for results and lists (I.7): sticky header, three-state sorting with a direction mark,
 * draggable column widths, aligned vertical rules, no stray gaps. Fills its parent and scrolls inside.
 */
export function DataGrid<Row>({
  columns,
  rows,
  getRowKey,
  label,
  widths,
  onWidthsChange,
  defaultSort = null,
  rowNumbers = false,
  size = "dense",
  selectedKey,
  onRowSelect,
  onRowActivate,
  activateOnClick,
  isRowMuted,
  nullText = "NULL",
  empty,
  framed,
  autoHeight,
  className,
}: DataGridProps<Row>) {
  const [sort, setSort] = useState<DataGridSort>(defaultSort);
  const [localWidths, setLocalWidths] = useState<Record<string, number>>({});
  const [resizing, setResizing] = useState<string | null>(null);
  const current = widths ?? localWidths;
  const latest = useRef({ current, onWidthsChange });
  latest.current = { current, onWidthsChange };

  const widthOf = (c: DataGridColumn<Row>) => current[c.key] ?? c.width ?? DEFAULT_WIDTH;

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.value) return rows;
    const sign = sort.direction === "asc" ? 1 : -1;
    return rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => sign * compare(col.value!(a.row), col.value!(b.row)) || a.i - b.i)
      .map((x) => x.row);
  }, [rows, columns, sort]);

  const cycleSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, direction: "asc" } : s.direction === "asc" ? { key, direction: "desc" } : null));

  const startResize = (e: ReactPointerEvent, col: DataGridColumn<Row>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = widthOf(col);
    beginPointerDrag(e, {
      onStart: () => {
        setDragCursor("resize-x");
        setResizing(col.key);
      },
      onMove: (_ev, d) => {
        const next = { ...latest.current.current, [col.key]: Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, start + d.x))) };
        if (latest.current.onWidthsChange) latest.current.onWidthsChange(next);
        else setLocalWidths(next);
      },
      onEnd: () => setResizing(null),
    });
  };

  const resetWidth = (col: DataGridColumn<Row>) => {
    const next = { ...current };
    delete next[col.key];
    if (onWidthsChange) onWidthsChange(next);
    else setLocalWidths(next);
  };

  const total = columns.reduce((sum, c) => sum + widthOf(c), rowNumbers ? ROWNUM_WIDTH : 0);
  const tableStyle = { "--od-grid-width": `${total}px` } as CSSProperties;
  const interactive = Boolean(onRowActivate || onRowSelect);

  // Only the rows in (and just around) the viewport are drawn; the rest is empty space of the same height (D373).
  // The real height of a row and of the sticky header are measured, so borders never make the space drift.
  const wrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [measured, setMeasured] = useState<{ row: number; header: number }>({ row: 0, header: 0 });
  useLayoutEffect(() => {
    const row = bodyRef.current?.querySelector<HTMLElement>("tr[data-index]")?.getBoundingClientRect().height ?? 0;
    const header = wrapRef.current?.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    setMeasured((m) => (m.row === row && m.header === header ? m : { row, header }));
  });
  const win = useVirtualWindow(wrapRef, {
    count: autoHeight ? 0 : sorted.length,
    rowHeightVar: size === "regular" ? "--table-row-height" : "--grid-row-height",
    rowHeight: measured.row > 0 ? measured.row : undefined,
    header: measured.header,
  });
  const windowed = !autoHeight && win.rowHeight > 0 && win.end - win.start < sorted.length;
  const first = windowed ? win.start : 0;
  const shown = windowed ? sorted.slice(win.start, win.end) : sorted;
  const focusRow = (index: number) => {
    const find = () => bodyRef.current?.querySelector<HTMLElement>(`tr[data-index="${index}"]`);
    const el = find();
    if (el) return el.focus();
    win.reveal(index);
    requestAnimationFrame(() => requestAnimationFrame(() => find()?.focus()));
  };

  return (
    <div ref={wrapRef} className={cx("od-grid-wrap", framed && "od-grid-wrap--framed", autoHeight && "od-grid-wrap--auto", className)}>
      <table
        className={cx("od-grid", `od-grid--${size}`, rowNumbers && "od-grid--numbered", interactive && "od-grid--interactive")}
        aria-label={label}
        aria-rowcount={rows.length}
        style={tableStyle} // od-allow-inline-style: sum of user-dragged column widths
      >
        <colgroup>
          {rowNumbers && <col className="od-grid__col-num" />}
          {columns.map((c) => (
            <col
              key={c.key}
              style={{ width: `${widthOf(c)}px` }} // od-allow-inline-style: user-dragged column width
            />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            {rowNumbers && <th className="od-grid__th od-grid__th--num" scope="col" aria-label="#" />}
            {columns.map((c) => {
              const sortable = c.sortable !== false && Boolean(c.value);
              const dir = sort?.key === c.key ? sort.direction : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cx("od-grid__th", c.numeric && "od-grid__cell--numeric", sortable && "od-grid__th--sortable", dir && "od-grid__th--sorted")}
                  aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : sortable ? "none" : undefined}
                  onClick={sortable ? () => cycleSort(c.key) : undefined}
                >
                  <span className="od-grid__th-inner">
                    <span className="od-grid__th-label">{c.header}</span>
                    {sortable && (
                      <Icon
                        name={dir === "asc" ? "arrow-up" : dir === "desc" ? "arrow-down" : "chevrons-up-down"}
                        size="xs"
                        className={cx("od-grid__sort", dir && "od-grid__sort--on")}
                      />
                    )}
                  </span>
                  {c.resizable !== false && (
                    <span
                      className={cx("od-grid__resizer", resizing === c.key && "od-grid__resizer--active")}
                      onPointerDown={(e) => startResize(e, c)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        resetWidth(c);
                      }}
                    />
                  )}
                </th>
              );
            })}
            <th className="od-grid__th od-grid__th--fill" aria-hidden="true" />
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {windowed && win.before > 0 && <GridGap height={win.before} columns={columns.length + (rowNumbers ? 2 : 1)} />}
          {shown.map((row, shownIndex) => {
            const i = first + shownIndex;
            const key = getRowKey(row, i);
            return (
              <tr
                key={key}
                data-index={i}
                aria-rowindex={i + 1}
                className={cx("od-grid__row", selectedKey === key && "od-grid__row--selected", isRowMuted?.(row) && "od-grid__row--muted")}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? () => (activateOnClick ? onRowActivate?.(row) : onRowSelect?.(row)) : undefined}
                onDoubleClick={onRowActivate && !activateOnClick ? () => onRowActivate(row) : undefined}
                onKeyDown={
                  interactive
                    ? (e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter") onRowActivate?.(row);
                        else if (e.key === "ArrowDown" && i + 1 < sorted.length) focusRow(i + 1);
                        else if (e.key === "ArrowUp" && i > 0) focusRow(i - 1);
                        else return;
                        e.preventDefault();
                      }
                    : undefined
                }
              >
                {rowNumbers && <td className="od-grid__td od-grid__td--num">{i + 1}</td>}
                {columns.map((c) => {
                  const v = c.value?.(row);
                  const isNull = !c.render && (v === null || v === undefined);
                  return (
                    <td
                      key={c.key}
                      className={cx(
                        "od-grid__td",
                        c.numeric && "od-grid__cell--numeric",
                        c.mono && "od-mono",
                        (c.muted || isNull) && "od-grid__td--muted",
                      )}
                    >
                      {c.render ? c.render(row) : isNull ? nullText : String(v)}
                    </td>
                  );
                })}
                <td className="od-grid__td od-grid__td--fill" aria-hidden="true" />
              </tr>
            );
          })}
          {windowed && win.after > 0 && <GridGap height={win.after} columns={columns.length + (rowNumbers ? 2 : 1)} />}
        </tbody>
      </table>
      {rows.length === 0 && empty && <div className="od-grid__empty">{empty}</div>}
    </div>
  );
}
