// Exercise plugin (docs/redesign/book.md §19, D487): questions; practice pages answered right in the book; tests
// handed in on an attempt page; attempts, grades and the mistake book in the tree “learning records”; a textbook
// contents. Its kinds play roles in books through the interface `onedesk.book/1`.
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { partsOf, TYPES } from "./question.js";
import { markEntry, openEntry, sealQuestion } from "./sealed.js";
import { itemsOf, NONE, questionsOf, say } from "./common.js";
import { questionNodes } from "./answering.js";
import { actPractice, againPractice, checkPractice, embedPractice } from "./practice.js";
import { actTest, embedTest, renderTest, testEvent } from "./test.js";
import { renderAttempt, renderGrades, renderMistakes, retryMistakes, submitAttempt, teacherMark } from "./records.js";
import { embedLessons, lessonsEntries, lessonsEvent, renderLessons } from "./lessons.js";
import { authorNodes, generate, quickText } from "./authoring.js";
import { ROLES } from "./roles.js";
import { embedAnswers, releaseAction, remarkAwaiting, renderAnswers } from "./answers.js";

/** Form fields of the page itself, not saved: the tab keeps them. */
const asParams = (view) => view.map((n) => (n.type === "form" ? { ...n, fields: n.fields.map((f) => ({ ...f, param: true })) } : n));

/* ------------------------------------------------------------------ question */

function questionForm(ctx) {
  const f = (name, kind, extra = {}) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...extra });
  return {
    type: "form",
    id: "question",
    layout: "stack",
    fields: [
      f("type", "enum", { options: TYPES.map((v) => ({ value: v, label: ctx.t(`type.${v}`) })) }),
      f("stem", "longtext", { placeholder: ctx.t("field.stem.placeholder") }),
      f("options", "longtext", { placeholder: ctx.t("field.options.placeholder"), hint: ctx.t("field.options.hint") }),
      f("answers", "longtext", { hint: ctx.t("field.answers.hint") }),
      f("rule", "enum", { options: ["number", "text", "symbol", "teacher"].map((v) => ({ value: v, label: ctx.t(`rule.${v}`) })) }),
      f("points", "number"),
      f("hint", "longtext"),
      f("explanation", "longtext"),
      f("difficulty", "number", { hint: ctx.t("field.difficulty.hint") }),
    ],
  };
}

/** The body as the person sees it now (unsaved typing over what was saved). */
function bodyNow(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  if (ctx.draft) for (const [k, v] of Object.entries(ctx.draft)) if (k.startsWith("body.")) b[k.slice(5)] = v;
  return b;
}

/** The question page: its fields; below, what a student sees — try it (marked as you type, nothing kept). */
async function renderQuestion(ctx) {
  const q = partsOf(bodyNow(ctx));
  const id = (ctx.resource && ctx.resource.id) || "new";
  const qs = new Map([[id, { res: ctx.resource || {}, q }]]);
  const given = Array.from({ length: q.blanks }, (_, i) => String((ctx.params && ctx.params[`try.${i}`]) || ""));
  const m = await markEntry(ctx, qs.get(id), given, true);
  qs.set(id, await openEntry(ctx, qs.get(id)));
  const { view } = questionNodes(ctx, [{ q: id }], qs, { name: (_, i) => `try.${i}`, marks: m.state === "empty" ? null : { [id]: m }, reveal: true });
  return { view: [questionForm(ctx), { type: "text", id: "previewTitle", text: `**${say(ctx, "question.preview")}**`, format: "markdown" }, ...asParams(view)] };
}

/** A question embedded on its own: answer it and check; nothing is kept. */
async function embedQuestion(ctx) {
  const q = partsOf(ctx.resource.body);
  const qs = new Map([[ctx.resource.id, { res: ctx.resource, q }]]);
  const { view } = questionNodes(ctx, [{ q: ctx.resource.id }], qs, { name: (_, i) => `a.${i}`, marks: null, reveal: false });
  return { view, actions: [{ id: "check", label: ctx.t("action.check"), icon: "check" }] };
}

