/**
 * The session's notices (D376): every toast the interface shows is also kept here, so one missed on screen can be read later
 * from the status bar. Memory only; gone when the window closes.
 */
import type { ToastTone } from "../../design";

export interface Notice {
  id: number;
  at: number;
  tone: ToastTone;
  text: string;
  detail?: string;
  read: boolean;
}

/** The most notices kept; older ones drop off. */
export const NOTICE_LIMIT = 200;

/** Adds a notice (newest first). While the list is open (`read`), what arrives is already read. */
export function addNotice(list: Notice[], notice: Omit<Notice, "read">, read = false): Notice[] {
  return [{ ...notice, read }, ...list].slice(0, NOTICE_LIMIT);
}

export const unreadCount = (list: Notice[]): number => list.filter((n) => !n.read).length;

export const markAllRead = (list: Notice[]): Notice[] => (unreadCount(list) === 0 ? list : list.map((n) => (n.read ? n : { ...n, read: true })));

/** Toast titles are normally text; anything else is not worth keeping. */
export function textOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
