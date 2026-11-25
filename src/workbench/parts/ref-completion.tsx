import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CodeEditor, SuggestAnchor, SuggestList, Textarea, type CodeEditorProps, type TextareaProps } from "../../design";
import { useI18n } from "../i18n";
import type { RefSuggestion } from "../protocol";
import { useWorkbench } from "../state/context";

/**
 * D482 (docs/redesign/embed-book.md §18.4): while typing `[[`, `![[` or `[[=` in a field where references are written
 * (`ViewField.refs`), the candidates come up; picking one writes the shortest text that means only it, and the `]]`.
 */

/** The reference being typed at the caret: where its text starts, and what has been typed (no section or parameters yet). */
export function openMark(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf("[[");
  if (open < 0 || (open > 0 && before[open - 1] === "\\")) return null;
  let start = open + 2;
  let query = before.slice(start);
  if (query.includes("]]") || query.includes("\n") || query.length > 200) return null;
  if (query.startsWith("=")) {
    start += 1;
    query = query.slice(1);
  }
  // Once a section or parameters are being written, the name is chosen.
  if (/(^|[^\\])[#|]/.test(query)) return null;
  return { start, query };
}

/** The text with the reference's text replaced by `write` and closed; and where the caret goes (after the `]]`). */
export function insertPick(text: string, caret: number, start: number, write: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const close = after.startsWith("]]") ? "" : "]]";
  return { text: text.slice(0, start) + write + close + after, caret: start + write.length + 2 };
}

const DEBOUNCE_MS = 150;

function useRefCompletion(onValue: (value: string) => void) {
  const { client } = useWorkbench();
  const { t, tx } = useI18n();
  const el = useRef<HTMLTextAreaElement>(null);
  const [mark, setMark] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<RefSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const dismissed = useRef<number | null>(null);

  const look = () => {
    const ta = el.current;
    if (!ta) return;
    const m = openMark(ta.value, ta.selectionStart);
    if (!m || m.start !== dismissed.current) dismissed.current = null;
    setMark(m && m.start !== dismissed.current ? m : null);
  };

  useEffect(() => {
    if (!mark || !client.refs.suggest) return;
    let gone = false;
    const timer = setTimeout(() => {
      client.refs.suggest!(mark.query, 10).then((list) => {
        if (gone) return;
        setItems(list);
        setActive(0);
      }, () => !gone && setItems([]));
    }, DEBOUNCE_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [mark?.query, mark?.start, client]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (i: number) => {
    const ta = el.current;
    const s = items[i];
    if (!ta || !mark || !s) return;
    const r = insertPick(ta.value, ta.selectionStart, mark.start, s.write);
    onValue(r.text);
    setMark(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.caret, r.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mark) return;
    if (e.key === "Escape") {
      e.preventDefault();
      dismissed.current = mark.start;
      setMark(null);
      return;
    }
    if (items.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(active);
    }
  };

  const list =
    mark && client.refs.suggest ? (
      <SuggestList
        label={t("refs.suggestLabel")}
        empty={t("refs.suggestEmpty")}
        active={active}
        onHover={setActive}
        onPick={pick}
        items={items.map((s) => ({
          key: s.id,
          icon: s.icon,
          title: s.write === s.name ? s.name : s.write,
          detail: [s.kindLabel ? tx(s.kindLabel) : "", s.path.join(" › ")].filter(Boolean).join(" · "),
        }))}
      />
    ) : null;
  return { el, look, onKeyDown, list, close: () => setMark(null) };
}

/** A text box where references are written. */
export function RefTextarea({ onValue, ...rest }: Omit<TextareaProps, "onChange" | "ref"> & { onValue: (value: string) => void }) {
  const c = useRefCompletion(onValue);
  return (
    <SuggestAnchor>
      <Textarea
        {...rest}
        ref={c.el}
        onChange={(e) => {
          onValue(e.target.value);
          c.look();
        }}
        onKeyDown={c.onKeyDown}
        onKeyUp={(e) => !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && c.look()}
        onClick={c.look}
        onBlur={c.close}
      />
      {c.list}
    </SuggestAnchor>
  );
}

/** The code editor where references are written (a note that fills the page). */
export function RefCodeEditor({ onChange, ...rest }: Omit<CodeEditorProps, "ref" | "onKeyDown">) {
  const c = useRefCompletion((v) => onChange?.(v));
  return (
    <SuggestAnchor fill={rest.height !== "auto"}>
      <CodeEditor
        {...rest}
        ref={c.el}
        onChange={(v) => {
          onChange?.(v);
          requestAnimationFrame(c.look);
        }}
        onKeyDown={c.onKeyDown}
      />
      {c.list}
    </SuggestAnchor>
  );
}
