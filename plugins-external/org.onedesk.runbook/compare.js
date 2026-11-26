// What a step compares (docs/redesign/book.md §25.3): `@step.value`, `{{environment value}}` or written words, with
// `=`, `≠`, `>`, `<`, `≥`, `≤`, `包含` (contains), `为空` (empty), `不为空` (not empty). Numbers compare as numbers when
// both sides look like numbers, else as text. No arithmetic. The syntax is this plugin's own (rule 5).

const BINARY = [
  ["≠", "ne"], ["!=", "ne"], ["≥", "ge"], [">=", "ge"], ["≤", "le"], ["<=", "le"],
  ["=", "eq"], [">", "gt"], ["<", "lt"], ["包含", "has"], ["contains", "has"],
];
const UNARY = [["不为空", "full"], ["not empty", "full"], ["为空", "empty"], ["empty", "empty"]];

/** One line read: `{ left, op, right }` (right absent for empty / not empty), or `{ error }`. */
export function parseLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  for (const [w, op] of UNARY) if (s.endsWith(w) && s.length > w.length) return { left: s.slice(0, -w.length).trim(), op };
  // The first operator outside `{{…}}` and quotes.
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "“") {
      quote = c === "“" ? "”" : '"';
      continue;
    }
    if (s.startsWith("{{", i)) depth++;
    if (s.startsWith("}}", i)) depth = Math.max(0, depth - 1);
    if (depth) continue;
    for (const [w, op] of BINARY) {
      if (s.startsWith(w, i) && i > 0) {
        const pad = /^[a-z]/i.test(w) ? /\s/.test(s[i - 1] || "") && /\s/.test(s[i + w.length] || "") : true;
        if (pad) return { left: s.slice(0, i).trim(), op, right: s.slice(i + w.length).trim() };
      }
    }
  }
  return { error: "noOperator" };
}

/** The lines of a field read (empty lines dropped). */
export function parseLines(text) {
  return String(text || "").split("\n").map(parseLine).filter(Boolean);
}

/** Written words: quotes taken off. */
function literal(s) {
  const t = String(s).trim();
  const m = /^(?:"([^"]*)"|“([^”]*)”)$/.exec(t);
  return m ? (m[1] ?? m[2]) : t;
}

/** A side's value: `@…` from the values so far, `{{…}}` from the environment, else the words as written. */
export async function sideValue(side, lookup, env) {
  const s = String(side ?? "").trim();
  if (s.startsWith("@")) return lookup(s.slice(1));
  const m = /^\{\{([^{}]+)\}\}$/.exec(s);
  if (m) return env(m[1].trim());
  // Words with `@…` or `{{…}}` inside are filled in.
  return fillText(literal(s), lookup, env);
}

/** `@…` and `{{…}}` inside words, filled in. */
export async function fillText(text, lookup, env) {
  let out = "";
  const re = /@([^\s,，;；=<>!≠≥≤"“”]+)|\{\{([^{}]+)\}\}/g;
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    out += text.slice(last, m.index);
    const v = m[1] !== undefined ? await lookup(m[1]) : await env(m[2].trim());
    out += v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

const isNum = (v) => v !== null && v !== undefined && String(v).trim() !== "" && Number.isFinite(Number(v));
const text = (v) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Whether a comparison holds. */
export function holds(op, a, b) {
  if (op === "empty") return text(a).trim() === "";
  if (op === "full") return text(a).trim() !== "";
  if (op === "has") return text(a).includes(text(b));
  const num = isNum(a) && isNum(b);
  const x = num ? Number(a) : text(a);
  const y = num ? Number(b) : text(b);
  switch (op) {
    case "eq": return x === y;
    case "ne": return x !== y;
    case "gt": return x > y;
    case "lt": return x < y;
    case "ge": return x >= y;
    case "le": return x <= y;
    default: return false;
  }
}

/** Checks every line: `[{ line, ok, left, right, error? }]`. */
export async function check(lines, lookup, env) {
  const out = [];
  for (const raw of String(lines || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const p = parseLine(raw);
    if (p.error) {
      out.push({ line: raw, ok: false, error: p.error });
      continue;
    }
    const left = await sideValue(p.left, lookup, env);
    const right = p.right !== undefined ? await sideValue(p.right, lookup, env) : undefined;
    out.push({ line: raw, ok: holds(p.op, left, right), left: text(left), ...(right !== undefined ? { right: text(right) } : {}) });
  }
  return out;
}

/**
 * A value of an earlier step: `name` (its text), `name.key` (its data, then the first row of its table), deeper
 * keys into the data (`name.json.version`). `steps`: step name → its result.
 */
export function lookupIn(steps) {
  return (path) => {
    const parts = String(path).split(".");
    // A step's name may itself hold dots: the longest name that matches.
    for (let i = parts.length; i >= 1; i--) {
      const name = parts.slice(0, i).join(".");
      const s = steps[name];
      if (!s) continue;
      const rest = parts.slice(i);
      if (rest.length === 0) return s.text ?? "";
      let v = s.data && rest[0] in s.data ? s.data : s.first && rest[0] in s.first ? s.first : undefined;
      if (v === undefined) return undefined;
      for (const k of rest) {
        if (v === null || typeof v !== "object" || !(k in v)) return undefined;
        v = v[k];
      }
      return v;
    }
    return undefined;
  };
}
