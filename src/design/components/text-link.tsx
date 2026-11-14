import type { MouseEvent, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./text-link.css";

export interface TextLinkProps {
  href: string;
  children: ReactNode;
  /**
   * Called instead of navigating (e.g. open in the system browser through the host).
   * Without it the link opens in a new window with rel=noopener noreferrer.
   */
  onOpen?: (href: string) => void;
  /** Shows a small external-link icon after the text. */
  external?: boolean;
  className?: string;
}

/** Inline text link (accent colour, underline on hover, visible focus ring). */
export function TextLink({ href, children, onOpen, external = false, className }: TextLinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen) return;
    e.preventDefault();
    onOpen(href);
  };
  return (
    <a className={cx("od-text-link", className)} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      <span className="od-text-link__text">{children}</span>
      {external && <Icon name="external-link" size="xs" className="od-text-link__icon" />}
    </a>
  );
}
