import { cx } from "./cx";
import "./terminal-text.css";

export type TerminalTone = "default" | "muted" | "info" | "success" | "warning" | "danger" | "stderr";

export interface TerminalLine {
  text: string;
  /** Tone of this line; absent = default. */
  tone?: TerminalTone;
  /** Which stream the line came from; shown in a narrow gutter when `showStreams` is on. */
  stream?: "stdout" | "stderr";
}

export interface TerminalTextProps {
  lines: TerminalLine[];
  /** Accessible name of the block. */
  label?: string;
  /** Draw a gutter that says where each line came from (`out` / `err`). */
  showStreams?: boolean;
  /** Texts for the gutter, from the shell's i18n. */
  streamLabels?: { stdout: string; stderr: string };
  className?: string;
}

/** Output shown like a terminal: dark surface in both themes, one color per line tone. */
export function TerminalText({ lines, label, showStreams, streamLabels = { stdout: "out", stderr: "err" }, className }: TerminalTextProps) {
  return (
    <pre className={cx("od-terminal", className)} aria-label={label} data-testid="terminal-text">
      {lines.map((line, i) => {
        const tone = line.tone ?? (line.stream === "stderr" ? "stderr" : "default");
        return (
          <div key={i} className={cx("od-terminal__line", `od-terminal__line--${tone}`)} data-tone={tone} data-stream={line.stream}>
            {showStreams ? (
              <span className="od-terminal__stream" aria-label={line.stream ? streamLabels[line.stream] : undefined}>
                {line.stream ? streamLabels[line.stream] : ""}
              </span>
            ) : null}
            <code className="od-terminal__text">{line.text === "" ? "​" : line.text}</code>
          </div>
        );
      })}
    </pre>
  );
}
