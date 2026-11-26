import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin from "./main.js";
// @ts-ignore
import { blankRight, letters, numberOf, truth } from "./judge.js";
// @ts-ignore
import { mark, partsOf, quick } from "./question.js";
// @ts-ignore
import { mistakesOf } from "./records.js";
import { checkView, registry } from "../../plugins/_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const t = (key: string) => ({ "en-US": key, "zh-CN": ZH[key] ?? key });
const X = "org.onedesk.exercise";
const k = (s: string) => `${X}:${s}`;

type Res = { id: string; kind: string; name: string; parentId: string | null; body: Record<string, any>; tags: string[] };

/** A workspace with a book (another plugin's kind, playing the role `book`) and what the host gives the plugin. */
function world(spec: Array<[string, string, string, string | null, Record<string, any>?, string[]?]>) {
  const res = new Map<string, Res>();
  const order: string[] = [];
  for (const [id, kind, name, parent, body, tags] of spec) {
    res.set(id, { id, kind, name, parentId: parent, body: body ?? {}, tags: tags ?? [] });
    order.push(id);
  }
  let next = 0;
  const opened: string[] = [];
  const storage = new Map<string, unknown>();
  const own = (r: Res) => r.kind.startsWith(`${X}:`);
  const host = {
    resources: {
      async get(id: string) {
        const r = res.get(id);
        if (r && !own(r)) throw Object.assign(new Error("denied"), { code: "denied" });
        return r ? structuredClone(r) : null;
      },
      async list(o: { kind: string; parent?: string }) {
        return order.map((id) => res.get(id)!).filter((r) => r.kind === k(o.kind) && (o.parent === undefined || r.parentId === o.parent)).map((r) => structuredClone(r));
      },
      async create(o: { kind: string; name?: string; body?: any; parent?: string }) {
        const id = `n${++next}`;
        res.set(id, { id, kind: k(o.kind), name: o.name ?? o.kind, parentId: o.parent ?? null, body: structuredClone(o.body ?? {}), tags: [] });
        order.push(id);
        return structuredClone(res.get(id));
      },
      async update(id: string, changes: Record<string, any>) {
        const r = res.get(id)!;
        for (const [key, v] of Object.entries(changes)) r.body[key.slice(5)] = structuredClone(v);
        return { rev: 2 };
      },
      async search(o: { ids: string[] }) {
        return o.ids.map((id) => res.get(id)).filter(Boolean).map((r) => ({ id: r!.id, name: r!.name, kind: r!.kind, parent: r!.parentId, tags: r!.tags }));
      },
    },
    interfaces: {
      async list() {
        return [{ plugin: "x.book" }, { plugin: X }];
      },
      async call(_i: string, action: string, input: any, o: any) {
        if (o.plugin === "x.book" && action === "roles") return { data: { kinds: [{ kind: "book", role: "book" }] } };
        if (o.plugin === "x.book" && action === "entries") {
          expect(input.roles[X]).toBeTruthy();
          return { data: { items: [{ key: "p1", title: "第一章 练一练", level: 1, resource: "p1" }, { key: "t1", title: "第二章 测验", level: 1, resource: "t1" }] } };
        }
        throw new Error("no");
      },
    },
    storage: { get: async (key: string) => storage.get(key) ?? null, set: async (key: string, v: unknown) => void storage.set(key, v) },
    ui: { open: async (target: string) => void opened.push(target) },
  };
  const ctx = (id: string | null, extra: Record<string, any> = {}) => ({ t, locale: "zh-CN", host, params: {}, resource: id ? structuredClone(res.get(id)) : null, ...extra });
  return { res, ctx, opened, order };
}

const Q = (stem: string, answers: string, extra: Record<string, any> = {}) => ({ type: "fill", stem, answers, rule: "number", points: 1, ...extra });

