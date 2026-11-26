import { Fragment, type ReactNode } from "react";
import "./flow-text.css";

/** A piece of a flow: Markdown text, or a control (a `block` one gets a paragraph of its own). */
export type FlowPiece = { text: string } | { key: string; control: ReactNode; block?: boolean };

export interface FlowTextProps {
  pieces: FlowPiece[];
  /** Draws a run of Markdown; `inline` when it shares its line with controls. */
  renderText: (source: string, inline: boolean) => ReactNode;
}

type Line = Array<{ text: string } | { key: string; control: ReactNode }>;

/**
 * D487 §23 (K4): text with input controls in it, like a form printed with blanks to fill. Lines without controls are
 * ordinary Markdown; a line with controls flows them in among its words.
 */
export function FlowText({ pieces, renderText }: FlowTextProps) {
  const out: ReactNode[] = [];
  let prose: string[] = [];
  let line: Line = [];
  const flushProse = () => {
    if (prose.join("\n").trim()) out.push(<div key={`p${out.length}`} className="od-flow__prose">{renderText(prose.join("\n"), false)}</div>);
    prose = [];
  };
  const endLine = () => {
    if (line.some((p) => "control" in p)) {
      flushProse();
      out.push(
        <div key={`l${out.length}`} className="od-flow__line">
          {line.map((p, i) => ("control" in p ? <span key={p.key} className="od-flow__control">{p.control}</span> : p.text ? <span key={i} className="od-flow__text">{renderText(p.text, true)}</span> : <Fragment key={i} />))}
        </div>,
      );
    } else {
      prose.push(line.map((p) => ("text" in p ? p.text : "")).join(""));
    }
    line = [];
  };
  for (const p of pieces) {
    if ("text" in p) {
      const parts = p.text.split("\n");
      parts.forEach((t, i) => {
        if (i > 0) endLine();
        line.push({ text: t });
      });
    } else if (p.block) {
      endLine();
      flushProse();
      out.push(<div key={p.key} className="od-flow__block">{p.control}</div>);
    } else {
      line.push({ key: p.key, control: p.control });
    }
  }
  endLine();
  flushProse();
  return <div className="od-flow">{out}</div>;
}
