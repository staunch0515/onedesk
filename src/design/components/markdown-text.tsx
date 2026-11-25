import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ImageView } from "./image-view";
import { Marked, Renderer } from "marked";
import { cx } from "./cx";
import { isOpenableUrl, normalizeLinkHref } from "./open-url";
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
  /** D487 §15: words a `[[name]]` is shown with instead of its name (it still opens what it points to). */
  referenceLabels?: Record<string, string>;
  /**
   * D481: draws a line that is only `![[text]]` (outside code blocks) as an embedded block; it gets the text inside.
   * Without it, and for `![[…]]` inside a sentence, the mark is shown as a reference.
   */
  renderEmbed?: (text: string) => ReactNode;
  /**
   * D484 §16: reads a stored image (`![…](blob:<hash>)`) and gives an address the page may load, or null. Without it
   * (or for any other address) only the alternative text is shown.
   */
  blobUrl?: (blob: string) => Promise<string | null>;
  /** Words for an image: the button that shows it large, and the one that closes it. */
  imageLabels?: { open: string; close: string };
  /**
   * D487 §13: headings go this many levels further down (at most to h6) — text shown under a title of its own, such as
   * one item of a sequence. Default 0.
   */
  headingShift?: number;
  className?: string;
}

const MAX_REFERENCE = 200;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The `[[…]]` states for the render in progress (rendering is synchronous, so one slot is enough). */
let referenceLookup: ((name: string) => ReferenceState) | undefined;
/** D487 §13: how many more levels headings go down in the render in progress. */
let headingShiftNow = 0;
/** D487 §15: the words references are shown with in the render in progress. */
let referenceLabelsNow: Record<string, string> | undefined;

function createRenderer(): Marked {
  const md = new Marked({
    gfm: true,
    breaks: false,
    async: false,
    extensions: [
      {
        // D481: `![[…]]` where it is not a block of its own reads as a reference (the `!` is not shown).
        name: "odEmbedInline",
        level: "inline",
        start: (src: string) => src.indexOf("![["),
        tokenizer(src: string) {
          const m = /^!\[\[([^[\]\n]{1,200})\]\]/.exec(src);
          if (!m || m[1]!.trim() === "" || m[1]!.length > MAX_REFERENCE) return undefined;
          return { type: "odReference", raw: m[0], text: m[1]! };
        },
      },
      {
        name: "odReference",
        level: "inline",
        start: (src: string) => src.indexOf("[["),
        tokenizer(src: string) {
          const m = /^\[\[([^[\]\n]{1,200})\]\]/.exec(src);
          if (!m || m[1]!.trim() === "" || m[1]!.length > MAX_REFERENCE) return undefined;
          return { type: "odReference", raw: m[0], text: m[1]! };
        },
        renderer(token) {
          const name = String(token["text"]);
          const state = referenceLookup?.(name) ?? "missing";
          const cls = state === "ok" ? "od-markdown__ref" : "od-markdown__ref od-markdown__ref--broken";
          const shown = referenceLabelsNow && Object.prototype.hasOwnProperty.call(referenceLabelsNow, name) ? referenceLabelsNow[name]! : name;
          return `<a href="#" class="${cls}" data-od-ref="${escapeHtml(name)}">${escapeHtml(shown)}</a>`;
        },
      },
    ],
    renderer: {
      // Raw HTML (block and inline) is shown as text, never turned into elements.
      html: ({ text }) => escapeHtml(text),
      // Links: opened by the shell, and only when the address is one `openExternal` accepts, judged after decoding.
      link(this: Renderer, { href, tokens }) {
        const text = this.parser.parseInline(tokens);
        const target = normalizeLinkHref(href);
        return isOpenableUrl(target) ? `<a href="${escapeHtml(target)}" data-od-link rel="noopener noreferrer">${text}</a>` : text;
      },
      // Images are not loaded: only the alternative text is shown. D484 §16: a stored image (`blob:<hash>`) gets a place
      // that the component fills once it has read the file.
      image: ({ href, text }) =>
        /^blob:[0-9a-f]{64}$/.test(href)
          ? `<span class="od-markdown__blob" data-od-blob="${href.slice(5)}" data-od-alt="${escapeHtml(text)}"><span class="od-markdown__image-alt">${escapeHtml(text)}</span></span>`
          : `<span class="od-markdown__image-alt">${escapeHtml(text)}</span>`,
      // Inside a page that already has its h1 every heading moves one level down; the class keeps the written level.
      heading(this: Renderer, { tokens, depth }) {
        const level = Math.min(depth + 1 + headingShiftNow, 6);
        return `<h${level} class="od-markdown__h${Math.min(depth + headingShiftNow, 6)}">${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      table(this: Renderer, token) {
        return `<div class="od-markdown__table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`;
      },
    },
  });
  return md;
}

let shared: Marked | undefined;

