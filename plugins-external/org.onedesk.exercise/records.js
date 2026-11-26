// Learning records (学习记录, docs/redesign/book.md §19.4, §19.8): an attempt (answered, handed in, marked), the
// grades sheet and the mistake book — all worked out from the attempts.

import { partsOf, shortStem } from "./question.js";
import { markEntry, openAll } from "./sealed.js";
import { ensureLedgers, full, givenOf, markAll, now, questionsOf, say, startAttempt, str } from "./common.js";
import { questionNodes } from "./answering.js";
import { snapshotOf } from "./practice.js";

const bound = (qid, i) => `body.a.${qid}.${i}`;

/** The questions of an attempt: as they are now while it is open; as they were when handed in, after. */
async function attemptQuestions(ctx, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (body.status === "submitted" && body.snapshot) {
    const qs = new Map();
    for (const [qid, s] of Object.entries(body.snapshot)) {
      // Held back: no answers in the snapshot either (opened when shown).
      const b = { ...s };
      if (s.held) delete b.answers;
      qs.set(qid, { res: { id: qid, name: s.name, tags: s.tags || [], body: b, ...(s.held ? { copy: { held: true } } : {}) }, q: partsOf(s) });
    }
    return { items, qs };
  }
  return { items, qs: await questionsOf(ctx, items) };
}

/** The answers as the reader sees them now: unsaved typing over what was saved. */
function bodyNow(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  if (ctx.draft) for (const [k, v] of Object.entries(ctx.draft)) if (k.startsWith("body.a.")) b[k.slice(5)] = v;
  return b;
}

function minutesLeft(body) {
  if (!body.limit) return null;
  return Math.ceil((body.started + body.limit * 60000 - now()) / 60000);
}

export async function renderAttempt(ctx) {
  const a = ctx.resource;
  if (!a || !a.id) return { view: [{ type: "text", id: "none", text: say(ctx, "attempt.new"), tone: "muted" }] };
  const body = bodyNow(ctx);
  const s = body.settings || {};
  const { items, qs } = await attemptQuestions(ctx, body);
  const done = body.status === "submitted";
  const head = [`**${say(ctx, "attempt.of", { name: str(body.sourceName), n: body.number })}**`];
  if (done) {
    head.push(say(ctx, "attempt.handedIn", { score: body.score, total: body.total }) + (body.overtime ? `　${say(ctx, "attempt.overtime")}` : ""));
    // D487 §21: the teacher has not released the answers yet.
    if (Object.values(body.results || {}).some((r) => r && r.state === "awaiting")) head.push(say(ctx, "attempt.awaiting"));
  } else {
    const left = minutesLeft(body);
    head.push(left === null ? say(ctx, "attempt.noLimit") : left > 0 ? say(ctx, "attempt.left", { m: left }) : say(ctx, "attempt.timeUp"));
  }
  const view = [{ type: "text", id: "head", text: head.join("\n\n"), format: "markdown" }];
  // While answering, “each” marks every answered question as it goes; after handing in, every question.
  let marks = null;
  if (done) marks = body.results || {};
  else if (s.timing === "each") {
    marks = {};
    for (const [qid, e] of qs) {
      const m = await markEntry(ctx, e, givenOf(body, qid, e.q.blanks), s.partial);
      if (m.state !== "empty") marks[qid] = m;
    }
  }
  const saved = (ctx.resource && ctx.resource.body) || {};
  const lock = (qid) => done || (s.editable === false && givenOf(saved, qid, (qs.get(qid) || { q: { blanks: 1 } }).q.blanks).some((x) => x.trim()));
  const reveal = done || s.timing === "each";
  if (reveal) await openAll(ctx, qs);
  const { view: nodes } = questionNodes(ctx, items, qs, { name: bound, marks, reveal, lock, bind: true });
  view.push(...nodes);
  // Questions a teacher marks: “right” and “wrong” beside each one waiting.
  if (done) {
    const waiting = Object.entries(body.results || {}).filter(([, r]) => r.state === "pending");
    if (waiting.length > 0) {
      view.push({
        type: "table",
        id: "pending",
        columns: [{ key: "q", label: say(ctx, "col.pending") }],
        rows: waiting.map(([qid]) => [qs.get(qid) ? shortStem(qs.get(qid).q) : qid]),
        rowKeys: waiting.map(([qid]) => qid),
        rowActions: [
          { id: "markRight", label: ctx.t("action.markRight"), icon: "check" },
          { id: "markWrong", label: ctx.t("action.markWrong"), icon: "x" },
        ],
      });
    }
  }
  return { view, readOnly: done || undefined };
}

