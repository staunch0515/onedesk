/** Longest address that may leave the application (the kernel's `ui.openExternal` and the main process use the same bound, D380). */
export const MAX_OPEN_URL = 2048;

/** The one rule for "may this address be opened outside": http, https (with a host) or mailto, no spaces or control characters. */
export function isOpenableUrl(url: string): boolean {
  return url.length > 0 && url.length <= MAX_OPEN_URL && !/[\s\u0000-\u001f]/.test(url) && /^(https?:\/\/|mailto:)\S/i.test(url);
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", nbsp: " ", sol: "/", period: "." };

/**
 * Markdown lets a link address hide its protocol in entities (a numeric entity for the letter j), percent signs are not decoded by browsers
 * for the protocol, and tabs or newlines inside it are dropped by them. The address is decoded the way a browser would read the
 * attribute, then judged: what is judged is what would be opened.
 */
export function normalizeLinkHref(raw: string): string {
  const decoded = raw.replace(/&([#]x[0-9a-f]+|[#][0-9]+|[a-z]+);?/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
  // Browsers ignore leading/trailing control or space and remove tabs and line breaks anywhere in a URL.
  return decoded.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
}
