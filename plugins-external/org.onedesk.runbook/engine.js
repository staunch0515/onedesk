// Carrying out a procedure (docs/redesign/book.md §25.4): the flow's steps in the contents' order, one after another
// — a step whose condition does not hold is skipped; one that fails stops the run; one that asks for a confirmation
// stops after it runs; “continue” goes on from there. Everything is written into the run log as it happens.

import { full, IFACE, PLUGIN, say, str } from "./common.js";
import { check, fillText, lookupIn } from "./compare.js";
import { ROLES } from "./roles.js";

export const STEP = full("step");
export const LOG = full("log");
/** What a step's output keeps in the log: text up to 64 KB, a table's first 200 rows. */
export const MAX_TEXT = 65536;
export const MAX_ROWS = 200;

/** The book's numbered items, as its own plugin numbers them (our roles go along: no call cycle). */
export async function entriesOfBook(ctx, book) {
  if (!book) return null;
  const plugin = book.kind.slice(0, book.kind.lastIndexOf(":"));
  try {
    const r = await ctx.host.interfaces.call(IFACE, "entries", { book: book.id, roles: { [PLUGIN]: ROLES.kinds } }, { plugin });
    return r && r.data && Array.isArray(r.data.items) ? r.data : null;
  } catch {
    return null;
  }
}

/** The steps of a book, in the contents' order: `[{ id, name, title, key }]`. */
export async function stepsOf(ctx, book) {
  const e = await entriesOfBook(ctx, book);
  if (!e) return null;
  const out = [];
  for (const it of e.items) {
    if (!it.resource) continue;
    let r;
    try {
      r = await ctx.host.resources.get(it.resource);
    } catch {
      continue;
    }
    if (r && r.kind === STEP) out.push({ id: r.id, name: r.name, title: it.title, key: it.key });
  }
  return { steps: out, items: e.items };
}

/** An environment value by name (null when there is none). */
export function envOf(ctx) {
  return async (name) => {
    try {
      const f = await ctx.host.params.get(name);
      return f && f.found ? String(f.value) : null;
    } catch {
      return null;
    }
  };
}

/** The values of the steps so far, by step name. */
function valuesOf(log) {
  const out = {};
  for (const s of Object.values(log.body.steps || {})) if (s && s.name) out[s.name] = s;
  return out;
}

/** What a run gave, kept for the log and for later steps: text, data, a table's first row. */
function kept(result) {
  const o = result.output || {};
  let text = "";
  let first = null;
  let table = null;
  if (o.type === "text") text = str(o.text).slice(0, MAX_TEXT);
  if (o.type === "table" && Array.isArray(o.columns)) {
    const rows = Array.isArray(o.rows) ? o.rows : [];
    table = { columns: o.columns.map((c) => c.key), rows: rows.slice(0, MAX_ROWS) };
    if (rows[0]) {
      first = {};
      o.columns.forEach((c, i) => (first[c.key] = rows[0][i]));
      for (const c of o.columns) if (typeof c.label === "string" && !(c.label in first)) first[c.label] = first[c.key];
      // A table's text: its first row.
      text = rows[0].map((x) => str(typeof x === "object" && x !== null ? JSON.stringify(x) : x)).join(" ");
    }
  }
  if (o.type === "link") text = str(o.label);
  return { text, table, first, data: result.data ?? null };
}

/** Carries out one step: its condition, its inputs, its run, its expectations. Returns its record. */
export async function runStep(ctx, step, log) {
  const lookup = lookupIn(valuesOf(log));
  const env = envOf(ctx);
  const b = step.body || {};
  const rec = { name: step.name, at: Date.now() };
  if (str(b.when).trim()) {
    const c = await check(b.when, lookup, env);
    rec.when = c;
    if (!c.every((x) => x.ok)) return { ...rec, state: "skipped", ms: 0 };
  }
  // The values given to what it runs (secrets never kept: `{{secret:…}}` stays as written).
  const params = {};
  const inputs = {};
  for (const line of str(b.inputs).split("\n")) {
    const m = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    params[m[1]] = await fillText(m[2], lookup, env);
    inputs[m[1]] = /\{\{secret:/.test(m[2]) ? m[2] : params[m[1]];
  }
  rec.inputs = inputs;
  let result = { status: "ok", output: null, data: null, ms: 0 };
  if (b.target) {
    try {
      result = await ctx.host.runs.call(b.target, { params });
    } catch (e) {
      result = { status: "failed", error: `${e.code || "error"}${e.params && e.params.reason ? `/${e.params.reason}` : ""}`, ms: 0 };
    }
  }
  Object.assign(rec, kept(result), { ms: result.ms ?? 0 });
  if (result.error) rec.error = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
  if (str(b.expect).trim()) rec.expect = await check(b.expect, lookupIn({ ...valuesOf(log), [step.name]: rec }), env);
  const ok = result.status === "ok" && (rec.expect || []).every((x) => x.ok);
  rec.state = !ok ? "failed" : str(b.confirm).trim() ? "waiting" : "ok";
  return rec;
}

/** The run logs' folder of a book (made once), in the tree “run logs”. */
export async function folderOf(ctx, book) {
  const all = await ctx.host.resources.list({ kind: "logs" });
  const found = all.find((f) => f.body && f.body.book === book.id);
  if (found) return found.id;
  const made = await ctx.host.resources.create({ kind: "logs", name: book.name, body: { book: book.id } });
  return made.id;
}

/** A new log for a flow. */
export async function newLog(ctx, flow, book, operator) {
  const before = (await ctx.host.resources.list({ kind: "log" })).filter((l) => l.body && l.body.flow === flow.id).length;
  const number = before + 1;
  return ctx.host.resources.create({
    kind: "log",
    parent: await folderOf(ctx, book),
    name: say(ctx, "log.name", { book: book.name, n: number }),
    body: { flow: flow.id, book: book.id, number, env: ctx.envId || null, operator: operator || "", started: Date.now(), ended: null, status: "running", next: 0, steps: {} },
  });
}

/**
 * Goes on with a log from step `from`: each step carried out and written in; stops at a failure or a confirmation;
 * the log's status at the end: `done`, `failed`, `waiting`.
 */
export async function carryOn(ctx, log, steps, from) {
  const body = { ...log.body, steps: { ...(log.body.steps || {}) } };
  let i = from;
  for (; i < steps.length; i++) {
    const s = steps[i];
    let step;
    try {
      step = await ctx.host.resources.get(s.id);
    } catch {
      step = null;
    }
    if (!step) continue;
    if (typeof ctx.progress === "function") ctx.progress(Math.round((i * 100) / steps.length), say(ctx, "progress.step", { title: s.title }));
    const rec = await runStep(ctx, step, { body });
    body.steps[step.id] = rec;
    body.next = i;
    if (rec.state === "failed" || rec.state === "waiting") {
      body.status = rec.state;
      await ctx.host.resources.update(log.id, { "body.steps": body.steps, "body.next": i, "body.status": rec.state });
      return { ...log, body };
    }
    await ctx.host.resources.update(log.id, { "body.steps": body.steps, "body.next": i + 1 });
  }
  body.status = "done";
  body.next = steps.length;
  body.ended = Date.now();
  await ctx.host.resources.update(log.id, { "body.status": "done", "body.next": steps.length, "body.ended": body.ended });
  return { ...log, body };
}