/** The HTML for a source. Exported for tests; nothing else should put this into a page. */
export function renderMarkdown(source: string, referenceState?: (name: string) => ReferenceState, headingShift = 0, referenceLabels?: Record<string, string>): string {
  shared ??= createRenderer();
  referenceLookup = referenceState;
  headingShiftNow = Math.max(0, Math.min(5, Math.floor(headingShift)));
  referenceLabelsNow = referenceLabels;
  try {
    return shared.parse(source) as string;
  } finally {
    referenceLookup = undefined;
    headingShiftNow = 0;
    referenceLabelsNow = undefined;
  }
}

const EMBED_LINE = /^\s*!\[\[([^[\]\n]{1,200})\]\]\s*$/;

/** D481: the source cut at the lines that are only `![[…]]` (not inside fenced code): Markdown pieces and embeds, in order. */
export function splitEmbeds(source: string): Array<{ markdown: string } | { embed: string }> {
  const out: Array<{ markdown: string } | { embed: string }> = [];
  let chunk: string[] = [];
  let fence = false;
  for (const line of source.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : EMBED_LINE.exec(line);
    if (m && m[1]!.trim() !== "") {
      if (chunk.length > 0) out.push({ markdown: chunk.join("\n") });
      chunk = [];
      out.push({ embed: m[1]! });
    } else chunk.push(line);
  }
  if (chunk.length > 0) out.push({ markdown: chunk.join("\n") });
  return out;
}

/** Read-only Markdown for plugin text: no raw HTML, only http/https/mailto links, `[[references]]`, no images. */
export function MarkdownText({ source, onLinkClick, onReferenceClick, referenceState, referenceLabels, renderEmbed, blobUrl, imageLabels, headingShift, className }: MarkdownTextProps) {
  const parts = useMemo(() => (renderEmbed ? splitEmbeds(source) : null), [source, renderEmbed]);
  if (parts && parts.some((p) => "embed" in p)) {
    return (
      <div className={cx("od-markdown-flow", className)}>
        {parts.map((p, i) =>
          "embed" in p ? (
            <Fragment key={i}>{renderEmbed!(p.embed)}</Fragment>
          ) : (
            <MarkdownHtml key={i} source={p.markdown} onLinkClick={onLinkClick} onReferenceClick={onReferenceClick} referenceState={referenceState} referenceLabels={referenceLabels} blobUrl={blobUrl} imageLabels={imageLabels} headingShift={headingShift} />
          ),
        )}
      </div>
    );
  }
  return <MarkdownHtml source={source} onLinkClick={onLinkClick} onReferenceClick={onReferenceClick} referenceState={referenceState} referenceLabels={referenceLabels} blobUrl={blobUrl} imageLabels={imageLabels} headingShift={headingShift} className={className} />;
}

function MarkdownHtml({ source, onLinkClick, onReferenceClick, referenceState, referenceLabels, blobUrl, imageLabels, headingShift, className }: Omit<MarkdownTextProps, "renderEmbed">) {
  const html = useMemo(() => renderMarkdown(source, referenceState, headingShift, referenceLabels), [source, referenceState, headingShift, referenceLabels]);
  const box = useRef<HTMLDivElement>(null);
  const [large, setLarge] = useState<{ src: string; alt: string } | null>(null);
  // D484 §16: fill each stored image's place with the image (an element made here, not markup).
  useEffect(() => {
    const root = box.current;
    if (!root || !blobUrl) return;
    let gone = false;
    root.querySelectorAll<HTMLElement>("[data-od-blob]").forEach((place) => {
      const blob = place.getAttribute("data-od-blob") ?? "";
      const alt = place.getAttribute("data-od-alt") ?? "";
      void blobUrl(blob).then((url) => {
        if (gone || !url) return;
        const img = document.createElement("img");
        img.className = "od-markdown__img";
        img.src = url;
        img.alt = alt;
        place.replaceChildren(img);
      });
    });
    return () => {
      gone = true;
    };
  }, [html, blobUrl]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const img = (e.target as HTMLElement).closest("img.od-markdown__img") as HTMLImageElement | null;
    if (img) {
      setLarge({ src: img.src, alt: img.alt });
      return;
    }
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    e.preventDefault();
    const ref = anchor.getAttribute("data-od-ref");
    if (ref !== null) {
      if (!anchor.classList.contains("od-markdown__ref--broken")) onReferenceClick?.(ref);
      return;
    }
    const href = anchor.getAttribute("href");
    if (href && isOpenableUrl(href)) onLinkClick(href);
  };
  // The markup comes from `marked` with every raw HTML token escaped by the renderer above and every attribute value escaped.
  // eslint-disable-next-line react/no-danger
  return (
    <>
      <div ref={box} className={cx("od-markdown", className)} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {large && imageLabels && <LargeImage {...large} labels={imageLabels} onClose={() => setLarge(null)} />}
    </>
  );
}

/** A Markdown image shown large (the same dialog an image node uses). */
function LargeImage({ src, alt, labels, onClose }: { src: string; alt: string; labels: { open: string; close: string }; onClose: () => void }) {
  return <ImageView src={src} alt={alt} openLabel={labels.open} closeLabel={labels.close} startOpen onClosed={onClose} hidden />;
}
