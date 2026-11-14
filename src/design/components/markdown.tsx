import type { MouseEvent, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "./cx";
import "./markdown.css";

export interface MarkdownProps {
  /** Markdown source. Raw HTML is dropped, never rendered. */
  children: string;
  /**
   * Called instead of navigating when a link is clicked (e.g. open in the system browser).
   * Without it links get target=_blank + rel=noopener noreferrer.
   */
  onLinkClick?: (href: string) => void;
  className?: string;
}

type HeadingTag = "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * Markdown sits inside a page that already has its h1: every heading level moves down one (h1→h2 … h6 stays h6)
 * for the document outline, while the class keeps the visual size of the level the author wrote.
 */
function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${Math.min(level + 1, 6)}` as HeadingTag;
  return function Heading({ children: content }: { children?: ReactNode }) {
    return <Tag className={`od-markdown__h${level}`}>{content}</Tag>;
  };
}

const HEADINGS = { h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6) };

/** Read-only Markdown (GFM: tables, task lists, strikethrough) typeset with tokens. */
export function Markdown({ children, onLinkClick, className }: MarkdownProps) {
  const components: Components = {
    ...HEADINGS,
    a: ({ href, children: content }) => {
      const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
        if (!onLinkClick || !href) return;
        e.preventDefault();
        onLinkClick(href);
      };
      return (
        <a href={href} onClick={onClick} target={onLinkClick ? undefined : "_blank"} rel="noopener noreferrer">
          {content}
        </a>
      );
    },
    table: ({ children: content }) => (
      <div className="od-markdown__table-wrap">
        <table>{content}</table>
      </div>
    ),
  };
  return (
    <div className={cx("od-markdown", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
