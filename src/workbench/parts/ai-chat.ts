import type { AssistProvider, ViewNode } from "../protocol";
import { useQuery } from "../state/context";
import type { UiState } from "../state/store";

/**
 * D479 (docs/redesign/ai-chat.md): the shell's part of AI chats. The conversation itself is a plugin page; the shell
 * offers the one "AI chat" button, draws the conversation node, hands the target tab's unsaved values to a send, and
 * puts an answer's changes into the target page as unsaved changes.
 */

/** The writing-help provider, or null when none is installed and enabled (asked again when plugins change). */
export function useAssistProvider(): AssistProvider | null {
  const q = useQuery((c) => (c.assist ? c.assist.provider().catch(() => null) : Promise.resolve(null)), [], ["plugins"]);
  return q.data?.available && q.data.command ? q.data : null;
}

export type ConversationNode = Extract<ViewNode, { type: "conversation" }>;

export function conversationOf(view: ViewNode[]): ConversationNode | undefined {
  return view.find((n): n is ConversationNode => n.type === "conversation");
}

/**
 * What goes along with a run started on a conversation page about another tab: that tab's values as the person sees
 * them (saved values under what is typed) and the description typed in its info panel. Only fields the tab's page
 * showed, never a secret; nothing when the tab is not open.
 */
export function targetInput(s: Pick<UiState, "bases" | "drafts" | "fieldKinds">, tabId: string): Record<string, unknown> {
  const kinds = s.fieldKinds[tabId];
  if (!kinds) return {};
  const typed = s.drafts[tabId] ?? {};
  const values = { ...(s.bases[tabId] ?? {}), ...typed };
  const draft = Object.fromEntries(
    Object.entries(values).filter(([bind, v]) => kinds[bind] !== undefined && kinds[bind] !== "secret" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")),
  );
  const description = typed.description;
  return { "target.draft": draft, ...(typeof description === "string" ? { "target.description": description } : {}) };
}

/** Which of `values` would replace something typed on the tab and not yet saved. */
export function clashes(typed: Record<string, unknown> | undefined, values: Record<string, unknown>): string[] {
  return Object.keys(values).filter((k) => typed !== undefined && k in typed && typed[k] !== values[k]);
}