/** Hands an attempt in: the answers (with what was typed but not saved), marked; the questions kept as they are now. */
export async function submitAttempt(ctx) {
  const a = ctx.resource;
  if (a.body.status === "submitted") return { message: ctx.t("attempt.already") };
  const body = bodyNow(ctx);
  const s = body.settings || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const qs = await questionsOf(ctx, items);
  const m = await markAll(ctx, qs, items, body, s.partial);
  const changes = {};
  for (const [k, v] of Object.entries(body)) if (k.startsWith("a.")) changes[`body.${k}`] = v;
  const over = body.limit ? now() > body.started + body.limit * 60000 : false;
  Object.assign(changes, {
    "body.status": "submitted",
    "body.submitted": now(),
    "body.results": m.results,
    "body.score": m.score,
    "body.total": m.total,
    "body.snapshot": snapshotOf(qs),
    "body.overtime": over,
  });
  await ctx.host.resources.update(a.id, changes);
  await ensureLedgers(ctx);
  const draft = {};
  if (ctx.draft) for (const [k, v] of Object.entries(ctx.draft)) if (k.startsWith("body.a.")) draft[k] = v;
  return { changes: draft, message: say(ctx, m.pending ? "attempt.markedPending" : "attempt.marked", { score: m.score, total: m.total, n: m.pending }) };
}

/** A teacher's mark on a question waiting for one. */
export async function teacherMark(ctx, qid, right) {
  const a = ctx.resource;
  const results = Object.assign({}, a.body.results || {});
  const r = results[qid];
  if (!r) return undefined;
  results[qid] = { state: right ? "right" : "wrong", score: right ? r.max : 0, max: r.max, by: "teacher" };
  const score = Math.round(Object.values(results).reduce((x, y) => x + y.score, 0) * 100) / 100;
  await ctx.host.resources.update(a.id, { "body.results": results, "body.score": score });
  return { message: say(ctx, "attempt.handedIn", { score, total: a.body.total }) };
}

/* ------------------------------------------------------------------ grades and mistakes */

async function submitted(ctx) {
  return (await ctx.host.resources.list({ kind: "attempt" })).filter((a) => a.body && a.body.status === "submitted").sort((x, y) => Number(x.body.submitted) - Number(y.body.submitted));
}

