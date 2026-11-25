import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { Textarea } from "./textarea";
import "./chat.css";

/** D479: the column a conversation's turns and input sit in. Its end (the latest turn, the box) is kept in view. */
export function Chat({ label, turns, children }: { label: string; turns: number; children: ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (turns > 0) end.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns]);
  return (
    <section className="od-chat" aria-label={label}>
      {children}
      <div ref={end} />
    </section>
  );
}

/** D479: one look-up shown before an answer; it opens to what was asked and found. */
export interface ChatStep {
  label: string;
  detail?: string;
  failed?: boolean;
}

export interface ChatTurnProps {
  role: "user" | "assistant";
  /** Who said it, as shown ("Me", "AI"). */
  who: string;
  note?: string;
  /** Buttons under the turn. */
  actions?: ReactNode;
  /** What was looked up before this answer, in order. */
  steps?: ChatStep[];
  children: ReactNode;
}

/** One turn of a conversation. */
export function ChatTurn({ role, who, note, actions, steps, children }: ChatTurnProps) {
  return (
    <article className={cx("od-chat-turn", role === "user" && "od-chat-turn--user")} aria-label={who}>
      <div className="od-chat-turn__who">{who}</div>
      {steps && steps.length > 0 && (
        <ul className="od-chat-steps">
          {steps.map((s, i) => (
            <li key={i}>
              <details className={cx("od-chat-step", s.failed && "od-chat-step--failed")}>
                <summary className="od-chat-step__label">{s.label}</summary>
                {s.detail && <pre className="od-chat-step__detail od-mono">{s.detail}</pre>}
              </details>
            </li>
          ))}
        </ul>
      )}
      {children}
      {note && <div className="od-chat-turn__note">{note}</div>}
      {actions && <div className="od-chat-turn__actions">{actions}</div>}
    </article>
  );
}

export interface ChatInputProps {
  label: string;
  value: string;
  placeholder?: string;
  /** Under the box, e.g. "Enter sends · Shift+Enter: new line". */
  hint?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Enter without Shift (and not while an input method is composing). */
  onSend: () => void;
}

/** The input box of a conversation: Enter sends, Shift+Enter starts a new line. */
export function ChatInput({ label, value, placeholder, hint, disabled, onChange, onSend }: ChatInputProps) {
  return (
    <div className="od-chat-input">
      <Textarea
        aria-label={label}
        rows={3}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (!disabled) onSend();
        }}
      />
      {hint && <div className="od-chat-input__hint">{hint}</div>}
    </div>
  );
}