function school() {
  return world([
    ["bk", "x.book:book", "数学", null],
    ["p1", k("practice"), "练一练", "bk"],
    ["q1", k("question"), "3+5", "p1", Q("3 + 5 = {{?}}", "8"), ["加法"]],
    ["q2", k("question"), "7×?", "p1", Q("7 × {{?}} = 56", "8"), ["乘法"]],
    ["t1", k("test"), "单元测验", "bk", { timing: "submit", tries: 2, keep: "best", limit: 30, editable: true, partial: false, items: [{ h: "一、口算" }, { q: "q1" }, { q: "q3" }] }],
    ["q3", k("question"), "说说", "t1", { type: "free", stem: "为什么？", answers: "因为", points: 2 }],
    ["ls", k("lessons"), "目录", "bk"],
  ]);
}

describe("judging (D487 §19.3)", () => {
  it("by value, writing, symbol; choices; true or false", () => {
    expect([numberOf("1/2"), numberOf("½"), numberOf(".5"), numberOf("４ 个"), numberOf("12÷3"), numberOf("abc")]).toEqual([0.5, 0.5, 0.5, 4, null, null]);
    expect(blankRight("number", "0.5", "1/2")).toBe(true);
    expect(blankRight("number", "12÷3 | 12/3", "12/3")).toBe(true);
    expect(blankRight("text", "2/4", "1/2")).toBe(false);
    expect(blankRight("text", "ＡＢ", "AB ")).toBe(true);
    expect(blankRight("symbol", "<", "＜")).toBe(true);
    expect(letters("c, a")).toBe("AC");
    expect([truth("√"), truth("错"), truth("maybe")]).toEqual([true, false, null]);
  });

  it("marks a question: right, wrong, partly, waiting, empty", () => {
    const two = partsOf(Q("{{?}} + {{?}} = 5", "2\n3", { points: 2 }));
    expect(two.blanks).toBe(2);
    expect(mark(two, ["2", "3"])).toEqual({ state: "right", score: 2, max: 2 });
    expect(mark(two, ["2", "9"])).toEqual({ state: "partial", score: 1, max: 2 });
    expect(mark(two, ["", ""]).state).toBe("empty");
    expect(mark(partsOf({ type: "free", stem: "?" }), ["x"]).state).toBe("pending");
    const multi = partsOf({ type: "multi", options: "A. 1\nB. 2\nC. 3", answers: "AC" });
    expect([mark(multi, ["A"], true).state, mark(multi, ["A"], false).state, mark(multi, ["AB"], true).state]).toEqual(["partial", "wrong", "wrong"]);
  });

  it("quick writing: answers in brackets, headings with #", () => {
    expect(quick("# 一、口算\n3 + 5 = (8)\n38 (<) 83\nno answer")).toEqual([
      { heading: "一、口算" },
      { name: "3 + 5 = (8)", body: { type: "fill", stem: "3 + 5 = {{?}}", answers: "8", rule: "number", points: 1 } },
      { name: "38 (<) 83", body: { type: "fill", stem: "38 {{?}} 83", answers: "<", rule: "symbol", points: 1 } },
    ]);
  });
});

