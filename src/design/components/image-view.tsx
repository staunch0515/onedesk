import { useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { Button } from "./button";
import { cx } from "./cx";
import { Dialog } from "./dialog";
import "./image-view.css";

export type ImageWidth = "small" | "medium" | "large" | "original";

export interface ImageViewProps {
  /** An address the page may load (an object URL made from a stored file); absent while it is being read. */
  src?: string;
  alt: string;
  width?: ImageWidth;
  /** A line under the image. */
  caption?: string;
  /** Shown instead of the image when it cannot be read. */
  failed?: string;
  /** Says "show large" on the image (accessible name of the button). */
  openLabel: string;
  closeLabel: string;
  /** Shown large from the start (and `onClosed` when that ends); with `hidden`, only the large view exists. */
  startOpen?: boolean;
  onClosed?: () => void;
  hidden?: boolean;
}

/** D484 §16: an image at one of four widths; clicking it shows it large (Esc closes). */
export function ImageView({ src, alt, width = "medium", caption, failed, openLabel, closeLabel, startOpen, onClosed, hidden }: ImageViewProps) {
  const [open, setOpenState] = useState(Boolean(startOpen));
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (!v) onClosed?.();
  };
  const dialog = (
    <Dialog open={open} onOpenChange={setOpen} size="lg" title={alt} footer={<Button onClick={() => setOpen(false)}>{closeLabel}</Button>}>
      {src && <img className="od-image__full" src={src} alt={alt} />}
    </Dialog>
  );
  if (hidden) return dialog;
  return (
    <figure className={cx("od-image", `od-image--${width}`)}>
      {src ? (
        <button type="button" className="od-image__button" aria-label={`${openLabel}: ${alt}`} onClick={() => setOpen(true)}>
          <img className="od-image__img" src={src} alt={alt} />
        </button>
      ) : (
        <div className="od-image__placeholder" role="img" aria-label={alt}>
          {failed ?? "…"}
        </div>
      )}
      {caption && <figcaption className="od-image__caption">{caption}</figcaption>}
      {dialog}
    </figure>
  );
}

export interface ImageDropProps {
  label: string;
  /** What to do here, when there is no image yet. */
  hint: string;
  /** The image shown, when there is one. */
  preview?: ReactNode;
  /** A line about the image (size, type). */
  facts?: string;
  disabled?: boolean;
  busy?: boolean;
  chooseLabel: string;
  removeLabel?: string;
  /** Files dropped or pasted (only images are passed on). */
  onFiles: (files: File[]) => void;
  /** Opens the system dialog. */
  onChoose?: () => void;
  onRemove?: () => void;
}

const images = (list: FileList | null | undefined): File[] => Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));

/** D484 §16: where an image goes: drop one, paste one (the area takes the focus), or choose one. */
export function ImageDrop({ label, hint, preview, facts, disabled, busy, chooseLabel, removeLabel, onFiles, onChoose, onRemove }: ImageDropProps) {
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) {
      const f = images(e.dataTransfer?.files);
      if (f.length > 0) onFiles(f);
    }
  };
  const paste = (e: ClipboardEvent<HTMLDivElement>) => {
    const f = images(e.clipboardData?.files);
    if (f.length > 0 && !disabled) {
      e.preventDefault();
      onFiles(f);
    }
  };
  return (
    <div
      className={cx("od-image-drop", over && "od-image-drop--over")}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      tabIndex={disabled ? -1 : 0}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      onPaste={paste}
    >
      {preview ?? <div className="od-image-drop__hint">{hint}</div>}
      {facts && <div className="od-image-drop__facts">{facts}</div>}
      {!disabled && (
        <div className="od-image-drop__row">
          {onChoose && (
            <Button size="sm" icon="image-plus" loading={busy} onClick={onChoose}>
              {chooseLabel}
            </Button>
          )}
          {onRemove && removeLabel && (
            <Button size="sm" variant="ghost" icon="x" onClick={onRemove}>
              {removeLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
