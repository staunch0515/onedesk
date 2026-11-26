// The run log (运行记录, docs/redesign/book.md §25.6): one carrying-out of a procedure, step by step — like the sheet
// filled in while working through a checklist. Written only by the flow; read only; exported as a report.

import { clock, full, say, str } from "./common.js";
import { recordNodes } from "./step.js";

export const LOG_KIND = full("log");
const MARK = { ok: "✓", failed: "✗", skipped: "⏭", waiting: "⏸", confirmed: "✓" };

async function stepNames(ctx, log) {
  const out = [];
  for (const [id, rec] of Object.entries(log.body.steps || {})) out.push({ id, rec });
  return out;
}

function headOf(ctx, b) {
  return [
    say(ctx, "log.head", { n: b.number, operator: b.operator || "—", started: clock(b.started) }),
    b.ended ? say(ctx, "log.ended", { at: clock(b.ended) }) : say(ctx, `status.${b.status === "done" ? "done" : b.status === "waiting" ? "waitingShort" : b.status === "failed" ? "failedShort" : "running"}`),
  ].join("　");
}

export async function renderLog(ctx) {
  const log = ctx.resource;
  if (!log || !log.id || !log.body || !log.body.flow) return { view: [{ type: "text", id: "none", text: say(ctx, "log.none"), tone: "muted" }] };
  const rows = await stepNames(ctx, log);
  const view = [{ type: "text", id: "head", text: headOf(ctx, log.body), tone: "muted" }];
  if (rows.length === 0) return { view: [...view, { type: "text", id: "empty", text: say(ctx, "log.empty"), tone: "muted" }], readOnly: true };
  view.push({
    type: "table",
    id: "steps",
    columns: [
      { key: "step", label: say(ctx, "col.step") },
      { key: "state", label: say(ctx, "col.state") },
      { key: "ms", label: say(ctx, "col.ms"), numeric: true },
      { key: "summary", label: say(ctx, "col.summary") },
    ],
    rows: rows.map(({ rec }) => [rec.name, `${MARK[rec.state] || "·"} ${say(ctx, `state.${rec.state}`)}`, String(rec.ms ?? 0), str(rec.error || rec.text).split("\n")[0].slice(0, 80)]),
    rowKeys: rows.map((r) => r.id),
    selectParam: "view.row",
  });
  const sel = ctx.params && ctx.params["view.row"];
  const picked = rows.find((r) => r.id === sel);
  if (picked) {
    view.push({ type: "text", id: "detailTitle", text: `**${picked.rec.name}**`, format: "markdown" });
    if (picked.rec.inputs && Object.keys(picked.rec.inputs).length) view.push({ type: "text", id: "inputs", text: Object.entries(picked.rec.inputs).map(([k, v]) => `${k} = ${v}`).join("\n"), mono: true });
    view.push(...recordNodes(ctx, picked.rec, "d"));
  }
  return { view, readOnly: true };
}

/** The report: the log as Markdown. */
export function reportOf(ctx, log) {
  const b = log.body;
  const out = [`# ${log.name}`, "", headOf(ctx, b), ""];
  for (const [, rec] of Object.entries(b.steps || {})) {
    out.push(`## ${MARK[rec.state] || "·"} ${rec.name}`, "");
    out.push(`- ${say(ctx, "col.state")}：${say(ctx, `state.${rec.state}`)}；${say(ctx, "step.ms", { ms: rec.ms ?? 0 })}；${clock(rec.at)}`);
    if (rec.confirmedAt) out.push(`- ${say(ctx, "step.confirmedBy", { who: rec.confirmedBy || "—" })}（${clock(rec.confirmedAt)}）`);
    for (const [k, v] of Object.entries(rec.inputs || {})) out.push(`- ${k} = ${v}`);
    for (const c of [...(rec.when || []), ...(rec.expect || [])]) out.push(`- ${c.ok ? "✓" : "✗"} ${c.line}`);
    if (rec.error) out.push(`- ${say(ctx, "step.error", { error: rec.error })}`);
    if (rec.table) {
      out.push("", `| ${rec.table.columns.join(" | ")} |`, `| ${rec.table.columns.map(() => "---").join(" | ")} |`);
      for (const r of rec.table.rows.slice(0, 50)) out.push(`| ${r.map((x) => str(typeof x === "object" && x !== null ? JSON.stringify(x) : x).replace(/\|/g, "\\|")).join(" | ")} |`);
    } else if (rec.text) out.push("", "```", rec.text.slice(0, 4000), "```");
    out.push("");
  }
  return out.join("\n");
}

const BAD_NAME = /[\\/:*?"<>|\n]/g;

export async function exportAction(ctx) {
  const log = ctx.resource;
  const roots = await ctx.host.files.roots();
  if (!roots || roots.length === 0) {
    try {
      await ctx.host.files.addRoot();
    } catch {
      // the message says what to do
    }
    const text = say(ctx, "export.pickFolder");
    return { output: { type: "text", text }, failed: { message: text } };
  }
  const folder = roots[0].path;
  const stem = (log.name.replace(BAD_NAME, "-").trim() || "log");
  let path = `${folder}/${stem}.md`;
  for (let i = 2; i < 1000; i++) {
    try {
      await ctx.host.files.stat(path);
      path = `${folder}/${stem} ${i}.md`;
    } catch {
      break;
    }
  }
  await ctx.host.files.writeText(path, reportOf(ctx, log));
  return { output: { type: "text", text: say(ctx, "export.done", { path }) } };
}
