// Formulas (docs/redesign/book.md §17.3): lines `name = expression`, read and computed here — never run as code.
// A name used before any line defines it is a parameter; the last line's name is the result. Errors are
// `{ key, vars }` the page turns into words.

export const MAX_TEXT = 4000;
export const MAX_LINES = 50;
export const MAX_DEPTH = 32;
export const FUNCTIONS = ["abs", "round", "floor", "ceil", "min", "max", "sqrt", "pow", "exp", "ln", "log10", "sin", "cos", "tan"];
export const CONSTANTS = { pi: Math.PI, e: Math.E };

const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_]/u;

class FormulaError extends Error {
  constructor(key, vars = {}) {
    super(key);
    this.key = key;
    this.vars = vars;
  }
}

const fail = (key, vars) => {
  throw new FormulaError(key, vars);
};

function tokens(src, line) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) fail("syntax", { line });
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < src.length && NAME_PART.test(src[j])) j++;
      out.push({ t: "name", v: src.slice(i, j) });
      i = j;
    } else if ("+-*/^%(),×÷".includes(c)) {
      out.push({ t: "op", v: c === "×" ? "*" : c === "÷" ? "/" : c });
      i++;
    } else {
      fail("badChar", { line, char: c });
    }
  }
  return out;
}

/** Closest known function to a name (one or two letters off), for "did you mean". */
function closest(name) {
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  let best = null;
  for (const f of FUNCTIONS) {
    const x = d(name.toLowerCase(), f);
    if (x <= 2 && (!best || x < best.x)) best = { f, x };
  }
  return best ? best.f : null;
}

function parseExpr(toks, line) {
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const take = (v) => {
    const t = toks[p];
    if (!t || t.t !== "op" || t.v !== v) fail("syntax", { line });
    p++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) fail("tooDeep", { line });
  };
  const expr = () => {
    enter();
    let left = term();
    while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = toks[p++].v;
      left = { op, a: left, b: term() };
    }
    depth--;
    return left;
  };
  const term = () => {
    let left = unary();
    while (peek() && peek().t === "op" && "*/%".includes(peek().v)) {
      const op = toks[p++].v;
      left = { op, a: left, b: unary() };
    }
    return left;
  };
  const unary = () => {
    const t = peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
      p++;
      enter();
      const a = unary();
      depth--;
      return t.v === "-" ? { op: "neg", a } : a;
    }
    return power();
  };
  const power = () => {
    const base = primary();
    const t = peek();
    if (t && t.t === "op" && t.v === "^") {
      p++;
      enter();
      const ex = unary();
      depth--;
      return { op: "^", a: base, b: ex };
    }
    return base;
  };
  const primary = () => {
    const t = toks[p++];
    if (!t) fail("syntax", { line });
    if (t.t === "num") return { num: t.v };
    if (t.t === "name") {
      const n = peek();
      if (n && n.t === "op" && n.v === "(") {
        p++;
        if (!FUNCTIONS.includes(t.v)) {
          const like = closest(t.v);
          fail(like ? "unknownFunctionLike" : "unknownFunction", { line, name: t.v, like: like || "" });
        }
        const args = [];
        if (!(peek() && peek().t === "op" && peek().v === ")")) {
          args.push(expr());
          while (peek() && peek().t === "op" && peek().v === ",") {
            p++;
            args.push(expr());
          }
        }
        take(")");
        return { fn: t.v, args };
      }
      return { name: t.v };
    }
    if (t.t === "op" && t.v === "(") {
      const e = expr();
      take(")");
      return e;
    }
    fail("syntax", { line });
  };
  const e = expr();
  if (p !== toks.length) fail("syntax", { line });
  return e;
}

function namesIn(node, out) {
  if (node.name !== undefined) out.push(node.name);
  for (const k of ["a", "b"]) if (node[k]) namesIn(node[k], out);
  for (const a of node.args || []) namesIn(a, out);
  return out;
}

/**
 * Reads a formula: `{ lines: [{ name, node, line }], params: [names, in order of first use], result }`, or
 * `{ error: { key, vars } }`. Empty lines and lines starting with `#` or `//` are skipped.
 */