describe("practice in a book (D487 §19.6)", () => {
  it("answered in place: check marks at once into one attempt; again starts a new one", async () => {
    const w = school();
    const { kinds } = registry(plugin);
    const e = await kinds.practice.embed(w.ctx("p1"));
    expect(checkView(e.view)).toEqual([]);
    expect(e.actions.map((a: any) => a.id)).toEqual(["check", "again"]);
    expect(e.view.filter((n: any) => n.type === "form").every((f: any) => f.fields.every((x: any) => x.bind === undefined))).toBe(true);
    const r = await kinds.practice.embedAct(w.ctx("p1"), { action: "check", values: { "q.q1.0": "8", "q.q2.0": "9" } });
    expect(r.message).toBe("对了 1 题，共 2 题");
    expect(r.values).toEqual({ "q.q1.0": "8", "q.q2.0": "9" });
    const marks = r.view.filter((n: any) => String(n.id).startsWith("m-"));
    expect(marks.map((n: any) => n.text.split("\n")[0])).toEqual(["✓ 对　1 / 1 分", "✗ 错　0 / 1 分"]);
    expect(marks[1].text).toContain("正确答案：（1）8");
    const attempts = [...w.res.values()].filter((x) => x.kind === k("attempt"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.body).toMatchObject({ source: "p1", sourceKind: "practice", book: "bk", status: "doing", score: 1, total: 2 });
    // Filed under the book's record folder; a grades sheet and a mistake book were made.
    expect(w.res.get(attempts[0]!.parentId!)!).toMatchObject({ kind: k("subject"), name: "数学", body: { book: "bk" } });
    expect([...w.res.values()].filter((x) => x.kind === k("grades") || x.kind === k("mistakes"))).toHaveLength(2);
    // Checking again uses the same attempt.
    await kinds.practice.embedAct(w.ctx("p1"), { action: "check", values: { "q.q1.0": "8", "q.q2.0": "8" } });
    expect([...w.res.values()].filter((x) => x.kind === k("attempt"))).toHaveLength(1);
    // Again: the next check is a new attempt.
    const again = await kinds.practice.embedAct(w.ctx("p1"), { action: "again", values: {} });
    expect(again.values).toEqual({});
    await kinds.practice.embedAct(w.ctx("p1"), { action: "check", values: { "q.q1.0": "1" } });
    expect([...w.res.values()].filter((x) => x.kind === k("attempt")).map((a) => a.body.number)).toEqual([1, 2]);
  });
});

describe("tests and attempts (D487 §19.5, §19.7)", () => {
  it("a card in a book; start makes an attempt and opens it; attempts are counted", async () => {
    const w = school();
    const { kinds } = registry(plugin);
    const card = await kinds.test.embed(w.ctx("t1"));
    expect(card.view[0].text).toContain("2 题 · 满分 3");
    expect(card.view[0].text).toContain("还没做过");
    expect(card.actions.map((a: any) => a.id)).toEqual(["start"]);
    await kinds.test.embedAct(w.ctx("t1"), { action: "start", values: {} });
    const a = [...w.res.values()].find((x) => x.kind === k("attempt"))!;
    expect(w.opened).toEqual([`resource:${a.id}`]);
    expect(a.body).toMatchObject({ sourceKind: "test", number: 1, limit: 30, status: "doing", items: [{ h: "一、口算" }, { q: "q1" }, { q: "q3" }] });
    // An open attempt: “continue”, not a second one.
    const again = await kinds.test.embed(w.ctx("t1"));
    expect(again.actions.map((x: any) => x.id)).toEqual(["continue"]);
  });

  it("the attempt page: answer, hand in (unsaved typing included), marked; the teacher marks open answers", async () => {
    const w = school();
    const { kinds, pages } = registry(plugin);
    await kinds.test.embedAct(w.ctx("t1"), { action: "start", values: {} });
    const a = [...w.res.values()].find((x) => x.kind === k("attempt"))!;
    const doing = await pages.attempt.render(w.ctx(a.id));
    expect(checkView(doing.view)).toEqual([]);
    expect(doing.view[0].text).toContain("还剩 30 分钟");
    expect(doing.view.find((n: any) => n.id === "f-q1").fields[0].bind).toBe("body.a.q1.0");
    const r = await pages.attempt.onEvent(w.ctx(a.id, { draft: { "body.a.q1.0": "8", "body.a.q3.0": "因为……" } }), "submit");
    expect(r.message).toBe("1 / 3 分；1 题待批");
    expect(a.body).toMatchObject({ status: "submitted", score: 1, total: 3 });
    expect(a.body.snapshot.q1.stem).toBe("3 + 5 = {{?}}");
    const done = await pages.attempt.render(w.ctx(a.id));
    expect(done.readOnly).toBe(true);
    const pending = done.view.find((n: any) => n.id === "pending");
    expect(pending.rowKeys).toEqual(["q3"]);
    await pages.attempt.onEvent(w.ctx(a.id, { row: "q3" }), "markRight");
    expect(a.body.score).toBe(3);
    expect(a.body.results.q3).toMatchObject({ state: "right", by: "teacher" });
    // Two attempts allowed: one more, then no more.
    await kinds.test.embedAct(w.ctx("t1"), { action: "start", values: {} });
    const second = [...w.res.values()].filter((x) => x.kind === k("attempt"))[1]!;
    await pages.attempt.onEvent(w.ctx(second.id), "submit");
    const card = await kinds.test.embed(w.ctx("t1"));
    expect(card.actions.map((x: any) => x.id)).toEqual(["last"]);
    expect(card.view[0].text).toContain("2 次机会都用完了");
    expect(card.view[0].text).toContain("最高 3 分");
  });

  it("“after each question” marks as you answer; “cannot change” locks answered questions", async () => {
    const w = school();
    w.res.get("t1")!.body = { ...w.res.get("t1")!.body, timing: "each", editable: false };
    const { kinds, pages } = registry(plugin);
    await kinds.test.embedAct(w.ctx("t1"), { action: "start", values: {} });
    const a = [...w.res.values()].find((x) => x.kind === k("attempt"))!;
    a.body["a.q1.0"] = "9";
    const out = await pages.attempt.render(w.ctx(a.id));
    expect(out.view.find((n: any) => n.id === "m-q1").text).toContain("✗");
    expect(out.view.find((n: any) => n.id === "f-q1").fields[0].readOnly).toBe(true);
    expect(out.view.find((n: any) => n.id === "f-q3").fields[0].readOnly).toBeUndefined();
  });

  it("the author's page: settings, the list, quick writing adds questions and headings; a question from elsewhere joins", async () => {
    const w = school();
    const { pages, kinds } = registry(plugin);
    const page = await pages.test.render(w.ctx("t1"));
    expect(checkView(page.view)).toEqual([]);
    expect(page.view[0].fields.map((f: any) => f.bind)).toEqual(["body.timing", "body.tries", "body.keep", "body.limit", "body.editable", "body.partial"]);
    expect(page.view.find((n: any) => n.id === "items").rows.map((r: any) => r[1])).toEqual(["【一、口算】", "3 + 5 = （1）", "为什么？"]);
    const r = await pages.test.onEvent(w.ctx("t1", { params: { quick: "# 二、填空\n2 + 2 = (4)" } }), "generate");
    expect(r.message).toBe("生成了 1 道题");
    expect(w.res.get("t1")!.body.items.map((x: any) => x.h ?? "q")).toEqual(["一、口算", "q", "q", "二、填空", "q"]);
    await pages.test.onEvent(w.ctx("t1", { row: "0" }), "down");
    expect(w.res.get("t1")!.body.items[1]).toEqual({ h: "一、口算" });
    // A question from elsewhere joins by reference.
    expect(page.view.find((n: any) => n.id === "refer").fields[0]).toMatchObject({ kind: "ref", kinds: ["question"], param: true });
    const added = await pages.test.onEvent(w.ctx("t1", { params: { pick: "q2" } }), "refer");
    expect(added.message).toBe("加了 1 道题");
    expect(w.res.get("t1")!.body.items.some((x: any) => x.q === "q2")).toBe(true);
    expect(w.res.get("q2")!.parentId).toBe("p1");
    void kinds;
  });
});

describe("grades, mistakes, textbook contents (D487 §19.8, §19.10)", () => {
  it("grades by test and knowledge point; mistakes until got right; once more", async () => {
    const w = school();
    const { kinds, pages } = registry(plugin);
    await kinds.practice.embedAct(w.ctx("p1"), { action: "check", values: { "q.q1.0": "8", "q.q2.0": "9" } });
    await kinds.practice.embedAct(w.ctx("p1"), { action: "again", values: {} });
    const grades = await pages.grades.render(w.ctx([...w.res.values()].find((x) => x.kind === k("grades"))!.id));
    expect(checkView(grades.view)).toEqual([]);
    expect(grades.view.find((n: any) => n.id === "byTest").rows[0].slice(0, 4)).toEqual(["练一练", "1", "1", "1"]);
    expect(grades.view.find((n: any) => n.id === "byTag").rows).toEqual([["乘法", "1", "0", "0%"], ["加法", "1", "1", "100%"]]);
    const mid = [...w.res.values()].find((x) => x.kind === k("mistakes"))!.id;
    expect((await mistakesOf(w.ctx(mid))).map(([q]: any) => q)).toEqual(["q2"]);
    await pages.mistakes.onEvent(w.ctx(mid), "retry");
    const retry = [...w.res.values()].filter((x) => x.kind === k("attempt")).pop()!;
    expect(retry.body).toMatchObject({ sourceKind: "retry", items: [{ q: "q2" }] });
    expect(w.opened.pop()).toBe(`resource:${retry.id}`);
    await pages.attempt.onEvent(w.ctx(retry.id, { draft: { "body.a.q2.0": "8" } }), "submit");
    expect(await mistakesOf(w.ctx(mid))).toEqual([]);
  });

  it("the textbook contents reads the book numbered by its plugin, with progress after each lesson", async () => {
    const w = school();
    const { kinds, pages } = registry(plugin);
    await kinds.practice.embedAct(w.ctx("p1"), { action: "check", values: { "q.q1.0": "8", "q.q2.0": "8" } });
    const out = await pages.lessons.render(w.ctx("ls"));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].items.map((x: any) => x.title)).toEqual(["第一章 练一练　· ✓ 全对", "第二章 测验　· 未做"]);
    await pages.lessons.onEvent(w.ctx("ls", { row: "t1" }), "position");
    expect((await pages.lessons.render(w.ctx("ls"))).view[0].start).toBe("t1");
  });

  it("roles in a book; the manifest; every key in every language", async () => {
    const { actions } = registry(plugin);
    const roles = (await actions.roles({}, {})).data.kinds;
    expect(roles.find((r: any) => r.kind === "lessons")).toMatchObject({ role: "toc", part: "none", single: true });
    expect(roles.find((r: any) => r.kind === "practice")).toMatchObject({ role: "practice", part: "body", numbering: "level" });
    expect(manifest.implements["onedesk.book/1"].kinds).toEqual(["question", "test", "lessons", "answers"]);
    expect(roles.find((r: any) => r.kind === "answers")).toMatchObject({ part: "back", numbering: "letter", edition: "teacher" });
    expect(manifest.contributes.trees[0]).toMatchObject({ id: "records", source: "stored" });
    for (const f of ["en-US", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual(Object.keys(ZH).sort());
  });
});

// @ts-ignore
import { acceptedWritings, markEntry, sealQuestion, writing } from "./sealed.js";

describe("answers held back, released by the teacher (D487 §21)", () => {
  /** A student's copy: questions without answers; fingerprints for some (`sealed`), keychain texts (`opened`). */
  function copyWorld(sealed: Record<string, string[]>, opened: Record<string, Record<string, string>> = {}) {
    const w = world([
      ["bk", "x.book:book", "数学", null],
      ["p1", k("practice"), "练一练", "bk", {}],
      ["q1", k("question"), "3+5", "p1", { type: "fill", stem: "3 + 5 = {{?}}", rule: "number", points: 1 }],
      ["t1", k("test"), "单元测验", "bk", { timing: "release", items: [{ q: "q2" }] }],
      ["q2", k("question"), "7×8", "t1", { type: "fill", stem: "7 × 8 = {{?}}", rule: "number", points: 2 }],
      ["ans", k("answers"), "习题答案", "bk", { release: "t1" }],
    ]);
    for (const id of ["q1", "q2"]) (w.res.get(id) as any).copy = { edition: 1, printing: 1, variant: "student" };
    const host = (w.ctx(null) as any).host;
    const calls: any[] = [];
    host.sealed = {
      async check(id: string, field: string, text: string) {
        const list = sealed[`${id}.${field}`];
        return list ? list.includes(text) : null;
      },
      async open(id: string, field: string) {
        return opened[id]?.[field] ?? null;
      },
    };
    host.actions = {
      async call(action: string, input: any, o: any) {
        calls.push([action, input, o]);
        return { output: { type: "none" }, data: { edition: 1, printing: 2, paths: ["/out/数学-1.2-学生版.odpack"] } };
      },
    };
    host.resources.tree = async (id: string) => {
      const out: any[] = [];
      const walk = (p: string, depth: number) => {
        for (const x of w.order.filter((y) => w.res.get(y)!.parentId === p)) {
          const r = w.res.get(x)!;
          out.push({ id: r.id, kind: r.kind, name: r.name, depth, parent: p });
          walk(x, depth + 1);
        }
      };
      walk(id, 1);
      return { nodes: out, next: null };
    };
    return { ...w, calls };
  }

  it("the same writing on both sides: values, signs, letters, true or false", () => {
    const q = partsOf({ type: "fill", stem: "{{?}} {{?}}", answers: "1/2 | 0.25\n>", rule: "number" });
    expect(writing(q, 0, "0.5")).toBe(writing(q, 0, "½"));
    expect(acceptedWritings(q)).toEqual(["0|n:0.5", "0|n:0.25", "1|t:>"]);
    const s = partsOf({ type: "fill", stem: "{{?}}", answers: ">", rule: "symbol" });
    expect(writing(s, 0, "＞")).toBe(acceptedWritings(s)[0]);
    expect(acceptedWritings(partsOf({ type: "multi", options: "a\nb\nc", answers: "c, a" }))).toEqual(["0|l:AC"]);
    expect(writing(partsOf({ type: "judge", answers: "对" }), 0, "√")).toBe("0|j:T");
    expect(acceptedWritings(partsOf({ type: "free", answers: "x" }))).toEqual([]);
  });

  it("seal: on the spot in a practice or a test answered after handing in; nothing for one the teacher releases", async () => {
    const w = world([
      ["p1", k("practice"), "练", null],
      ["q1", k("question"), "a", "p1", { type: "fill", stem: "{{?}}", answers: "8", rule: "number" }],
      ["t1", k("test"), "测", null, { timing: "release" }],
      ["q2", k("question"), "b", "t1", { type: "fill", stem: "{{?}}", answers: "8", rule: "number" }],
      ["t2", k("test"), "测2", null, { timing: "submit" }],
      ["q3", k("question"), "c", "t2", { type: "fill", stem: "{{?}}", answers: "8", rule: "number" }],
    ]);
    expect(await sealQuestion(w.ctx("q1"))).toEqual({ checks: { answers: ["0|n:8"], explanation: [] } });
    expect(await sealQuestion(w.ctx("q2"))).toEqual({ checks: {} });
    expect((await sealQuestion(w.ctx("q3"))).checks.answers).toEqual(["0|n:8"]);
    // A test's answers wait for the teacher unless it says otherwise.
    expect(manifest.contributes.kinds.find((x: any) => x.id === "test").defaults.timing).toBe("release");
    const q = manifest.contributes.kinds.find((x: any) => x.id === "question");
    expect([q.fields.answers.withheld, q.fields.explanation.withheld]).toEqual([true, true]);
  });

  it("held back: marked by fingerprint, or waiting; a practice opens its answers to show them", async () => {
    const w = copyWorld({ "q1.answers": ["0|n:8"] }, { q1: { answers: "8", explanation: "三加五" } });
    const e = { res: w.res.get("q1"), q: partsOf(w.res.get("q1")!.body) };
    expect((await markEntry(w.ctx(null), e, ["8"], false)).state).toBe("right");
    expect((await markEntry(w.ctx(null), e, ["9"], false)).state).toBe("wrong");
    const e2 = { res: w.res.get("q2"), q: partsOf(w.res.get("q2")!.body) };
    expect(await markEntry(w.ctx(null), e2, ["56"], false)).toEqual({ state: "awaiting", score: 0, max: 2 });
    // In the book: checked, then the answer shown (opened, not stored).
    const { kinds } = registry(plugin);
    const r = await kinds.practice.embedAct(w.ctx("p1"), { action: "check", values: { "q.q1.0": "9" } });
    expect(JSON.stringify(r.view)).toContain("8");
    expect(JSON.stringify(r.view)).toContain("三加五");
    const attempt = [...w.res.values()].find((x) => x.kind === k("attempt"))!;
    expect(attempt.body.snapshot.q1).toMatchObject({ answers: "", explanation: "", held: true });
  });

  it("a test the teacher releases: handed in, waiting; the new printing marks it; the appendix asks the colophon", async () => {
    const w = copyWorld({});
    const { pages, actions } = registry(plugin);
    const st = await pages.test.onEvent(w.ctx("t1"), "start");
    expect(st).toBeUndefined();
    const a = [...w.res.values()].find((x) => x.kind === k("attempt"))!;
    a.body["a.q2.0"] = "56";
    const out = await pages.attempt.onEvent(w.ctx(a.id), "submit");
    expect(out.message).toBeTruthy();
    expect(a.body.results.q2.state).toBe("awaiting");
    const view = JSON.stringify((await pages.attempt.render(w.ctx(a.id))).view);
    expect(view).toContain("等老师公布答案");
    // The new printing: the question now has its answer.
    w.res.get("q2")!.body.answers = "56";
    delete (w.res.get("q2") as any).copy;
    // @ts-ignore
    const { remarkAwaiting } = await import("./answers.js");
    await remarkAwaiting(w.ctx(null), { change: "updated", kind: k("question"), id: "q2" });
    expect(a.body.results.q2).toMatchObject({ state: "right", score: 2 });
    expect(a.body.score).toBe(2);
    // The teacher's appendix: answers in book order, the ticked test released through the colophon.
    const t = copyWorld({});
    t.res.get("q1")!.body.answers = "8";
    t.res.get("q2")!.body.answers = "56";
    t.res.set("cp", { id: "cp", kind: "org.onedesk.book:colophon", name: "版权页", parentId: "bk", body: {}, tags: [] });
    t.order.splice(1, 0, "cp");
    const page = await pages.answers.render(t.ctx("ans"));
    expect(checkView(page.view)).toEqual([]);
    expect(JSON.stringify(page.view)).toContain("1\\\\. （1）8");
    expect(JSON.stringify(page.view)).toContain("· 已公布");
    const r = await actions.release(t.ctx("ans"), {});
    expect(r.failed).toBeUndefined();
    expect(t.calls[0][0]).toBe("org.onedesk.book:print");
    expect(t.calls[0][1].reveal).toEqual({ q2: ["answers", "explanation"] });
    expect(t.calls[0][2]).toEqual({ resource: "cp" });
  });
});

describe("what the book's conventions say of exercises (D487 §31.6)", () => {
  it("practice, tests and answers each say one thing; questions nothing", async () => {
    const { actions } = registry(plugin);
    const say = async (kind: string) => (await actions.conventions({ t, locale: "zh-CN", resource: { id: "x", kind: `org.onedesk.exercise:${kind}`, body: {} } }, {})).data.lines;
    expect(await say("practice")).toEqual([ZH["conv.practice"]]);
    expect(await say("test")).toEqual([ZH["conv.test"]]);
    expect(await say("answers")).toEqual([ZH["conv.answers"]]);
    expect(await say("question")).toEqual([]);
  });
});
