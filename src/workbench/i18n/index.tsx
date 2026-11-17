import { createContext, useContext, useMemo, type ReactNode } from "react";
import { kernelErrorCode, type Label, type Locale } from "../protocol";
import { enUS, type MessageKey } from "./en-US";
import { AUDIT_OPERATIONS, PERMISSIONS, RUN_ERRORS, RUN_ERRORS_NAMED, RUN_FALLBACK, interpolate, KERNEL_CONFIRMS, KERNEL_ERRORS, KERNEL_LABELS } from "./kernel-texts";

/** The language the shell has built in; every other language arrives as a text overlay from a language plugin (D379). */
export const BUILT_IN_LOCALE: Locale = "en-US";

/**
 * Kernel-text tables (`kernel-texts.ts`) still carry English and Chinese words (the kernel's ids and error codes).
 * Another language falls back to English there until those tables move into the language plugins.
 */
const KERNEL_TEXT_LOCALES = ["en-US", "zh-CN"] as const;
type KernelTextLocale = (typeof KERNEL_TEXT_LOCALES)[number];

function kernelTextLocale(locale: Locale): KernelTextLocale {
  return (KERNEL_TEXT_LOCALES as readonly string[]).includes(locale) ? (locale as KernelTextLocale) : "en-US";
}

export interface I18n {
  locale: Locale;
  /** The language of the kernel-text tables in use (`locale`, or English where the shell has none for it). */
  kernelLocale: "en-US" | "zh-CN";
  /** Shell text by key; missing keys fall back to English, never to the key name (I.1). */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
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
  const kernelLocale = kernelTextLocale(locale);
  // Dates, numbers and sorting follow the language; a tag the runtime does not know falls back to English formats.
  const fmt = Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0 ? locale : BUILT_IN_LOCALE;
  const dt = new Intl.DateTimeFormat(fmt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const tm = new Intl.DateTimeFormat(fmt, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const nf = new Intl.NumberFormat(fmt);
  const sec = new Intl.NumberFormat(fmt, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    locale,
    kernelLocale,
    t: (key, vars) => {
      const own = table[key];
      const text: string = typeof own === "string" && own !== "" ? own : enUS[key];
      return vars ? text.replace(/\{(\w+)\}/g, (whole: string, name: string) => (name in vars ? String(vars[name]) : whole)) : text;
    },
    confirmTexts: (label) => (typeof label === "string" ? (KERNEL_CONFIRMS[kernelLocale][label] ?? KERNEL_CONFIRMS["en-US"][label]) : undefined),
    tx: (label) => (label === undefined ? "" : typeof label === "string" ? (KERNEL_LABELS[kernelLocale][label] ?? KERNEL_LABELS["en-US"][label] ?? warnMissing(label)) : (label[locale] ?? label["en-US"] ?? Object.values(label)[0] ?? "")),
    error: (error) => {
      const known = kernelErrorCode(error);
      const reason = known?.params.reason;
      const what = known?.params.what;
      const pick = (table: Record<string, string>) => (known && reason ? (table[`${known.code}.${reason}`] ?? table[`reason.${reason}`] ?? KERNEL_LABELS[kernelLocale][reason] ?? KERNEL_LABELS["en-US"][reason]) : undefined) ?? (known && what ? table[`${known.code}.${what}`] : undefined) ?? (known ? table[known.code] : undefined);
      const text = known && (pick(KERNEL_ERRORS[kernelLocale]) ?? pick(KERNEL_ERRORS["en-US"]));
      if (known && text) return interpolate(text, known.params);
      return error instanceof Error ? error.message : String(error);
    },
    runError: (e) => {
      // A host refusal the plugin did not catch keeps its own code (denied, invalid…) and carries the reason (D318).
      const own = RUN_ERRORS[kernelLocale][e.code] ?? RUN_ERRORS["en-US"][e.code];
      if (own) return own;
      const params = e.params ?? {};
      if (e.reason) {
        for (const l of [kernelLocale, "en-US" as const]) {
          let best: [number, string] | undefined;
          for (const [key, text] of Object.entries(RUN_ERRORS_NAMED[l])) {
            const [head, ...need] = key.split("|");
            if (head !== `${e.code}.${e.reason}` && head !== `reason.${e.reason}`) continue;
            if (need.length > 0 && need.every((n) => params[n] !== undefined && params[n] !== "") && (!best || need.length > best[0])) best = [need.length, text];
          }
          if (best) return interpolate(best[1], params);
        }
      }
      const pickIn = (tbl: Record<string, string>) => (e.reason ? (tbl[`${e.code}.${e.reason}`] ?? tbl[`reason.${e.reason}`]) : undefined);
      const byReason = pickIn(KERNEL_ERRORS[kernelLocale]) ?? pickIn(KERNEL_ERRORS["en-US"]);
      if (byReason) return byReason;
      return KERNEL_ERRORS[kernelLocale][e.code] ?? KERNEL_ERRORS["en-US"][e.code] ?? (e.message.trim() ? e.message : interpolate(RUN_FALLBACK[kernelLocale], { code: e.code }));
    },
    // Ids the kernel tables lack take their words from the shell texts (`permission.<id>`), so a language plugin can translate them.
    permission: (id) => PERMISSIONS[kernelLocale][id] ?? table[`permission.${id}`] ?? PERMISSIONS["en-US"][id] ?? (enUS as Record<string, string>)[`permission.${id}`] ?? id,
    operation: (id) => AUDIT_OPERATIONS[kernelLocale][id] ?? AUDIT_OPERATIONS["en-US"][id] ?? id,
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
