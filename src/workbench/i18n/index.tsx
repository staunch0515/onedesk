import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Label, Locale } from "../protocol";
import { enUS, type MessageKey } from "./en-US";
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
  /** Text supplied by the kernel or a plugin. */
  tx: (label: Label | undefined) => string;
  dateTime: (at: number) => string;
  time: (at: number) => string;
  number: (n: number) => string;
  duration: (ms: number) => string;
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
    tx: (label) => (label === undefined ? "" : typeof label === "string" ? label : (label[locale] ?? label["en-US"])),
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
