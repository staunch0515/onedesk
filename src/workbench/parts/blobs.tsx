import { createContext, useCallback, useContext, useState } from "react";
import { ImageDrop, ImageView, type ImageWidth } from "../../design";
import { useI18n } from "../i18n";
import type { BlobInfo, ProtocolClient } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";

/**
 * D484 §16 (docs/redesign/documents.md): images kept by their content. The page says which resource it shows
 * (`BlobScope`): the kernel gives a file only for a resource that uses it, or to the client that just put it.
 */
export const BlobScope = createContext<string | undefined>(undefined);

/** What an attachment field holds. */
export interface Attachment {
  blob: string;
  name?: string;
  type: string;
  size: number;
  width?: number;
  height?: number;
}

export const isAttachment = (v: unknown): v is Attachment => typeof v === "object" && v !== null && typeof (v as Attachment).blob === "string";

const urls = new Map<string, Promise<string | null>>();

/** An address for a stored file, read once per resource and file. */
export function blobUrl(client: ProtocolClient, blob: string, resource?: string): Promise<string | null> {
  const key = `${resource ?? ""}:${blob}`;
  let p = urls.get(key);
  if (!p) {
    p = client.blob
      ? client.blob.read(blob, resource).then(
          (d) => {
            const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
            return URL.createObjectURL(new Blob([bytes], { type: d.type }));
          },
          () => {
            urls.delete(key);
            return null;
          },
        )
      : Promise.resolve(null);
    urls.set(key, p);
  }
  return p;
}

/** `blobUrl` for the resource of this place (for Markdown). */
export function useBlobUrl(): (blob: string) => Promise<string | null> {
  const { client } = useWorkbench();
  const resource = useContext(BlobScope);
  return useCallback((blob: string) => blobUrl(client, blob, resource), [client, resource]);
}

export function useImageLabels() {
  const { t } = useI18n();
  return { open: t("image.open"), close: t("common.close") };
}

/** An image view node. */
export function BlobImage({ blob, alt, width, caption }: { blob: string; alt?: string; width?: ImageWidth; caption?: string }) {
  const { client } = useWorkbench();
  const { t } = useI18n();
  const resource = useContext(BlobScope);
  const q = useQuery(() => blobUrl(client, blob, resource), [blob, resource], resource ? [`resource:${resource}`] : []);
  return <ImageView src={q.data ?? undefined} alt={alt || t("image.alt")} width={width} caption={caption} failed={q.data === null ? t("image.failed") : undefined} openLabel={t("image.open")} closeLabel={t("common.close")} />;
}

/** A file read as base64 (without the `data:` prefix). */
export function fileBase64(file: File): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
}

const MAX_BYTES = 20 * 1024 * 1024;

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function factsOf(a: Attachment): string {
  const kind = a.type.replace(/^image\//, "").toUpperCase();
  return [a.width && a.height ? `${a.width} × ${a.height}` : "", kind, formatSize(a.size)].filter(Boolean).join(" · ");
}

/** Puts the files (images, at most 20 MB each) and gives what an attachment field keeps. */
export async function putFiles(client: ProtocolClient, files: File[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) throw new Error("tooLarge");
    const info: BlobInfo = await client.blob!.put({ data: await fileBase64(f) });
    out.push({ blob: info.blob, name: f.name || undefined, type: info.type, size: info.size, width: info.width ?? undefined, height: info.height ?? undefined });
  }
  return out;
}

/** The control of an attachment field: drop, paste or choose an image; shows it, replaces it, removes it. */
export function AttachmentField({ label, value, readOnly, onChange }: { label: string; value: unknown; readOnly: boolean; onChange: (v: Attachment | null) => void }) {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const a = isAttachment(value) ? value : null;
  const take = async (get: () => Promise<Attachment | null>) => {
    setBusy(true);
    try {
      const got = await get();
      if (got) onChange(got);
    } catch (e) {
      actions.fail(e instanceof Error && e.message === "tooLarge" ? new Error(t("image.tooLarge")) : e);
    } finally {
      setBusy(false);
    }
  };
  const pick = client.platform?.pickImageFile;
  return (
    <ImageDrop
      label={label}
      hint={t("image.drop")}
      preview={a ? <BlobImage blob={a.blob} alt={a.name ?? label} width="medium" /> : undefined}
      facts={a ? factsOf(a) : undefined}
      disabled={readOnly || !client.blob}
      busy={busy}
      chooseLabel={a ? t("image.replace") : t("image.choose")}
      removeLabel={t("image.remove")}
      onFiles={(files) => void take(async () => (await putFiles(client, files.slice(0, 1)))[0] ?? null)}
      onChoose={
        pick
          ? () =>
              void take(async () => {
                const path = await pick();
                if (!path) return null;
                const info = await client.blob!.put({ path });
                return { blob: info.blob, name: path.split("/").pop(), type: info.type, size: info.size, width: info.width ?? undefined, height: info.height ?? undefined };
              })
          : undefined
      }
      onRemove={a ? () => onChange(null) : undefined}
    />
  );
}
