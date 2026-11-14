import type { MouseEvent } from "react";
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

/** Read-only Markdown (GFM: tables, task lists, strikethrough) typeset with tokens. */
export function Markdown({ children, onLinkClick, className }: MarkdownProps) {
  const components: Components = {
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
