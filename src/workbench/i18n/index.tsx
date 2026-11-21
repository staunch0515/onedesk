import { createContext, useContext, useMemo, type ReactNode } from "react";
import { kernelErrorCode, type Label, type Locale } from "../protocol";
import { enUS, type MessageKey } from "./en-US";
import { AUDIT_OPERATIONS, PERMISSIONS, RUN_ERRORS, RUN_ERRORS_NAMED, RUN_FALLBACK, KERNEL_CONFIRMS, KERNEL_ERRORS, KERNEL_LABELS } from "./kernel-texts";

/** The language the shell has built in; every other language arrives as a text overlay from a language plugin (D379). */
export const BUILT_IN_LOCALE: Locale = "en-US";

export interface I18n {
  locale: Locale;
  /** Shell text by key; missing keys fall back to English, never to the key name (I.1). */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** `t` for a counted phrase: a count of 1 uses `<key>.one` when the language has it (built-in English always does), else the plain key. */
  plural: (key: MessageKey, count: number, vars?: Record<string, string | number>) => string;
  /** Text supplied by the kernel or a plugin. Kernel ids (`node.rename`) get their word; unknown ones show as they are (D262). */
  tx: (label: Label | undefined) => string;
  /** A failed protocol call as a sentence: by error code for the kernel (D219), else the error's own message. */
  error: (error: unknown) => string;
  /** Title and confirm-button words for a kernel `confirm` message key; undefined for other messages. */
  confirmTexts: (label: Label | undefined) => { title: string; ok: string } | undefined;
  /** A run failure as a sentence: by code when the shell knows it, else the message the run came with. */
  runError: (error: { code: string; message: string; reason?: string; hint?: string; params?: Record<string, string> }) => string;
  /** A plugin permission id as words (unknown ids as they are). */
  permission: (id: string) => string;
  /** An audit operation id as words. */
  operation: (id: string) => string;
  dateTime: (at: number) => string;
  time: (at: number) => string;
  number: (n: number) => string;
  duration: (ms: number) => string;
}

/** What a kernel text key looks like (`node.rename`, `core:group`); plain words and names do not match. */
const KEY_LIKE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$|^core:[a-z-]+$/;
const warned = new Set<string>();

/** A kernel key without a word is shown as it is, but a developer should hear about it. */
function warnMissing(label: string): string {
  if (import.meta.env.DEV && KEY_LIKE.test(label) && !warned.has(label)) {
    warned.add(label);
    console.warn(`[i18n] no text for kernel key "${label}" (add it to src/workbench/i18n/kernel-texts.ts)`);
  }
  return label;
}

/** Exported for tests. */
export function buildI18n(locale: Locale, texts?: Record<string, string>): I18n {
  return build(locale, texts);
}

/**
 * Shell text = the built-in English, overlaid by the chosen language's `texts` (D379). A key the overlay lacks (or gives
 * as something else than a string) falls back to English, so nothing is ever blank or a bare key.
 */
function build(locale: Locale, texts?: Record<string, string>): I18n {
  const table: Record<string, string> = texts ?? {};
  // Dates, numbers and sorting follow the language; a tag the runtime does not know falls back to English formats.
  const fmt = Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0 ? locale : BUILT_IN_LOCALE;
  const dt = new Intl.DateTimeFormat(fmt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const tm = new Intl.DateTimeFormat(fmt, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const nf = new Intl.NumberFormat(fmt);
  const sec = new Intl.NumberFormat(fmt, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const t = (key: MessageKey, vars?: Record<string, string | number>): string => {
    const own = table[key];
    const text: string = typeof own === "string" && own !== "" ? own : enUS[key];
    return vars ? text.replace(/\{(\w+)\}/g, (whole: string, name: string) => (name in vars ? String(vars[name]) : whole)) : text;
  };
  const plural: I18n["plural"] = (key, count, vars) => {
    const one = `${key}.one`;
    const useOne = count === 1 && (texts === undefined ? one in enUS : typeof table[one] === "string" && table[one] !== "");
    return t((useOne ? one : key) as MessageKey, { count, ...vars });
  };
  return {
    locale,
    t,
    plural,
    confirmTexts: (label) => {
      const known = typeof label === "string" ? KERNEL_CONFIRMS[label] : undefined;
      return known ? { title: t(known.title), ok: t(known.ok) } : undefined;
    },
    tx: (label) => (label === undefined ? "" : typeof label === "string" ? (KERNEL_LABELS[label] ? t(KERNEL_LABELS[label]!) : warnMissing(label)) : (label[locale] ?? label["en-US"] ?? "")),
    error: (error) => {
      const known = kernelErrorCode(error);
      const reason = known?.params.reason;
      const what = known?.params.what;
      const pick = (table: Record<string, MessageKey>): MessageKey | undefined => (known && reason ? (table[`${known.code}.${reason}`] ?? table[`reason.${reason}`] ?? KERNEL_LABELS[reason]) : undefined) ?? (known && what ? table[`${known.code}.${what}`] : undefined) ?? (known ? table[known.code] : undefined);
      // A refusal that names the layer which forbids ("reason|layerName") says which one to change.
      const named = known && reason && known.params.layerName ? KERNEL_ERRORS[`reason.${reason}|layerName`] : undefined;
      const key = named ?? (known && pick(KERNEL_ERRORS));
      if (known && key) return t(key, known.params);
      return error instanceof Error ? error.message : String(error);
    },
    runError: (e) => {
      // A host refusal the plugin did not catch keeps its own code (denied, invalid…) and carries the reason (D318).
      const own = RUN_ERRORS[e.code];
      if (own) return t(own);
      const params = e.params ?? {};
      if (e.reason) {
        let best: [number, MessageKey] | undefined;
        for (const [key, text] of Object.entries(RUN_ERRORS_NAMED)) {
          const [head, ...need] = key.split("|");
          if (head !== `${e.code}.${e.reason}` && head !== `reason.${e.reason}`) continue;
          if (need.length > 0 && need.every((n) => params[n] !== undefined && params[n] !== "") && (!best || need.length > best[0])) best = [need.length, text];
        }
        if (best) return t(best[1], params);
      }
      const byReason = e.reason ? (KERNEL_ERRORS[`${e.code}.${e.reason}`] ?? KERNEL_ERRORS[`reason.${e.reason}`]) : undefined;
      if (byReason) return t(byReason);
      const general = KERNEL_ERRORS[e.code];
      return general ? t(general) : e.message.trim() ? e.message : t(RUN_FALLBACK, { code: e.code });
    },
    permission: (id) => (PERMISSIONS[id] ? t(PERMISSIONS[id]!) : id),
    operation: (id) => (AUDIT_OPERATIONS[id] ? t(AUDIT_OPERATIONS[id]!) : id),
    dateTime: (at) => dt.format(at),
    time: (at) => tm.format(at),
    number: (n) => nf.format(n),
    duration: (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${sec.format(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`),
  };
}

const I18nContext = createContext<I18n>(build("en-US"));

/** `texts` is the language plugin's shell text for `locale` (key → text); absent for the built-in English. */
export function I18nProvider({ locale, texts, children }: { locale: Locale; texts?: Record<string, string>; children: ReactNode }) {
  const value = useMemo(() => build(locale, texts), [locale, texts]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export type { MessageKey };
