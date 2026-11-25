// Shared by the exercise roles: words, kinds, the book a page is in (by role, never by a plugin's name), the questions
// of a practice or test, attempts.

import { partsOf } from "./question.js";

export const PLUGIN = "org.onedesk.exercise";
export const IFACE = "onedesk.book/1";
export const full = (k) => `${PLUGIN}:${k}`;
export const NONE = { type: "none" };

/** A plugin text in the context's language, `{name}` filled from `vars`. */
export function say(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : (label && (label[ctx.locale] || label["en-US"])) || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

export const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
export const now = () => Date.now();

/** The book a resource is in: the nearest ancestor whose kind plays the role `book` (asked through the interface). */
export async function bookAbove(ctx, id) {
  let implementers = null;
  const roles = new Map();
  let cur = id;
  for (let i = 0; i < 16 && cur; i++) {
    let info;
    try {
      const r = await ctx.host.resources.search({ ids: [cur] });
      info = (Array.isArray(r) ? r : r.items || [])[0];
    } catch {
      return null;
    }
    if (!info) return null;
    if (i > 0) {
      const plugin = info.kind.slice(0, info.kind.lastIndexOf(":"));
      const short = info.kind.slice(info.kind.lastIndexOf(":") + 1);
      if (implementers === null) {
        try {
          implementers = (await ctx.host.interfaces.list(IFACE)).map((x) => x.plugin);
        } catch {
          implementers = [];
        }
      }
      if (implementers.includes(plugin)) {
        if (!roles.has(plugin)) {
          try {
            const r = await ctx.host.interfaces.call(IFACE, "roles", {}, { plugin });
            roles.set(plugin, (r && r.data && r.data.kinds) || []);
          } catch {
            roles.set(plugin, []);
          }
        }
        if (roles.get(plugin).some((k) => k && k.kind === short && k.role === "book")) return { id: info.id, name: info.name, kind: info.kind };
      }
    }
    cur = info.parent;
  }
  return null;
}

/** The items of a practice or test, in order: `{ q: id }` and (tests) `{ h: heading }`. Children not listed come last. */
export async function itemsOf(ctx, res) {
  const kids = await ctx.host.resources.list({ kind: "question", parent: res.id });
  const listed = Array.isArray(res.body && res.body.items) ? res.body.items.filter((x) => x && (typeof x.q === "string" || typeof x.h === "string")) : [];
  const out = listed.slice();
  for (const k of kids) if (!out.some((x) => x.q === k.id)) out.push({ q: k.id });
  return out;
}

/** The questions behind items, by id (only those that still exist). */
export async function questionsOf(ctx, items) {
  const out = new Map();
  for (const it of items) {
    if (!it.q || out.has(it.q)) continue;
    try {
      const r = await ctx.host.resources.get(it.q);
      if (r && r.kind === full("question")) out.set(it.q, { res: r, q: partsOf(r.body) });
    } catch {
      // gone, or not a question
    }
  }
  return out;
}

/** The attempts of a source (a practice, a test), newest first. */
export async function attemptsOf(ctx, sourceId) {
  const all = await ctx.host.resources.list({ kind: "attempt" });
  return all.filter((a) => a.body && a.body.source === sourceId).sort((a, b) => Number(b.body.number || 0) - Number(a.body.number || 0));
}

/** The answers given to a question in an attempt: one per blank. */
export function givenOf(body, qid, blanks) {
  return Array.from({ length: blanks }, (_, i) => str(body && body[`a.${qid}.${i}`]));
}

/** The record folder of a book (made the first time), in the tree “records”. */
export async function folderOf(ctx, book) {
  if (!book) return null;
  const all = await ctx.host.resources.list({ kind: "subject" });
  const found = all.find((s) => s.body && s.body.book === book.id);
  if (found) return found.id;
  const made = await ctx.host.resources.create({ kind: "subject", name: book.name, body: { book: book.id } });
  return made.id;
}

/** A grades sheet and a mistake book, made once (the first time anything is handed in). */
export async function ensureLedgers(ctx) {
  for (const kind of ["grades", "mistakes"]) {
    const have = await ctx.host.resources.list({ kind });
    if (have.length === 0) await ctx.host.resources.create({ kind });
  }
}

/**
 * Starts an attempt of a source: numbered after the ones before, filed under its book, with the items fixed now.
 * `limit` in minutes (0: none).
 */
export async function startAttempt(ctx, { source, sourceKind, name, book, items, limit, settings }) {
  const before = source ? await attemptsOf(ctx, source) : [];
  const number = before.length + 1;
  const parent = await folderOf(ctx, book);
  return ctx.host.resources.create({
    kind: "attempt",
    parent: parent || undefined,
    name: say(ctx, "attempt.name", { name, n: number }),
    body: {
      source: source || null,
      sourceKind,
      sourceName: name,
      book: book ? book.id : null,
      number,
      status: "doing",
      started: now(),
      submitted: null,
      limit: Number(limit) > 0 ? Number(limit) : 0,
      items,
      settings: settings || {},
      results: {},
      score: 0,
      total: 0,
      snapshot: {},
    },
  });
}

/** Marks every question of an attempt: `{ results, score, total, pending }`. */
export function markAll(markFn, qs, items, body, partial) {
  const results = {};
  let score = 0;
  let total = 0;
  let pending = 0;
  for (const it of items) {
    if (!it.q) continue;
    const e = qs.get(it.q);
    if (!e) continue;
    const kept = body.results && body.results[it.q];
    // A teacher's mark stays.
    const r = kept && kept.by === "teacher" ? kept : markFn(e.q, givenOf(body, it.q, e.q.blanks), partial);
    results[it.q] = r;
    score += r.score;
    total += r.max;
    if (r.state === "pending") pending++;
  }
  return { results, score: Math.round(score * 100) / 100, total, pending };
}
