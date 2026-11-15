import { createContext, useContext, useMemo, type ReactNode } from "react";
import { kernelErrorCode, type Label, type Locale } from "../protocol";
import { enUS, type MessageKey } from "./en-US";
import { AUDIT_OPERATIONS, PERMISSIONS, RUN_ERRORS, interpolate, KERNEL_CONFIRMS, KERNEL_ERRORS, KERNEL_LABELS } from "./kernel-texts";
import { zhCN } from "./zh-CN";

const TABLES: Record<Locale, Partial<Record<MessageKey, string>>> = { "en-US": enUS, "zh-CN": zhCN };

export const LOCALES: Array<{ value: Locale; label: string }> = [
  { value: "en-US", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

export interface I18n {
  locale: Locale;
  /** Shell text by key; missing keys fall back to English, never to the key name (I.1). */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Text supplied by the kernel or a plugin. Kernel ids (`node.rename`) get their word; unknown ones show as they are (D262). */
  tx: (label: Label | undefined) => string;
  /** A failed protocol call as a sentence: by error code for the kernel (D219), else the error's own message. */
  error: (error: unknown) => string;
  /** Title and confirm-button words for a kernel `confirm` message key; undefined for other messages. */
  confirmTexts: (label: Label | undefined) => { title: string; ok: string } | undefined;
  /** A run failure as a sentence: by code when the shell knows it, else the message the run came with. */
  runError: (error: { code: string; message: string }) => string;
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

function build(locale: Locale): I18n {
  const table = TABLES[locale];
  const dt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const tm = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const nf = new Intl.NumberFormat(locale);
  const sec = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    locale,
    t: (key, vars) => {
      const text: string = table[key] ?? enUS[key];
      return vars ? text.replace(/\{(\w+)\}/g, (whole: string, name: string) => (name in vars ? String(vars[name]) : whole)) : text;
    },
    confirmTexts: (label) => (typeof label === "string" ? (KERNEL_CONFIRMS[locale][label] ?? KERNEL_CONFIRMS["en-US"][label]) : undefined),
    tx: (label) => (label === undefined ? "" : typeof label === "string" ? (KERNEL_LABELS[locale][label] ?? KERNEL_LABELS["en-US"][label] ?? warnMissing(label)) : (label[locale] ?? label["en-US"] ?? "")),
    error: (error) => {
      const known = kernelErrorCode(error);
      const reason = known?.params.reason;
      const pick = (table: Record<string, string>) => (known && reason ? (table[`${known.code}.${reason}`] ?? table[`reason.${reason}`]) : undefined) ?? (known ? table[known.code] : undefined);
      const text = known && (pick(KERNEL_ERRORS[locale]) ?? pick(KERNEL_ERRORS["en-US"]));
      if (known && text) return interpolate(text, known.params);
      return error instanceof Error ? error.message : String(error);
    },
    runError: (e) => RUN_ERRORS[locale][e.code] ?? RUN_ERRORS["en-US"][e.code] ?? KERNEL_ERRORS[locale][e.code] ?? KERNEL_ERRORS["en-US"][e.code] ?? e.message,
    permission: (id) => PERMISSIONS[locale][id] ?? PERMISSIONS["en-US"][id] ?? id,
    operation: (id) => AUDIT_OPERATIONS[locale][id] ?? AUDIT_OPERATIONS["en-US"][id] ?? id,
    dateTime: (at) => dt.format(at),
    time: (at) => tm.format(at),
    number: (n) => nf.format(n),
    duration: (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${sec.format(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`),
  };
}

const I18nContext = createContext<I18n>(build("en-US"));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => build(locale), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export type { MessageKey };
