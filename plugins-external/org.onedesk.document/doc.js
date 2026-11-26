// A document (文书, docs/redesign/book.md §23.4): written from a template — its text copied, the items filled in right
// in the text; signed level by level (the first signature checks what is required and fixes the text: the values and
// the environment's values are written in, and the kernel keeps what references show — a stamp, K6); revised with a
// reason; voided with a stamp of its own.

import { allWords, bodyNow, enteredOf, full, levelsOf, say, str } from "./common.js";
import { checkValues, fieldKind, itemsOf, outOfRange, replaceItems, shown, valuesOf, withValues } from "./items.js";
import { filled, holeValues } from "./template.js";

export const DOCUMENT = full("document");
export const TEMPLATE = full("template");

/** Where a document stands: its signatures, whether it is void, the next level to sign. */
export function stateOf(ctx, res) {
  const stamps = Array.isArray(res && res.stamps) ? res.stamps : [];
  const voidWords = allWords(ctx, "stamp.void");
  const voided = stamps.some((s) => voidWords.includes(s.label));
  const signed = stamps.filter((s) => !voidWords.includes(s.label));
  const levels = levelsOf(ctx, res && res.body && res.body.levels);
  return { stamps, voided, signed, levels, next: voided ? null : (levels[signed.length] ?? null), done: !voided && signed.length >= levels.length };
}

/** The text as it is to be filled: the environment's values in, the items read, their values (entered, else default). */
export async function prepared(ctx, text, entered) {
  const t = await filled(ctx, str(text));
  const items = itemsOf(t);
  return { text: t, items, values: valuesOf(items, entered) };
}

