import { useMemo, useState } from "react";
import { cx } from "./cx";
import { lineDiff, type DiffLine, type DiffPart } from "./diff";
import { Button } from "./button";
import "./diff-view.css";

/** A table's column, for comparing rows. */
export interface DiffColumn {
  name: string;
  label: string;
}

export type DiffLayout = "split" | "stacked";

export interface DiffViewProps {
  /** Names the comparison (for assistive technology). */
  label: string;
  /** `text`: by line; `value`: one value before and after; `rows`: a table's rows, one line each. */
  kind: "text" | "value" | "rows";
  before: unknown;
  after: unknown;
  columns?: DiffColumn[];
  /** Side by side, or one above the other; the reader can switch (texts and rows only). */
  layout?: DiffLayout;
  onLayoutChange?: (layout: DiffLayout) => void;
  labels: { before: string; after: string; split: string; stacked: string; empty: string; added: string; removed: string; same: string };
}

/** A value as a line of text: texts as they are, lists joined, the rest as JSON. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
  return JSON.stringify(v);
}

/** Rows of a table as lines: `column: value · column: value`. */
function rowsText(v: unknown, columns: DiffColumn[] | undefined): string {
  if (!Array.isArray(v)) return valueText(v);
  return v
    .map((row) => {
      if (!row || typeof row !== "object") return valueText(row);
      const r = row as Record<string, unknown>;
      const cols = columns && columns.length > 0 ? columns : Object.keys(r).map((name) => ({ name, label: name }));
      return cols.map((c) => `${c.label}: ${valueText(r[c.name])}`).join(" · ");
    })
    .join("\n");
}

function Parts({ parts, text }: { parts?: DiffPart[]; text?: string }) {
  if (!parts) return <>{text ?? ""}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "same" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <mark key={i} className={cx("od-diff__mark", `od-diff__mark--${p.kind}`)}>
            {p.text}
          </mark>
        ),
      )}
    </>
  );
}

function Sign({ op, side, labels }: { op: DiffLine["op"]; side: "before" | "after" | "one"; labels: DiffViewProps["labels"] }) {
  const removed = op === "removed" || (op === "changed" && side === "before");
  const added = op === "added" || (op === "changed" && side === "after");
  const sign = removed ? "−" : added ? "+" : " ";
  const word = removed ? labels.removed : added ? labels.added : labels.same;
  return (
    <span className="od-diff__sign" aria-label={word} role="img">
      {sign}
    </span>
  );
}

/**
 * D487 §29.3: what was and what is, compared — a text by line with the changed characters marked (side by side, or
 * one above the other), a value as before → after, a table's rows by row.
 */
export function DiffView({ label, kind, before, after, columns, layout, onLayoutChange, labels }: DiffViewProps) {
  const [own, setOwn] = useState<DiffLayout>("split");
  const mode = layout ?? own;
  const setMode = (l: DiffLayout) => (onLayoutChange ? onLayoutChange(l) : setOwn(l));
  const lines = useMemo(() => {
    if (kind === "value") return [];
    const a = kind === "rows" ? rowsText(before, columns) : valueText(before);
    const b = kind === "rows" ? rowsText(after, columns) : valueText(after);
    return lineDiff(a, b);
  }, [kind, before, after, columns]);

  if (kind === "value") {
    const a = valueText(before);
    const b = valueText(after);
    return (
      <div className="od-diff od-diff--value" role="group" aria-label={label}>
        <div className="od-diff__value od-diff__value--before">
          <span className="od-diff__caption">{labels.before}</span>
          {a === "" ? <span className="od-diff__empty">{labels.empty}</span> : <del>{a}</del>}
        </div>
        <span className="od-diff__arrow" aria-hidden="true">
          →
        </span>
        <div className="od-diff__value od-diff__value--after">
          <span className="od-diff__caption">{labels.after}</span>
          {b === "" ? <span className="od-diff__empty">{labels.empty}</span> : <ins>{b}</ins>}
        </div>
      </div>
    );
  }

  return (
    <div className={cx("od-diff", `od-diff--${mode}`)} role="group" aria-label={label}>
      <div className="od-diff__bar">
        {(["split", "stacked"] as const).map((l) => (
          <Button key={l} size="sm" variant={mode === l ? "secondary" : "ghost"} aria-pressed={mode === l} onClick={() => setMode(l)}>
            {l === "split" ? labels.split : labels.stacked}
          </Button>
        ))}
      </div>
      {lines.length === 0 ? (
        <p className="od-diff__empty">{labels.empty}</p>
      ) : mode === "split" ? (
        <table className="od-diff__table">
          <colgroup>
            <col className="od-diff__col-no" />
            <col className="od-diff__col-sign" />
            <col />
            <col className="od-diff__col-no" />
            <col className="od-diff__col-sign" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" colSpan={3}>
                {labels.before}
              </th>
              <th scope="col" colSpan={3}>
                {labels.after}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={`od-diff__row od-diff__row--${l.op}`}>
                <td className="od-diff__no">{l.beforeNo ?? ""}</td>
                <td className="od-diff__sign-cell">{l.before !== undefined && <Sign op={l.op} side="before" labels={labels} />}</td>
                <td className={cx("od-diff__cell", l.before !== undefined && l.op !== "same" && "od-diff__cell--removed")}>
                  <Parts parts={l.beforeParts} text={l.before} />
                </td>
                <td className="od-diff__no">{l.afterNo ?? ""}</td>
                <td className="od-diff__sign-cell">{l.after !== undefined && <Sign op={l.op} side="after" labels={labels} />}</td>
                <td className={cx("od-diff__cell", l.after !== undefined && l.op !== "same" && "od-diff__cell--added")}>
                  <Parts parts={l.afterParts} text={l.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="od-diff__table">
          <colgroup>
            <col className="od-diff__col-no" />
            <col className="od-diff__col-no" />
            <col className="od-diff__col-sign" />
            <col />
          </colgroup>
          <tbody>
            {lines.flatMap((l, i) => {
              const rows = [];
              if (l.op === "same") {
                rows.push(
                  <tr key={`${i}s`} className="od-diff__row od-diff__row--same">
                    <td className="od-diff__no">{l.beforeNo}</td>
                    <td className="od-diff__no">{l.afterNo}</td>
                    <td className="od-diff__sign-cell">
                      <Sign op="same" side="one" labels={labels} />
                    </td>
                    <td className="od-diff__cell">{l.before}</td>
                  </tr>,
                );
                return rows;
              }
              if (l.before !== undefined)
                rows.push(
                  <tr key={`${i}b`} className="od-diff__row od-diff__row--removed">
                    <td className="od-diff__no">{l.beforeNo}</td>
                    <td className="od-diff__no" />
                    <td className="od-diff__sign-cell">
                      <Sign op={l.op} side="before" labels={labels} />
                    </td>
                    <td className="od-diff__cell od-diff__cell--removed">
                      <Parts parts={l.beforeParts} text={l.before} />
                    </td>
                  </tr>,
                );
              if (l.after !== undefined)
                rows.push(
                  <tr key={`${i}a`} className="od-diff__row od-diff__row--added">
                    <td className="od-diff__no" />
                    <td className="od-diff__no">{l.afterNo}</td>
                    <td className="od-diff__sign-cell">
                      <Sign op={l.op} side="after" labels={labels} />
                    </td>
                    <td className="od-diff__cell od-diff__cell--added">
                      <Parts parts={l.afterParts} text={l.after} />
                    </td>
                  </tr>,
                );
              return rows;
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
