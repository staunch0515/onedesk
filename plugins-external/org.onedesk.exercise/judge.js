// Judging answers (docs/redesign/book.md §19.3), the way a teacher would: by value (½ = 1/2 = 0.5, a unit after the
// number does not matter), by writing, by symbol, by letters for choices, by right/wrong for true-or-false. "Teacher"
// is never judged here.

export const RULES = ["number", "text", "symbol", "teacher"];

/** Full-width letters, digits and signs as their ordinary forms; spaces at the ends gone, runs of spaces one. */
export function plain(s) {
  let t = String(s ?? "");
  try {
    t = t.normalize("NFKC");
  } catch {
    // as it is
  }
  return t.replace(/\s+/g, " ").trim();
}

const FRACTIONS = { "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };

/** The number an answer starts with (`4 个` → 4, `1/2` → 0.5, `½` → 0.5, `-.5` → -0.5); null when it does not. */
export function numberOf(s) {
  const raw = String(s ?? "").trim();
  if (raw in FRACTIONS) return FRACTIONS[raw];
  const t = plain(s).replace(/⁄/g, "/");
  // A unit may follow (letters: `4 个`, `3 cm`), never an operator: `12÷3` is not 12.
  const m = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*(\d+(?:\.\d+)?))?(?:\s*\p{L}.*)?$/u.exec(t);
  if (!m) return null;
  let v = Number(m[2]);
  if (m[3] !== undefined) {
    const d = Number(m[3]);
    if (d === 0) return null;
    v /= d;
  }
  return m[1] === "-" ? -v : v;
}

const SYMBOLS = { ">": ">", "<": "<", "=": "=", "≥": ">=", "≤": "<=", ">=": ">=", "<=": "<=", "≠": "!=", "!=": "!=" };

/** One blank: is `given` one of the `accepted` answers (written `a | b`) under `rule`? */
export function blankRight(rule, accepted, given) {
  const g = plain(given);
  if (!g) return false;
  const alts = String(accepted ?? "")
    .split("|")
    .map((x) => plain(x))
    .filter(Boolean);
  for (const a of alts) {
    if (rule === "number") {
      const x = numberOf(a);
      const y = numberOf(g);
      if (x !== null && y !== null) {
        if (Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))) return true;
        continue;
      }
      if (a === g) return true;
    } else if (rule === "symbol") {
      if ((SYMBOLS[a] ?? a) === (SYMBOLS[g] ?? g)) return true;
    } else if (a === g) {
      return true;
    }
  }
  return false;
}

/** The letters of a choice, in order, once each (`c, a` → `AC`). */
export function letters(s) {
  return [...new Set(plain(s).toUpperCase().replace(/[^A-Z]/g, "").split(""))].sort().join("");
}

const TRUE = ["对", "√", "✓", "✔", "T", "TRUE", "是", "正确", "○", "Y", "YES", "正しい"];
const FALSE = ["错", "×", "✗", "✘", "F", "FALSE", "否", "错误", "N", "NO", "誤り"];

/** True-or-false as written: true, false, or null. */
export function truth(s) {
  const t = plain(s).toUpperCase();
  if (TRUE.includes(t)) return true;
  if (FALSE.includes(t)) return false;
  return null;
}