/** For reading: each item's value (with its unit); “not filled” for an empty one; out of range marked. */
export function readText(ctx, p) {
  const t = replaceItems(p.text, (it) => {
    if (it.error) return it.raw;
    const v = shown(ctx, it, p.values[it.name]);
    if (!v) return `*${say(ctx, "item.unfilled")}*`;
    return outOfRange(it, p.values[it.name]) ? `**${v}** ⚠ ${say(ctx, "item.outOfRange", { min: it.min, max: it.max })}` : v;
  });
  // A form's lines stay lines when read (Markdown would run them together).
  return withValues(t, p.values).replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

/** For filling in: a flow (K4) — each item's control at its place, the unit after it, out of range marked. */
export function flowOf(ctx, p, id = "fill") {
  const fields = [];
  const text = replaceItems(p.text, (it) => {
    if (it.error) return `**⚠ ${it.raw}**`;
    const f = { name: it.name, label: it.name, kind: fieldKind(it), bind: `body.v.${it.name}` };
    if (it.options.length) f.options = it.options.map((o) => ({ value: o, label: o }));
    if (it.def && !/^\{\{/.test(it.def)) f.envValue = it.def;
    fields.push(f);
    // Required is checked when signing (a draft may be saved half filled): only said here.
    let after = it.unit && it.type === "number" ? ` ${it.unit}` : "";
    if (it.required) after += ` ${say(ctx, "item.required")}`;
    if (outOfRange(it, p.values[it.name])) after += ` ⚠ ${say(ctx, "item.outOfRange", { min: it.min, max: it.max })}`;
    return `{{field:${it.name}}}${after}`;
  });
  return { type: "flow", id, text: withValues(text, p.values), fields };
}

/** What a page or an embed reads: the text fixed when it was first signed, else the text with the values. */
export async function readingOf(ctx, res, body) {
  if (stateOf(ctx, res).stamps.length > 0 && typeof body.signedText === "string") return body.signedText;
  return readText(ctx, await prepared(ctx, body.text, enteredOf(body)));
}

function statusLine(ctx, st) {
  if (st.voided) return say(ctx, "status.void");
  const parts = st.signed.map((s) => say(ctx, "status.signedBy", { label: s.label, signer: s.signer }));
  if (st.signed.length === 0) return say(ctx, "status.draft");
  if (st.done) return `${parts.join("　")}　${say(ctx, "status.done")}`;
  return `${parts.join("　")}　${say(ctx, "status.waiting", { level: st.next })}`;
}

async function signerField(ctx) {
  const f = { name: "signer", label: ctx.t("field.signer"), kind: "text", param: true };
  try {
    const found = await ctx.host.params.get(say(ctx, "env.signer"));
    if (found && found.found) {
      f.envValue = String(found.value);
      f.envSource = found.sourceName;
    }
  } catch {
    // no environment
  }
  return f;
}

export async function renderDocument(ctx) {
  const res = ctx.resource || {};
  const body = bodyNow(ctx);
  const templateField = { name: "template", label: ctx.t("field.template"), kind: "ref", kinds: ["template"], bind: "body.template" };
  // New (or no text yet): choose the template; its text comes over when saved.
  if (!str(body.text)) {
    const view = [{ type: "form", id: "choose", layout: "strip", fields: [templateField] }];
    let tpl = null;
    if (body.template) {
      try {
        tpl = await ctx.host.resources.get(body.template);
      } catch {
        tpl = null;
      }
    }
    if (!tpl) {
      view.push({ type: "text", id: "hint", text: say(ctx, "doc.chooseTemplate"), tone: "muted" });
      return { view };
    }
    view.push({ type: "text", id: "hint", text: say(ctx, "doc.fromTemplate", { name: tpl.name }), tone: "muted" });
    view.push(flowOf(ctx, await prepared(ctx, tpl.body && tpl.body.text, enteredOf(body))));
    return { view };
  }
  const st = stateOf(ctx, res);
  const view = [{ type: "text", id: "status", text: statusLine(ctx, st), tone: st.voided ? "danger" : "muted" }];
  // Signed or void: read only, as fixed.
  if (st.stamps.length > 0) {
    view.push({ type: "text", id: "reading", text: await readingOf(ctx, res, body), format: "markdown" });
    const fields = [];
    if (!st.voided && !st.done) fields.push(await signerField(ctx));
    if (!st.voided) fields.push({ name: "reason", label: ctx.t("field.reason"), kind: "text", param: true });
    if (fields.length) view.push({ type: "form", id: "sign", layout: "strip", fields });
    return { view, readOnly: true };
  }
  // The text itself (the free words and the items' writing).
  if (ctx.params && ctx.params["view.mode"] === "source") {
    view.push({
      type: "form",
      id: "source",
      layout: "stack",
      fields: [
        { name: "text", label: ctx.t("field.text"), kind: "longtext", bind: "body.text", fill: true },
        { name: "levels", label: ctx.t("field.levels"), kind: "text", bind: "body.levels", hint: ctx.t("field.levels.hint") },
      ],
    });
    return { view };
  }
  view.push(flowOf(ctx, await prepared(ctx, body.text, enteredOf(body))));
  view.push({ type: "form", id: "sign", layout: "strip", fields: [await signerField(ctx)] });
  return { view };
}

async function signerOf(ctx) {
  const typed = str(ctx.params && ctx.params.signer).trim();
  if (typed) return typed;
  const { values } = await holeValues(ctx, [say(ctx, "env.signer")]);
  return str(values[say(ctx, "env.signer")]).trim();
}

/** Typed and not saved: a document is signed as it is saved. */
function unsaved(ctx) {
  const saved = (ctx.resource && ctx.resource.body) || {};
  const same = (a, b) => String(a ?? "") === String(b ?? "");
  return Object.entries(ctx.draft || {}).some(([k, v]) => k.startsWith("body.") && !same(v, saved[k.slice(5)]));
}

/** “Sign”: the next level. The first one checks, fixes the text and puts the first stamp on. */
async function sign(ctx) {
  const res = ctx.resource;
  const st = stateOf(ctx, res);
  if (unsaved(ctx)) return { message: ctx.t("sign.saveFirst") };
  if (st.voided) return { message: ctx.t("sign.void") };
  if (st.done) return { message: ctx.t("sign.done") };
  const signer = await signerOf(ctx);
  if (!signer) return { message: ctx.t("sign.noSigner") };
  if (st.stamps.length === 0) {
    const body = bodyNow(ctx);
    const p = await prepared(ctx, body.text, enteredOf(body));
    const bad = p.items.filter((it) => it.error);
    if (bad.length) return { message: say(ctx, "sign.badItems", { names: bad.map((b) => b.raw).join("、") }) };
    const check = checkValues(p.items, p.values);
    if (check.missing.length) return { message: say(ctx, "sign.missing", { names: check.missing.join("、") }) };
    if (check.out.length && !(ctx.params && ctx.params["view.force"] === "1")) {
      const list = check.out.map((o) => `${o.name} ${o.value}${o.unit ? ` ${o.unit}` : ""}（${o.min}~${o.max}）`).join("、");
      return { params: { "view.force": "1" }, message: say(ctx, "sign.outOfRange", { list }) };
    }
    // Fixed: what is read from now on, with every value written in.
    const changes = { "body.signedText": readText(ctx, p) };
    for (const [k, v] of Object.entries(body)) if (k.startsWith("v.")) changes[`body.${k}`] = v;
    for (const it of p.items) if (!it.error && p.values[it.name] !== undefined) changes[`body.v.${it.name}`] = p.values[it.name];
    changes["body.text"] = body.text;
    changes["body.levels"] = body.levels ?? "";
    await ctx.host.resources.update(res.id, changes);
  }
  await ctx.host.resources.stamp(res.id, { label: st.next, signer });
  return { params: { "view.force": "", signer: "" }, message: say(ctx, "sign.signed", { level: st.next, signer }) };
}

async function revise(ctx) {
  const st = stateOf(ctx, ctx.resource);
  if (st.voided) return { message: ctx.t("revise.void") };
  if (st.stamps.length === 0) return { message: ctx.t("revise.notSigned") };
  const reason = str(ctx.params && ctx.params.reason).trim();
  if (!reason) return { message: ctx.t("revise.noReason") };
  await ctx.host.resources.unstamp(ctx.resource.id, { reason });
  return { params: { reason: "" }, message: ctx.t("revise.done") };
}

async function voidIt(ctx) {
  const st = stateOf(ctx, ctx.resource);
  if (unsaved(ctx)) return { message: ctx.t("sign.saveFirst") };
  if (st.voided) return { message: ctx.t("sign.void") };
  const signer = await signerOf(ctx);
  if (!signer) return { message: ctx.t("sign.noSigner") };
  if (st.stamps.length === 0) {
    const body = bodyNow(ctx);
    const p = await prepared(ctx, body.text, enteredOf(body));
    await ctx.host.resources.update(ctx.resource.id, { "body.signedText": readText(ctx, p) });
  }
  await ctx.host.resources.stamp(ctx.resource.id, { label: say(ctx, "stamp.void"), signer });
  return { message: ctx.t("void.done") };
}

export async function documentEvent(ctx, event) {
  if (event === "toggle") {
    if (stateOf(ctx, ctx.resource).stamps.length > 0) return { message: ctx.t("sign.locked") };
    const next = ctx.params && ctx.params["view.mode"] === "source" ? "fill" : "source";
    return { params: { "view.mode": next }, message: ctx.t(next === "source" ? "message.source" : "message.fill") };
  }
  if (event === "sign") return sign(ctx);
  if (event === "revise") return revise(ctx);
  if (event === "void") return voidIt(ctx);
  throw new Error(`unknown event ${event}`);
}

/** D481: one section by its heading; `[[=文书 | 项=体重]]` one item's value. */
export async function embedDocument(ctx, ask) {
  const res = ctx.resource;
  const body = res.body || {};
  if (ask && ask.inline) {
    const name = str(ask.args && (ask.args["项"] ?? ask.args.item)).trim();
    if (!name) return { text: say(ctx, "embed.noItem"), error: true };
    const p = await prepared(ctx, body.text, enteredOf(body));
    const it = p.items.find((x) => x.name === name && !x.error);
    if (!it) return { text: say(ctx, "embed.noSuchItem", { name }), error: true };
    return { text: shown(ctx, it, body[`v.${name}`] ?? p.values[name]) || say(ctx, "item.unfilled") };
  }
  const text = await readingOf(ctx, res, body);
  const section = ask && typeof ask.section === "string" && ask.section ? ask.section : null;
  if (!section) return { view: [{ type: "text", id: "doc", text, format: "markdown" }] };
  const part = sectionOf(text, section);
  if (part === null) return { view: [], sectionMissing: true };
  return { view: [{ type: "text", id: "doc", text: part, format: "markdown" }] };
}

/** One section of a Markdown text: from the heading named `section` to the next one as high or higher. */
export function sectionOf(text, section) {
  const want = String(section || "").trim().toLowerCase();
  const lines = String(text || "").split("\n");
  let fence = false;
  let from = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (from >= 0 && m[1].length <= level) return lines.slice(from, i).join("\n").trimEnd();
    if (from < 0 && m[2].trim().toLowerCase() === want) {
      from = i;
      level = m[1].length;
    }
  }
  return from >= 0 ? lines.slice(from).join("\n").trimEnd() : null;
}

/** A new paper (or one whose template was just chosen): the template's text and levels come over, once. */
export async function copyTemplate(ctx, event) {
  if (!event || event.kind !== DOCUMENT || event.change === "deleted" || event.change === "purged") return;
  let doc;
  try {
    doc = await ctx.host.resources.get(event.id);
  } catch {
    return;
  }
  const b = (doc && doc.body) || {};
  if (!doc || !b.template || str(b.text) || (doc.stamps && doc.stamps.length)) return;
  let tpl;
  try {
    tpl = await ctx.host.resources.get(b.template);
  } catch {
    return;
  }
  if (!tpl || tpl.kind !== TEMPLATE) return;
  await ctx.host.resources.update(doc.id, { "body.text": str(tpl.body && tpl.body.text), "body.levels": str(tpl.body && tpl.body.levels), "body.templateRev": tpl.rev ?? null });
}
