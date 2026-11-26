// The step (步骤页, docs/redesign/book.md §25.3): one step of a procedure — what to do, what to run, the values it is
// given, what should be seen after it (expectations), when to skip it, whether to stop for a confirmation — and what
// it gave the last time it was carried out.

import { bodyNow, parentOf, say, str } from "./common.js";
import { carryOn, newLog, runStep, STEP, stepsOf } from "./engine.js";
import { parseLines } from "./compare.js";
import { currentLog, flowOfBook } from "./flow.js";

/** Kinds a step can run (those with a run of their own). */
export const RUNNABLE = ["org.onedesk.http:request", "org.onedesk.sql:query", "org.onedesk.command:command", "org.onedesk.script:script", "org.onedesk.prompt:prompt"];
const MARK = { ok: "✓", failed: "✗", skipped: "⏭", waiting: "⏸", confirmed: "✓" };

/** The step's record in its flow's current log, with the log. */
export async function lastOf(ctx, step) {
  const book = await parentOf(ctx, step);
  if (!book) return {};
  const flow = await flowOfBook(ctx, book.id);
  if (!flow) return { book };
  const log = await currentLog(ctx, flow.id);
  return { book, flow, log, rec: log && log.body.steps ? log.body.steps[step.id] : null };
}

const short = (v) => {
  const s = typeof v === "object" ? JSON.stringify(v) : str(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

/** What a record shows: state and time, checks, output, the values a later step can use. */
export function recordNodes(ctx, rec, prefix = "r") {
  if (!rec) return [{ type: "text", id: `${prefix}-none`, text: say(ctx, "step.notRun"), tone: "muted" }];
  const lines = [`${MARK[rec.state] || "·"} ${say(ctx, `state.${rec.state}`)}　${say(ctx, "step.ms", { ms: rec.ms ?? 0 })}`];
  if (rec.confirmedAt) lines.push(say(ctx, "step.confirmedBy", { who: rec.confirmedBy || "—" }));
  if (rec.error) lines.push(say(ctx, "step.error", { error: rec.error }));
  for (const c of [...(rec.when || []), ...(rec.expect || [])]) lines.push(`${c.ok ? "✓" : "✗"} ${c.line}${c.error ? `（${say(ctx, `compare.${c.error}`)}）` : `　（${short(c.left)}${c.right !== undefined ? ` / ${short(c.right)}` : ""}）`}`);
  const view = [{ type: "text", id: `${prefix}-state`, text: lines.join("\n"), tone: rec.state === "failed" ? "danger" : undefined }];
  if (rec.table) view.push({ type: "table", id: `${prefix}-table`, columns: rec.table.columns.map((c) => ({ key: c, label: c })), rows: rec.table.rows.slice(0, 20).map((r) => r.map((x) => (x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : x))) });
  else if (rec.text) view.push({ type: "text", id: `${prefix}-out`, text: rec.text.length > 4000 ? `${rec.text.slice(0, 4000)}…` : rec.text, mono: true });
  const vals = [];
  for (const [k, v] of Object.entries(rec.data || {})) vals.push([`@${rec.name}.${k}`, short(v)]);
  for (const [k, v] of Object.entries(rec.first || {})) if (!(rec.data && k in rec.data)) vals.push([`@${rec.name}.${k}`, short(v)]);
  if (vals.length) {
    view.push({ type: "text", id: `${prefix}-valuesTitle`, text: `**${say(ctx, "step.values")}**`, format: "markdown" });
    view.push({ type: "table", id: `${prefix}-values`, columns: [{ key: "name", label: say(ctx, "col.value") }, { key: "value", label: say(ctx, "col.now") }], rows: vals });
  }
  return view;
}

export async function renderStep(ctx) {
  const b = bodyNow(ctx);
  const f = (name, kind, extra = {}) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...extra });
  const view = [
    {
      type: "form",
      id: "step",
      layout: "stack",
      fields: [
        f("text", "longtext", { placeholder: ctx.t("field.text.placeholder") }),
        f("target", "ref", { kinds: RUNNABLE, hint: ctx.t("field.target.hint") }),
        f("inputs", "longtext", { placeholder: ctx.t("field.inputs.placeholder"), hint: ctx.t("field.inputs.hint") }),
        f("expect", "longtext", { placeholder: ctx.t("field.expect.placeholder"), hint: ctx.t("field.compare.hint") }),
        f("when", "text", { placeholder: ctx.t("field.when.placeholder") }),
        f("confirm", "text", { placeholder: ctx.t("field.confirm.placeholder") }),
      ],
    },
  ];
  const bad = [...parseLines(b.expect), ...parseLines(b.when)].filter((p) => p.error);
  if (bad.length) view.push({ type: "text", id: "bad", text: say(ctx, "compare.noOperator"), tone: "danger" });
  if (!ctx.resource || !ctx.resource.id) return { view };
  const { rec } = await lastOf(ctx, ctx.resource);
  view.push({ type: "text", id: "lastTitle", text: `**${say(ctx, "step.last")}**`, format: "markdown" });
  view.push(...recordNodes(ctx, rec));
  return { view };
}

/** In a book being read: the instructions, then what it gave in the current run. */
export async function embedStep(ctx) {
  const s = ctx.resource;
  const view = [];
  if (str(s.body && s.body.text).trim()) view.push({ type: "text", id: "text", text: s.body.text, format: "markdown" });
  if (str(s.body && s.body.confirm).trim()) view.push({ type: "text", id: "confirm", text: `⏸ ${s.body.confirm}`, tone: "muted" });
  const { rec } = await lastOf(ctx, s);
  if (rec) view.push(...recordNodes(ctx, rec));
  return { view };
}

/** “Run this step”: only it, with the values of the current log (made when there is none), written into that log. */
export async function runOneAction(ctx) {
  const step = ctx.resource;
  const { book, flow, log: current } = await lastOf(ctx, step);
  if (!book || !flow) return { output: { type: "text", text: say(ctx, "step.noFlow") }, failed: { message: say(ctx, "step.noFlow") } };
  let log = current;
  if (!log) {
    log = await newLog(ctx, { id: flow.id }, book, str(ctx.params && ctx.params.operator));
    await ctx.host.storage.set(`current:${flow.id}`, log.id);
  }
  const rec = await runStep(ctx, step, log);
  const steps = { ...(log.body.steps || {}), [step.id]: rec };
  await ctx.host.resources.update(log.id, { "body.steps": steps });
  const text = `${MARK[rec.state] || "·"} ${say(ctx, `state.${rec.state}`)}${rec.error ? ` — ${rec.error}` : ""}`;
  return rec.state === "failed" ? { output: { type: "text", text }, failed: { message: text } } : { output: { type: "text", text } };
}

export { STEP, carryOn, stepsOf };
