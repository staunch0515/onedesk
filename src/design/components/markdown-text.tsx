import { useMemo, type MouseEvent } from "react";
import MarkdownIt from "markdown-it";
import { cx } from "./cx";
import "./markdown.css";

/** Where a `[[name]]` points: `ok` opens it, anything else shows as a broken reference. */
export type ReferenceState = "ok" | "missing" | "deleted";

export interface MarkdownTextProps {
  /** Markdown source, as a plugin's `text` node with `format: "markdown"` gives it (D381). */
  source: string;
  /** Called with the address of a clicked link (only http, https and mailto links exist). */
  onLinkClick: (href: string) => void;
  /** Called with the name inside `[[…]]`. */
  onReferenceClick?: (name: string) => void;
  /** Says what a `[[name]]` points to; without it every reference shows as unresolved. */
  referenceState?: (name: string) => ReferenceState;
  className?: string;
}

/** Links leave the page only as these (same rule as `ui.openExternal`, D380). Everything else is shown as plain text. */
const LINK_SCHEMES = /^(https?:|mailto:)/i;
const MAX_REFERENCE = 200;

interface Env {
  referenceState?: (name: string) => ReferenceState;
}

function createRenderer(): MarkdownIt {
  // `html: false` is the point: raw HTML in the source is shown as text, never turned into elements.
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
  md.validateLink = (url) => LINK_SCHEMES.test(url.trim());

  // `[[name]]`
  md.inline.ruler.before("link", "od_reference", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const name = src.slice(start + 2, end);
    if (name.length === 0 || name.length > MAX_REFERENCE || /[[\]\n]/.test(name) || name.trim() === "") return false;
    if (!silent) {
      const token = state.push("od_reference", "", 0);
      token.content = name;
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules["od_reference"] = (tokens, idx, _options, env: Env) => {
    const name = tokens[idx]!.content;
    const state = env.referenceState?.(name) ?? "missing";
    const cls = state === "ok" ? "od-markdown__ref" : "od-markdown__ref od-markdown__ref--broken";
    return `<a href="#" class="${cls}" data-od-ref="${md.utils.escapeHtml(name)}">${md.utils.escapeHtml(name)}</a>`;
  };

  // Images are not loaded: the alternative text is shown.
  md.renderer.rules.image = (tokens, idx) => `<span class="od-markdown__image-alt">${md.utils.escapeHtml(tokens[idx]!.content)}</span>`;

  // Links: opened by the shell (never in this window).
  md.renderer.rules.link_open = (tokens, idx) => {
    const href = tokens[idx]!.attrGet("href") ?? "";
    return `<a href="${md.utils.escapeHtml(href)}" data-od-link rel="noopener noreferrer">`;
  };

  // Inside a page that already has its h1 every heading moves one level down; the class keeps the written level.
  md.renderer.rules.heading_open = (tokens, idx) => {
    const level = Number(tokens[idx]!.tag.slice(1));
    return `<h${Math.min(level + 1, 6)} class="od-markdown__h${level}">`;
  };
  md.renderer.rules.heading_close = (tokens, idx) => {
    const level = Number(tokens[idx]!.tag.slice(1));
    return `</h${Math.min(level + 1, 6)}>\n`;
  };

  md.renderer.rules.table_open = () => '<div class="od-markdown__table-wrap"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  return md;
}

let shared: MarkdownIt | undefined;

/** The HTML for a source. Exported for tests; nothing else should put this into a page. */
export function renderMarkdown(source: string, referenceState?: (name: string) => ReferenceState): string {
  shared ??= createRenderer();
  const env: Env = { referenceState };
  return shared.render(source, env);
}

/** Read-only Markdown for plugin text: no raw HTML, only http/https/mailto links, `[[references]]`, no images. */
export function MarkdownText({ source, onLinkClick, onReferenceClick, referenceState, className }: MarkdownTextProps) {
  const html = useMemo(() => renderMarkdown(source, referenceState), [source, referenceState]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    e.preventDefault();
    const ref = anchor.getAttribute("data-od-ref");
    if (ref !== null) {
      if (!anchor.classList.contains("od-markdown__ref--broken")) onReferenceClick?.(ref);
      return;
    }
    const href = anchor.getAttribute("href");
    if (href && LINK_SCHEMES.test(href)) onLinkClick(href);
  };
  // The markup comes from markdown-it with raw HTML switched off and every attribute value escaped above.
  // eslint-disable-next-line react/no-danger
  return <div className={cx("od-markdown", className)} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
