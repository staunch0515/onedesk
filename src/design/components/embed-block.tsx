import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./embed-block.css";

export interface EmbedBlockProps {
  /** What is embedded, as shown in the head: the resource's name, and the section after it. */
  title: string;
  icon?: string;
  /** A muted word after the title (the kind). */
  kind?: string;
  /** Opens the resource; without it the title is plain text. */
  onOpen?: () => void;
  /** Shown when the pointer rests on the title (e.g. where the resource is). */
  place?: string;
  /** The reference cannot be shown (gone, too deep): drawn muted, with a red edge. */
  broken?: boolean;
  /** A muted line under the content (e.g. "section not found"). */
  note?: string;
  children?: ReactNode;
}

/** D481: another resource's content inside this one, read only, with a head that opens it. */
export function EmbedBlock({ title, icon, kind, onOpen, place, broken, note, children }: EmbedBlockProps) {
  return (
    <figure className={cx("od-embed", broken && "od-embed--broken")} aria-label={title}>
      <figcaption className="od-embed__head">
        {onOpen ? (
          <button type="button" className="od-embed__title" title={place} onClick={onOpen}>
            {icon && <Icon name={icon} size="sm" />}
            {title}
          </button>
        ) : (
          <span className="od-embed__title">
            {icon && <Icon name={icon} size="sm" />}
            {title}
          </span>
        )}
        {kind && <span>{kind}</span>}
      </figcaption>
      {children}
      {note && <div className="od-embed__note">{note}</div>}
    </figure>
  );
}