async function actQuestion(ctx, ask) {
  const q = partsOf(ctx.resource.body);
  const qs = new Map([[ctx.resource.id, { res: ctx.resource, q }]]);
  const given = Array.from({ length: q.blanks }, (_, i) => String((ask.values && ask.values[`a.${i}`]) || ""));
  const m = await markEntry(ctx, qs.get(ctx.resource.id), given, true);
  qs.set(ctx.resource.id, await openEntry(ctx, qs.get(ctx.resource.id)));
  const { view } = questionNodes(ctx, [{ q: ctx.resource.id }], qs, { name: (_, i) => `a.${i}`, marks: { [ctx.resource.id]: m }, reveal: true });
  return { view, values: ask.values || {}, actions: [{ id: "check", label: ctx.t("action.check"), icon: "check" }] };
}

/* ------------------------------------------------------------------ practice page */

async function renderPracticePage(ctx) {
  const p = ctx.resource;
  if (!p || !p.id) return { view: [{ type: "text", id: "new", text: say(ctx, "practice.new"), tone: "muted" }] };
  const answer = await embedPractice(ctx);
  const items = await itemsOf(ctx, p);
  const qs = await questionsOf(ctx, items);
  return { view: [...asParams(answer.view), ...authorNodes(ctx, items, qs, {})] };
}

async function practiceEvent(ctx, event) {
  const p = ctx.resource;
  if (event === "check") {
    const values = {};
    for (const [k, v] of Object.entries(ctx.params || {})) if (k.startsWith("q.")) values[k] = v;
    const r = await checkPractice(ctx, p, values);
    return { message: say(ctx, "practice.checked", r) };
  }
  if (event === "again") {
    await againPractice(ctx, p);
    const cleared = {};
    for (const k of Object.keys(ctx.params || {})) if (k.startsWith("q.")) cleared[k] = "";
    return { params: cleared };
  }
  if (event === "generate") {
    const text = quickText(ctx);
    if (!text.trim()) return { message: ctx.t("quick.nothing") };
    const made = await generate(ctx, p.id, text);
    return { params: { quick: "" }, message: say(ctx, "quick.made", { n: made.filter((m) => m.q).length }) };
  }
  throw new Error(`unknown event ${event}`);
}

export default {
  activate(host) {
    host.kinds.handle("question", { embed: embedQuestion, embedAct: actQuestion, seal: sealQuestion });
    host.kinds.handle("practice", { embed: embedPractice, embedAct: actPractice });
    host.kinds.handle("test", { embed: embedTest, embedAct: actTest });
    host.kinds.handle("lessons", { embed: embedLessons });
    host.kinds.handle("answers", { embed: embedAnswers });

    host.pages.handle("question", { render: renderQuestion });
    host.pages.handle("practice", { render: renderPracticePage, onEvent: practiceEvent });
    host.pages.handle("test", { render: renderTest, onEvent: testEvent });
    host.pages.handle("attempt", {
      render: renderAttempt,
      async onEvent(ctx, event) {
        if (event === "submit") return submitAttempt(ctx);
        if (event === "markRight" || event === "markWrong") return teacherMark(ctx, String(ctx.row), event === "markRight");
        throw new Error(`unknown event ${event}`);
      },
    });
    host.pages.handle("grades", { render: renderGrades });
    host.pages.handle("mistakes", {
      render: renderMistakes,
      async onEvent(ctx, event) {
        if (event === "retry") return retryMistakes(ctx);
        throw new Error(`unknown event ${event}`);
      },
    });
    host.pages.handle("lessons", { render: renderLessons, onEvent: lessonsEvent });
    host.pages.handle("answers", { render: renderAnswers });
    host.actions.handle("release", releaseAction);
    // D487 §21: a new printing brought answers: attempts waiting for them are marked.
    host.events.on("resource.changed", remarkAwaiting);

    // `onedesk.book/1`.
    host.actions.handle("roles", async () => ({ output: NONE, data: ROLES }));
    host.actions.handle("outline", async () => ({ output: NONE, data: { headings: [], figures: [], cites: [], terms: [] } }));
    host.actions.handle("entries", async (ctx, input) => ({ output: NONE, data: await lessonsEntries(ctx, input) }));
  },
};