export function analyze(text) {
  try {
    const src = String(text || "");
    if (src.length > MAX_TEXT) fail("tooLong", { max: MAX_TEXT });
    const raw = src.split("\n");
    const lines = [];
    const defined = new Set();
    const params = [];
    raw.forEach((l, i) => {
      const s = l.trim();
      if (!s || s.startsWith("#") || s.startsWith("//")) return;
      if (lines.length >= MAX_LINES) fail("tooManyLines", { max: MAX_LINES });
      const eq = s.indexOf("=");
      if (eq <= 0) fail("noEquals", { line: i + 1 });
      const name = s.slice(0, eq).trim();
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || FUNCTIONS.includes(name) || name in CONSTANTS) fail("badName", { line: i + 1, name });
      const node = parseExpr(tokens(s.slice(eq + 1), i + 1), i + 1);
      for (const n of namesIn(node, [])) if (!defined.has(n) && !(n in CONSTANTS) && !params.includes(n)) params.push(n);
      defined.add(name);
      lines.push({ name, node, line: i + 1 });
    });
    if (lines.length === 0) fail("empty", {});
    return { lines, params, result: lines[lines.length - 1].name };
  } catch (e) {
    if (e instanceof FormulaError) return { error: { key: e.key, vars: e.vars } };
    throw e;
  }
}

function evalNode(node, env, line) {
  if (node.num !== undefined) return node.num;
  if (node.name !== undefined) return node.name in env ? env[node.name] : CONSTANTS[node.name];
  if (node.fn) {
    const a = node.args.map((x) => evalNode(x, env, line));
    const want = { round: [1, 2], min: [1, 99], max: [1, 99], pow: [2, 2] }[node.fn] || [1, 1];
    if (a.length < want[0] || a.length > want[1]) fail("arity", { line, name: node.fn });
    switch (node.fn) {
      case "round": {
        const n = a.length > 1 ? Math.max(0, Math.min(15, Math.floor(a[1]))) : 0;
        const f = 10 ** n;
        return Math.round(a[0] * f) / f;
      }
      case "min":
        return Math.min(...a);
      case "max":
        return Math.max(...a);
      case "pow":
        return a[0] ** a[1];
      case "ln":
        return Math.log(a[0]);
      case "log10":
        return Math.log10(a[0]);
      default:
        return Math[node.fn](a[0]);
    }
  }
  if (node.op === "neg") return -evalNode(node.a, env, line);
  const x = evalNode(node.a, env, line);
  const y = evalNode(node.b, env, line);
  switch (node.op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      if (y === 0) fail("divZero", { line });
      return x / y;
    case "%":
      if (y === 0) fail("divZero", { line });
      return x % y;
    case "^":
      return x ** y;
  }
  return NaN;
}

/** A number as a parameter's value is written: `37`, `-3.5`, `1.2e3` (spaces around are fine); else null. */
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : null;
}

/**
 * Computes a read formula with parameter values (`{ name: number }`): `{ steps: [{ name, value }], result }`, or
 * `{ error }`. A parameter without a value is "missing"; a value that is not a number is "not a number".
 */
export function compute(a, values) {
  try {
    const env = {};
    for (const p of a.params) {
      if (!(p in values) || values[p] === null || values[p] === undefined || values[p] === "") fail("missing", { name: p });
      const n = toNumber(values[p]);
      if (n === null) fail("notNumber", { name: p, value: String(values[p]) });
      env[p] = n;
    }
    const steps = [];
    for (const l of a.lines) {
      const v = evalNode(l.node, env, l.line);
      if (!Number.isFinite(v)) fail("notFinite", { line: l.line });
      env[l.name] = v;
      steps.push({ name: l.name, value: v });
    }
    return { steps, result: steps[steps.length - 1].value };
  } catch (e) {
    if (e instanceof FormulaError) return { error: { key: e.key, vars: e.vars } };
    throw e;
  }
}

/** A result written with `decimals` places at most (trailing zeros dropped), no thousands separators. */
export function format(v, decimals) {
  const d = Number.isInteger(decimals) ? Math.max(0, Math.min(10, decimals)) : 2;
  // Half away from zero, as people round (310.15 → 310.2), despite binary fractions.
  const f = 10 ** d;
  const r = (Math.sign(v) * Math.round(Math.abs(v) * f * (1 + Number.EPSILON))) / f;
  const s = String(r);
  return s === "-0" ? "0" : s;
}

/** A line as shown: × and ÷ for * and /, small digits for powers of a digit. */
export function pretty(line) {
  const sup = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
  return String(line)
    .replace(/\s*\*\s*/g, " × ")
    .replace(/\s*\/\s*/g, " ÷ ")
    .replace(/\^(\d+)/g, (_, d) => d.split("").map((x) => sup[x]).join(""));
}
