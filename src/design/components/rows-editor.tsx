import type { KeyboardEvent, ReactNode } from "react";
import { IconButton } from "./icon-button";
import "./rows-editor.css";

export interface RowsEditorColumn {
  name: string;
  label: string;
  /** Read only: the page computes it. */
  readOnly?: boolean;
  /** `sm`, `md` (default) or `lg`. */
  width?: "sm" | "md" | "lg";
}

export type RowsEditorRow = Record<string, unknown>;

export interface RowsEditorProps {
  label: string;
  columns: RowsEditorColumn[];
  rows: RowsEditorRow[];
  readOnly?: boolean;
  /** The control of one cell (an input, a select…), already bound to its value. */
  renderCell: (row: number, column: RowsEditorColumn, value: unknown, set: (v: unknown) => void) => ReactNode;
  onChange: (rows: RowsEditorRow[]) => void;
  addLabel: string;
  removeLabel: string;
  upLabel: string;
  downLabel: string;
  emptyLabel: string;
}

/**
 * D487 §27 (K15): a table to fill in — the lines of a form (a receipt's items, an order's lines). Add, remove and move
 * lines; each cell is the page's own control. Enter in the last cell of the last line adds a line.
 */
export function RowsEditor({ label, columns, rows, readOnly, renderCell, onChange, addLabel, removeLabel, upLabel, downLabel, emptyLabel }: RowsEditorProps) {
  const set = (i: number, name: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [name]: v } : r)));
  const add = () => onChange([...rows, {}]);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (readOnly || e.key !== "Enter" || e.shiftKey) return;
    const cells = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-cell]"));
    if (cells.length && cells[cells.length - 1]!.contains(e.target as Node)) {
      e.preventDefault();
      add();
    }
  };
  return (
    <div className="od-rows" role="group" aria-label={label}>
      <table className="od-rows__table">
        <thead>
          <tr>
            <th className="od-rows__num" aria-hidden="true">#</th>
            {columns.map((c) => (
              <th key={c.name} className={`od-rows__head od-rows__head--${c.width ?? "md"}`}>
                {c.label}
              </th>
            ))}
            {!readOnly && <th className="od-rows__tools" aria-hidden="true" />}
          </tr>
        </thead>
        <tbody onKeyDown={onKey}>
          {rows.length === 0 && (
            <tr>
              <td className="od-rows__empty" colSpan={columns.length + 2}>
                {emptyLabel}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="od-rows__num">{i + 1}</td>
              {columns.map((c) => (
                <td key={c.name} className="od-rows__cell" data-cell="">
                  {renderCell(i, c, r[c.name], (v) => set(i, c.name, v))}
                </td>
              ))}
              {!readOnly && (
                <td className="od-rows__tools">
                  <IconButton icon="arrow-up" label={upLabel} size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="arrow-down" label={downLabel} size="sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon="x" label={removeLabel} size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div className="od-rows__add">
          <IconButton icon="plus" label={addLabel} size="sm" onClick={add} />
          <span className="od-rows__add-label">{addLabel}</span>
        </div>
      )}
    </div>
  );
}
