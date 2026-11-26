// Review by letter (审签, docs/redesign/book.md §35.6, interface `onedesk.letter/1`): a document can be sent to someone to
// review (sign) or read. The reviewer writes a review record — agree or not, an opinion — stamped with their signature
// (K6, signed with their identity K18); it goes back; the sender's document then lists who reviewed it and how.

import { NONE, say, str } from "./common.js";

export const SIGNOFF = "signoff";

const agreeText = (ctx, a) => say(ctx, a === "disagree" ? "signoff.disagree" : "signoff.agree");

async function ownSignoff(ctx, docId) {
  return (await ctx.host.resources.list({ kind: SIGNOFF })).find((s) => s.body && s.body.document === docId && !s.body.from) || null;
}

/** What a document shows of reviews: those that came back (under it), and, in a letter, the reviewer's own form. */
export async function signoffNodes(ctx, signerField) {
  const res = ctx.resource || {};
  if (!res.id) return [];
  const out = [];
  const back = await ctx.host.resources.list({ kind: SIGNOFF, parent: res.id });
  if (back.length > 0) {
    const lines = [`**${say(ctx, "signoff.title")}**`, ""];
    for (const s of back) {
      const b = s.body || {};
      const who = str(b.from && b.from.name) || str(b.signer);
      const how = b.from ? say(ctx, `signoff.known.${b.from.known || "unknown"}`) : "";
      let line = say(ctx, "signoff.line", { who, how: agreeText(ctx, b.agree) });
      if (str(b.comment)) line = say(ctx, "signoff.withComment", { line, comment: str(b.comment) });
      if (how) line = say(ctx, "signoff.withSig", { line, sig: how });
      lines.push(`- ${line}`);
    }
    out.push({ type: "text", id: "signoffs", text: lines.join("\n"), format: "markdown" });
  }
  if (res.origin === "subscribed") {
    const info = await ctx.host.letters.info(res.id);
    const asked = info && info.dir === "in" && (info.tasks || []).some((t) => t.page === res.id && t.task === "sign");
    if (asked) {
      const mine = await ownSignoff(ctx, res.id);
      if (mine) out.push({ type: "text", id: "mine", text: say(ctx, "signoff.done", { how: agreeText(ctx, mine.body.agree), comment: str(mine.body.comment) }), tone: "muted" });
      else
        out.push({
          type: "form",
          id: "review",
          layout: "strip",
          fields: [
            { name: "agree", label: say(ctx, "field.agree"), kind: "enum", param: true, options: [{ value: "agree", label: say(ctx, "signoff.agree") }, { value: "disagree", label: say(ctx, "signoff.disagree") }] },
            { name: "opinion", label: say(ctx, "field.opinion"), kind: "text", param: true },
            await signerField(ctx),
          ],
        });
    }
  }
  return out;
}

/** “Review”: in a letter that asks for it, the review record — made under the letter, stamped with the signature. */
export async function signoff(ctx, signerOf) {
  const res = ctx.resource;
  const info = res && res.origin === "subscribed" ? await ctx.host.letters.info(res.id) : null;
  if (!info || info.dir !== "in") return { message: say(ctx, "signoff.notLetter") };
  if (await ownSignoff(ctx, res.id)) return { message: say(ctx, "signoff.already") };
  const signer = await signerOf(ctx);
  if (!signer) return { message: ctx.t("sign.noSigner") };
  const agree = str(ctx.params && ctx.params.agree) === "disagree" ? "disagree" : "agree";
  const comment = str(ctx.params && ctx.params.opinion).trim();
  const made = await ctx.host.resources.create({ kind: SIGNOFF, parent: info.resource, name: say(ctx, "signoff.name", { name: res.name }), body: { document: res.id, documentName: res.name, agree, comment, signer } });
  await ctx.host.resources.stamp(made.id, { label: say(ctx, "stamp.signoff"), signer });
  return { message: say(ctx, "signoff.signed", { how: agreeText(ctx, agree) }) };
}

/** A review record's page: read only. */
export function renderSignoff(ctx) {
  const b = (ctx.resource && ctx.resource.body) || {};
  const who = str(b.from && b.from.name) || str(b.signer);
  const lines = [`**${str(b.documentName)}**`, "", say(ctx, "signoff.line", { who, how: agreeText(ctx, b.agree) })];
  if (str(b.comment)) lines.push("", str(b.comment));
  return { view: [{ type: "text", id: "signoff", text: lines.join("\n"), format: "markdown" }], readOnly: true };
}

/* ------------------------------------------------------------------ onedesk.letter/1 */

export async function letterTasks(ctx) {
  const short = String((ctx.resource && ctx.resource.kind) || "").split(":").pop();
  return { output: NONE, data: { tasks: short === "document" ? [{ task: "sign", label: say(ctx, "letter.task.sign") }, { task: "read", label: say(ctx, "letter.task.read") }] : [] } };
}

export async function letterTodo(ctx, input) {
  const task = input && input.task;
  const mine = ctx.resource ? await ownSignoff(ctx, ctx.resource.id) : null;
  if (mine) return { output: NONE, data: { state: "done", summary: agreeText(ctx, mine.body.agree) } };
  // Reading asks nothing to be written: opening it is reading it.
  if (task === "read") return { output: NONE, data: { state: "done", summary: say(ctx, "letter.read") } };
  return { output: NONE, data: { state: "todo", summary: "" } };
}

export async function letterReply(ctx, input) {
  const mine = ctx.resource ? await ownSignoff(ctx, ctx.resource.id) : null;
  if (mine) {
    const b = mine.body || {};
    return { output: NONE, data: { data: { agree: b.agree, comment: b.comment, signer: b.signer, at: mine.createdAt }, summary: str(b.comment) ? say(ctx, "signoff.summary", { how: agreeText(ctx, b.agree), comment: str(b.comment) }) : agreeText(ctx, b.agree) } };
  }
  if (input && input.task === "read") return { output: NONE, data: { data: { read: true }, summary: say(ctx, "letter.read") } };
  return { output: NONE, data: {} };
}

/** A review came back: recorded under the sender's document, with who signed the reply. */
export async function onLetterReply(ctx, e) {
  if (!e || !e.page || !e.data || typeof e.data !== "object" || e.task !== "sign") return;
  const doc = await ctx.host.resources.get(e.page);
  if (!doc) return;
  const d = e.data;
  const who = str(e.from && e.from.name) || str(d.signer);
  const agree = d.agree === "disagree" ? "disagree" : "agree";
  await ctx.host.resources.create({
    kind: SIGNOFF,
    parent: doc.id,
    name: say(ctx, "signoff.line", { who, how: agreeText(ctx, agree) }),
    body: { document: doc.id, documentName: doc.name, agree, comment: str(d.comment), signer: str(d.signer), from: e.from || null, at: d.at || null },
  });
}
