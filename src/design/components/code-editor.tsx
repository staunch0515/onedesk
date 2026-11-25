import { useMemo, useRef, type KeyboardEvent, type ReactNode, type Ref, type UIEvent, type ClipboardEvent, type DragEvent } from "react";
import { cx } from "./cx";
import "./code-editor.css";

export type CodeTokenKind = "keyword" | "string" | "number" | "comment" | "param" | "function" | "operator";
export interface CodeToken {
  text: string;
  kind?: CodeTokenKind;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Splits the text into coloured tokens. Without it the text is plain. */
  tokenize?: (code: string) => CodeToken[];
  readOnly?: boolean;
  /** Accessible name. */
  label: string;
  placeholder?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** D484 §16: pasting or dropping (e.g. images) into the text. */
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: DragEvent<HTMLTextAreaElement>) => void;
  /** fill: takes all remaining height of a flex column parent (I.7). auto: grows with the content. */
  height?: "fill" | "auto";
  /** Draw a border (when it is not edge-to-edge). */
  framed?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
  className?: string;
}

const INDENT = "  ";

/**
 * Plain code editor: a textarea over a highlighted copy of the same text, with line numbers.
 * Typing stays entirely in the browser; nothing is computed per keystroke except the token colours.
 */
export function CodeEditor({ value, onChange, tokenize, readOnly, label, placeholder, onKeyDown, onPaste, onDrop, height = "fill", framed, ref, className }: CodeEditorProps) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const tokens = useMemo<ReactNode>(() => {
    if (!tokenize) return value;
    return tokenize(value).map((t, i) =>
      t.kind ? (
        <span key={i} className={`od-code__tok--${t.kind}`}>
          {t.text}
        </span>
      ) : (
        t.text
      ),
    );
  }, [value, tokenize]);

  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join("\n"), [lineCount]);

  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || readOnly) return;
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // execCommand keeps the native undo stack; a state update would reset it.
      if (!document.execCommand("insertText", false, INDENT)) {
        const el = e.currentTarget;
        const next = el.value.slice(0, el.selectionStart) + INDENT + el.value.slice(el.selectionEnd);
        onChange?.(next);
      }
    }
  };

  return (
    <div className={cx("od-code", "od-mono", `od-code--${height}`, framed && "od-code--framed", readOnly && "od-code--readonly", className)}>
      <div ref={gutterRef} className="od-code__gutter" aria-hidden="true">
        <pre className="od-code__numbers">{numbers}</pre>
      </div>
      <div className="od-code__body">
        <pre ref={highlightRef} className="od-code__highlight" aria-hidden="true">
          {tokens}
          {"\n"}
        </pre>
        <textarea
          ref={ref}
          className="od-code__input"
          value={value}
          readOnly={readOnly}
          aria-label={label}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          rows={height === "auto" ? Math.max(3, lineCount) : undefined}
          onChange={(e) => onChange?.(e.target.value)}
          onPaste={onPaste}
          onDrop={onDrop}
          onScroll={onScroll}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