const day = (ms) => {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** By test (and practice): how often, best, last; by knowledge point (the questions' tags): how many right. */
export async function renderGrades(ctx) {
  // A book's record folder shows that book's grades.
  const only = ctx.resource && ctx.resource.kind === full("subject") ? ctx.resource.body && ctx.resource.body.book : null;
  // D487 §35: answers that came by letter are shown in their own folder, not among one's own.
  const all = (await submitted(ctx)).filter((a) => (only ? a.body.book === only : !a.body.from));
  if (all.length === 0) return { view: [{ type: "text", id: "empty", text: say(ctx, "grades.empty"), tone: "muted" }] };
  const bySource = new Map();
  for (const a of all) {
    const key = a.body.source || a.id;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(a);
  }
  const rows = [];
  const targets = [];
  for (const list of bySource.values()) {
    const last = list[list.length - 1];
    const best = list.reduce((m, a) => (Number(a.body.score) > Number(m.body.score) ? a : m), list[0]);
    rows.push([str(last.body.sourceName), String(list.length), String(best.body.score), String(last.body.score), String(last.body.total), day(last.body.submitted)]);
    targets.push(`resource:${last.id}`);
  }
  const view = [
    { type: "text", id: "byTestTitle", text: `**${say(ctx, "grades.byTest")}**`, format: "markdown" },
    {
      type: "table",
      id: "byTest",
      columns: ["test", "times", "best", "last", "total", "date"].map((k) => ({ key: k, label: say(ctx, `grades.col.${k}`), numeric: ["times", "best", "last", "total"].includes(k) })),
      rows,
      rowTargets: targets,
    },
  ];
  const tags = new Map();
  for (const a of all)
    for (const [qid, r] of Object.entries(a.body.results || {})) {
      if (r.state === "pending" || r.state === "empty" || r.state === "awaiting") continue;
      for (const t of (a.body.snapshot && a.body.snapshot[qid] && a.body.snapshot[qid].tags) || []) {
        const c = tags.get(t) || { n: 0, right: 0 };
        c.n += 1;
        if (r.state === "right") c.right += 1;
        tags.set(t, c);
      }
    }
  if (tags.size > 0) {
    const list = [...tags.entries()].sort((x, y) => x[1].right / x[1].n - y[1].right / y[1].n);
    view.push({ type: "text", id: "byTagTitle", text: `**${say(ctx, "grades.byTag")}**`, format: "markdown" });
    view.push({
      type: "table",
      id: "byTag",
      columns: ["tag", "n", "right", "rate"].map((k) => ({ key: k, label: say(ctx, `grades.col.${k}`), numeric: k !== "tag" })),
      rows: list.map(([t, c]) => [t, String(c.n), String(c.right), `${Math.round((c.right * 100) / c.n)}%`]),
    });
  }
  return { view };
}

/** The questions got wrong and not right since, newest mistake first. */
export async function mistakesOf(ctx) {
  const all = (await submitted(ctx)).filter((a) => !a.body.from);
  const per = new Map();
  for (const a of all)
    for (const [qid, r] of Object.entries(a.body.results || {})) {
      if (r.state === "empty" || r.state === "pending" || r.state === "awaiting") continue;
      const p = per.get(qid) || { wrong: 0, last: null, source: "", when: 0, snap: null };
      if (r.state !== "right") p.wrong += 1;
      p.last = r.state;
      p.source = str(a.body.sourceName);
      p.when = Number(a.body.submitted);
      p.snap = (a.body.snapshot && a.body.snapshot[qid]) || p.snap;
      per.set(qid, p);
    }
  return [...per.entries()].filter(([, p]) => p.last !== "right").sort((x, y) => y[1].when - x[1].when);
}

export async function renderMistakes(ctx) {
  const list = await mistakesOf(ctx);
  if (list.length === 0) return { view: [{ type: "text", id: "empty", text: say(ctx, "mistakes.empty"), tone: "muted" }] };
  return {
    view: [
      {
        type: "table",
        id: "mistakes",
        columns: ["q", "tags", "from", "times", "date"].map((k) => ({ key: k, label: say(ctx, `mistakes.col.${k}`), numeric: k === "times" })),
        rows: list.map(([, p]) => [p.snap ? shortStem(partsOf(p.snap)) : "", ((p.snap && p.snap.tags) || []).join("、"), p.source, String(p.wrong), day(p.when)]),
        rowTargets: list.map(([qid]) => `resource:${qid}`),
      },
    ],
  };
}

/** “Once more”: the mistakes as a new attempt, opened. */
export async function retryMistakes(ctx) {
  const list = await mistakesOf(ctx);
  if (list.length === 0) return { message: ctx.t("mistakes.empty") };
  const items = list.map(([qid]) => ({ q: qid }));
  const a = await startAttempt(ctx, { source: ctx.resource.id, sourceKind: "retry", name: say(ctx, "mistakes.retryName"), book: null, items, limit: 0, settings: { timing: "submit", editable: true } });
  await ctx.host.ui.open(`resource:${a.id}`);
  return undefined;
}
