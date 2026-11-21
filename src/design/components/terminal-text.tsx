import { useRef } from "react";
import { cx } from "./cx";
import { useVirtualWindow } from "./virtual";
import "./terminal-text.css";

export type TerminalTone = "default" | "muted" | "info" | "success" | "warning" | "danger" | "stderr";

export interface TerminalLine {
  text: string;
  /** Tone of this line; absent = default. */
  tone?: TerminalTone;
  /** Which stream the line came from; shown in a narrow gutter when `streamLabels` is given. */
  stream?: "stdout" | "stderr";
}

export interface TerminalTextProps {
  lines: TerminalLine[];
  /** Accessible name of the block (the shell's own words, never an id). */
  label: string;
  /** Draws a gutter that says where each line came from; the texts come from the caller's i18n. */
  streamLabels?: { stdout: string; stderr: string };
  className?: string;
}

/**
 * Output shown like a terminal: dark surface in both themes, one color per line tone. Lines have one fixed height (long lines
 * scroll sideways instead of wrapping), so only the lines in view exist in the page, however many there are (D373).
 */
export function TerminalText({ lines, label, streamLabels, className }: TerminalTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  const win = useVirtualWindow(ref, { count: lines.length, rowHeightVar: "--term-line-height" });
  const visible = lines.slice(win.start, win.end);
  return (
    <div ref={ref} role="region" tabIndex={0} className={cx("od-terminal", className)} aria-label={label} data-testid="terminal-text">
      {win.before > 0 && (
        <div
          className="od-terminal__gap"
          style={{ height: win.before }} // od-allow-inline-style: height of the lines left out above
        />
      )}
      {visible.map((line, i) => {
        const tone = line.tone ?? (line.stream === "stderr" ? "stderr" : "default");
        return (
          <div key={win.start + i} className={cx("od-terminal__line", `od-terminal__line--${tone}`)} data-tone={tone} data-stream={line.stream}>
            {streamLabels ? <span className="od-terminal__stream">{line.stream ? streamLabels[line.stream] : ""}</span> : null}
            <code className="od-terminal__text">{line.text}</code>
          </div>
        );
      })}
      {win.after > 0 && (
        <div
          className="od-terminal__gap"
          style={{ height: win.after }} // od-allow-inline-style: height of the lines left out below
        />
      )}
    </div>
  );
}
