// Words and numbers shared by the book's roles (docs/redesign/book.md §4.2): a label in the reader's language, and the
// ways a number is written (Chinese numerals, letters).

/** A plugin text as a string in the context's language, with `{name}` filled from `vars`. */
export function say(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : (label && (label[ctx.locale] || label["en-US"])) || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

const DIGITS = "零一二三四五六七八九";
const UNITS = ["", "十", "百", "千"];

/** 1 → 一, 10 → 十, 11 → 十一, 20 → 二十, 101 → 一百零一; 10 000 and more stay digits. */
export function chineseNumber(n) {
  if (!Number.isInteger(n) || n <= 0 || n >= 10000) return String(n);
  const s = String(n);
  let out = "";
  let zero = false;
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    if (d === 0) {
      zero = true;
      continue;
    }
    if (zero && out) out += "零";
    zero = false;
    out += DIGITS[d] + UNITS[s.length - 1 - i];
  }
  return out.startsWith("一十") ? out.slice(1) : out;
}

/** 1 → A, 26 → Z, 27 → AA. */
export function letter(n) {
  let out = "";
  let x = n;
  while (x > 0) {
    x--;
    out = String.fromCharCode(65 + (x % 26)) + out;
    x = Math.floor(x / 26);
  }
  return out;
}

/** Whether numbers are written with Chinese numerals in this language (Chinese and Japanese). */
export function usesChineseNumerals(ctx) {
  const l = String(ctx.locale || "");
  return l.startsWith("zh") || l.startsWith("ja");
}
