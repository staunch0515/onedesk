// The way a program book's tests are written (docs/redesign/book.md §37.3): `test`, `expect`, `load` and `fakeHost`. It is
// one of the files given to the kernel's empty sandbox (K21) with the book's files and the test pages; the kernel knows
// no test framework. Kept as text: it runs there, not here. (No backquotes inside.)

export const HARNESS = String.raw`"use strict";
const tests = [];
let page = 0;
let modules = {};
let jsons = {};

export function __page(n) {
  page = n;
}

function show(v) {
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "function";
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch (e) {
    return String(v);
  }
}

function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
}

class Failure extends Error {
  constructor(message, expected, actual) {
    super(message);
    this.expected = expected;
    this.actual = actual;
  }
}

function expect(actual) {
  const make = (not) => {
    const check = (pass, name, expected, shown) => {
      if (pass === not) {
        const want = shown === undefined ? show(expected) : shown;
        throw new Failure("expect(" + show(actual) + ")" + (not ? ".not" : "") + "." + name + "(" + (expected === undefined ? "" : show(expected)) + ")", (not ? "not " : "") + want, show(actual));
      }
    };
    return {
      toBe: (e) => check(Object.is(actual, e), "toBe", e),
      toEqual: (e) => check(equal(actual, e), "toEqual", e),
      toContain: (e) => check((typeof actual === "string" || Array.isArray(actual)) && actual.indexOf(e) >= 0, "toContain", e),
      toBeTruthy: () => check(!!actual, "toBeTruthy", undefined, "truthy"),
      toThrow: (e) => {
        let threw = false;
        let message = "";
        try {
          actual();
        } catch (x) {
          threw = true;
          message = String((x && x.message) || x);
        }
        const pass = threw && (e === undefined || message.indexOf(String(e)) >= 0);
        if (pass === not) throw new Failure("expect(…)" + (not ? ".not" : "") + ".toThrow(" + (e === undefined ? "" : show(e)) + ")", (not ? "no error" : e === undefined ? "an error" : "an error with " + show(e)), threw ? "error " + show(message) : "no error");
      },
    };
  };
  const o = make(false);
  o.not = make(true);
  return o;
}

function test(name, fn) {
  tests.push({ page, name: String(name), fn });
}

function load(path) {
  if (Object.prototype.hasOwnProperty.call(modules, path)) return modules[path];
  if (Object.prototype.hasOwnProperty.call(jsons, path)) return JSON.parse(JSON.stringify(jsons[path]));
  throw new Error("load: no file " + path + " in this book");
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeHost(seed) {
  const s = seed || {};
  const res = new Map();
  let n = 0;
  for (const r of s.resources || []) res.set(r.id, { id: r.id, kind: r.kind || "", name: r.name || "", parentId: r.parentId === undefined ? (r.parent === undefined ? null : r.parent) : r.parentId, body: clone(r.body || {}) });
  const storage = Object.assign({}, clone(s.storage || {}));
  const params = Object.assign({}, s.params || {});
  const no = (what) => async () => {
    throw new Error("fakeHost: " + what + " is not available in tests");
  };
  const kindIs = (r, k) => !k || r.kind === k || r.kind.endsWith(":" + k);
  const below = (id, depth, out) => {
    for (const r of res.values()) {
      if (r.parentId === id) {
        out.push({ id: r.id, name: r.name, kind: r.kind, depth });
        below(r.id, depth + 1, out);
      }
    }
    return out;
  };
  return {
    resources: {
      get: async (id) => (res.has(id) ? clone(res.get(id)) : null),
      list: async (o) => [...res.values()].filter((r) => kindIs(r, o && o.kind) && (!o || o.parent === undefined || r.parentId === o.parent)).map(clone),
      tree: async (id) => ({ nodes: below(id, 1, []), next: null }),
      create: async (o) => {
        const id = (o && o.id) || "r" + ++n;
        res.set(id, { id, kind: (o && o.kind) || "", name: (o && o.name) || "", parentId: (o && o.parent) || null, body: clone((o && o.body) || {}) });
        return { id };
      },
      update: async (id, changes) => {
        const r = res.get(id);
        if (!r) throw new Error("notFound");
        for (const k of Object.keys(changes || {})) {
          if (k.indexOf("body.") === 0) r.body[k.slice(5)] = clone(changes[k]);
          else if (k === "name") r.name = String(changes[k]);
        }
        return { rev: 1 };
      },
      delete: async (id) => {
        res.delete(id);
      },
    },
    storage: {
      get: async (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? clone(storage[k]) : null),
      set: async (k, v) => {
        storage[k] = clone(v);
      },
      delete: async (k) => {
        delete storage[k];
      },
      keys: async () => Object.keys(storage),
    },
    params: { get: async (name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : null) },
    network: { request: no("network") },
    files: { roots: async () => [], list: no("files"), readText: no("files"), writeText: no("files") },
    process: { run: no("process") },
    secrets: { get: no("secrets") },
    // What the tests can look at afterwards.
    all: () => [...res.values()].map(clone),
  };
}

globalThis.test = test;
globalThis.expect = expect;
globalThis.load = load;
globalThis.fakeHost = fakeHost;

/** Where an error came from: the first frame in a file of the book (not this one, not the entry). */
function where(e) {
  const stack = String((e && e.stack) || "");
  const re = /([A-Za-z0-9_.\/-]+\.js):(\d+)/g;
  for (let m = re.exec(stack); m; m = re.exec(stack)) {
    if (!/(^|\/)__(harness|entry)\.js$/.test(m[1])) return { file: m[1], line: Number(m[2]) };
  }
  return {};
}

export async function __run(mods, json) {
  modules = mods;
  jsons = json;
  const out = [];
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      out.push({ page: t.page, name: t.name, ok: true, ms: Date.now() - started });
    } catch (e) {
      const r = { page: t.page, name: t.name, ok: false, ms: Date.now() - started, message: String((e && e.message) || e) };
      if (e instanceof Failure) {
        r.expected = e.expected;
        r.actual = e.actual;
      }
      Object.assign(r, where(e));
      out.push(r);
    }
  }
  return { tests: out };
}
`;
