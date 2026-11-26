import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin from "./main.js";
import { checkView, registry } from "../../plugins/_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const EN = locale("en-US");
const t = (key: string) => ({ "en-US": EN[key] ?? key, "zh-CN": ZH[key] ?? key });
const I = "org.onedesk.inbox";
const k = (s: string) => `${I}:${s}`;
const NOW = Date.now();

type Res = { id: string; kind: string; name: string; parentId: string | null; body: Record<string, any>; createdAt: number; stamps?: any[] };

/** A workspace, what the kernel knows of letters, and pages whose roles answer `onedesk.letter/1`. */
function world(spec: Array<[string, string, string, string | null, Record<string, any>?]>, letters: Record<string, any> = {}, roles: Record<string, any> = {}) {
  const res = new Map<string, Res>();
  let clock = 0;
  for (const [id, kind, name, parent, body] of spec) res.set(id, { id, kind, name, parentId: parent, body: body ?? {}, createdAt: ++clock });
  const files = new Set<string>();
  const written: any[] = [];
  const stamps: any[] = [];
  const host = {
    resources: {
      async get(id: string) {
        return res.get(id) ?? null;
      },
      async list(o: { kind: string; parent?: string }) {
        return [...res.values()].filter((r) => r.kind === k(o.kind) && (o.parent === undefined || r.parentId === o.parent));
      },
      async update(id: string, changes: Record<string, any>) {
        const r = res.get(id)!;
        for (const [key, v] of Object.entries(changes)) r.body[key.slice(5)] = v;
        return { rev: 2 };
      },
      async tree(id: string) {
        return { nodes: [...res.values()].filter((r) => r.parentId === id).map((r) => ({ id: r.id, name: r.name, kind: r.kind, depth: 1 })), next: null };
      },
      async stamp(id: string, s: any) {
        stamps.push({ id, ...s });
        return { stamps: [s] };
      },
    },
    letters: {
      async info(id: string) {
        return letters[id] ?? null;
      },
      async write(root: string, o: any) {
        written.push({ root, ...o });
        files.add(o.path);
        return { path: o.path, letter: "L1" };
      },
    },
    interfaces: {
      async call(_i: string, action: string, input: any, o: { resource: string }) {
        const r = roles[o.resource];
        if (!r || !r[action]) throw new Error("noImplementation");
        return { data: r[action](input) };
      },
    },
    files: {
      async roots() {
        return [{ path: "/out", name: "out" }];
      },
      async stat(p: string) {
        if (!files.has(p)) throw new Error("notFound");
        return {};
      },
    },
  };
  const ctx = (id: string | null, extra: Record<string, any> = {}) => ({ t, locale: "zh-CN", host, params: {}, resource: id ? res.get(id) : null, ...extra });
  return { res, ctx, written, stamps, files };
}

const roles = {
  p1: { tasks: () => ({ tasks: [{ task: "answer", label: "作答" }] }), todo: () => ({ state: "done", summary: "8/10" }), reply: () => ({ data: { score: 8 }, summary: "8/10" }) },
  p2: { tasks: () => ({ tasks: [{ task: "sign", label: "审签" }, { task: "read", label: "阅" }] }), todo: () => ({ state: "todo" }), reply: () => ({}) },
};

describe("the manifest (D487 §35)", () => {
  it("four kinds; the register of letters received takes letters; three languages", () => {
    expect(manifest.contributes.kinds.map((x: any) => x.id)).toEqual(["inbox", "letter", "outbox", "sent"]);
    expect(manifest.contributes.kinds[0].letters).toBe(true);
    expect(manifest.uses).toEqual(["onedesk.letter/1"]);
    for (const f of ["en-US", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual(Object.keys(ZH).sort());
  });
});

describe("a letter to send", () => {
  it("asks what each page's role offers; sends the signed letter to the granted folder, then is fixed", async () => {
    const w = world([
      ["out", k("outbox"), "发文簿", null],
      ["s", k("sent"), "作业一", "out", { subject: "第一次作业", comment: "周五前", due: "2026-12-01", to: [{ who: "c1" }], pages: [{ page: "p1", task: "answer" }] }],
    ]);
    const { pages, actions } = registry(plugin);
    const v = await pages.sent.render(w.ctx("s"));
    checkView(v.view);
    const pagesField = v.view[0].fields.find((f: any) => f.name === "pages");
    // Not hard-coded: whoever implements the interface (its kinds), and the tasks the chosen pages offer.
    expect(pagesField.columns[0].kinds).toEqual(["@implements:onedesk.letter/1"]);
    const w2 = world(
      [["s", k("sent"), "作业一", null, { subject: "第一次作业", comment: "周五前", due: "2026-12-01", to: [{ who: "c1" }], pages: [{ page: "p1", task: "answer" }, { page: "p2" }] }]],
      {},
      roles,
    );
    const v2 = await pages.sent.render(w2.ctx("s"));
    expect(v2.view[0].fields.find((f: any) => f.name === "pages").columns[1].options.map((o: any) => o.value)).toEqual(["answer", "sign", "read"]);
    const r = await actions.send(w2.ctx("s"), {});
    expect(r.output.text).toContain("/out/第一次作业.odletter");
    expect(w2.written[0]).toMatchObject({ root: "s", pages: ["p1", "p2"], to: ["c1"], subject: "第一次作业", due: "2026-12-01", rootKind: "letter", path: "/out/第一次作业.odletter" });
    // A page without a task chosen gets the first it offers.
    expect(w2.written[0].tasks).toEqual([{ page: "p1", task: "answer", label: "作答" }, { page: "p2", task: "sign", label: "审签" }]);
    expect(w2.res.get("s")!.body.sentAt).toBeGreaterThan(0);
    expect(w2.stamps).toEqual([{ id: "s", label: ZH["stamp.sent"], signer: "" }]);
    expect((await actions.send(w2.ctx("s"), {})).failed.message).toBe(ZH["sent.already"]);
  });

  it("refuses without a subject, without pages, or with a page nothing can be asked of", async () => {
    const { actions } = registry(plugin);
    const run = async (body: any) => (await actions.send(world([["s", k("sent"), "x", null, body]], {}, roles).ctx("s"), {})).failed?.message;
    expect(await run({ subject: "", pages: [{ page: "p1" }] })).toBe(ZH["sent.noSubject"]);
    expect(await run({ subject: "a", pages: [] })).toBe(ZH["sent.noPages"]);
    expect(await run({ subject: "a", pages: [{ page: "nobody" }] })).toBe(ZH["sent.cannotAsk"]);
  });

  it("once sent: who answered, when, what came back", async () => {
    const info = {
      s: {
        dir: "out",
        to: [{ fingerprint: "AAAA", name: "李明" }, { fingerprint: "BBBB", name: "王芳" }],
        replies: [{ from: { name: "李明", fingerprint: "AAAA", known: "checked" }, at: NOW, pages: [{ page: "p1", summary: "8/10" }], response: { agree: "agree", comment: "好" } }],
      },
    };
    const w = world([["s", k("sent"), "作业一", null, { subject: "第一次作业", sentAt: NOW, file: "/out/a.odletter" }]], info);
    const v = await registry(plugin).pages.sent.render(w.ctx("s"));
    checkView(v.view);
    expect(v.readOnly).toBe(true);
    const table = v.view.find((n: any) => n.id === "answers");
    expect(table.rows[0][0]).toBe("李明");
    expect(table.rows[0][2]).toBe("8/10；同意；“好”");
    expect(table.rows[1]).toEqual(["王芳", ZH["sent.waiting"], ""]);
  });
});

describe("a letter received", () => {
  const info = {
    l: { dir: "in", subject: "第一次作业", comment: "周五前", due: "2000-01-01", at: NOW, from: { name: "张老师", fingerprint: "F", known: "checked" }, tasks: [{ page: "p1", task: "answer", label: "作答" }, { page: "p2", task: "sign", label: "审签" }] },
  };
  it("shows who sent it, what is asked and whether it is done; overdue when not answered in time", async () => {
    const w = world([["l", k("letter"), "第一次作业", "in", {}], ["p1", "x:test", "测验", "l"], ["p2", "y:doc", "文书", "l"]], info, roles);
    const v = await registry(plugin).pages.letter.render(w.ctx("l"));
    checkView(v.view);
    expect(v.view[0].text).toContain("张老师（签名有效，已核对）");
    expect(v.view[0].text).toContain(ZH["letter.overdue"].replace("{due}", "2000-01-01"));
    const tasks = v.view.find((n: any) => n.id === "tasks");
    expect(tasks.rows).toEqual([["测验", "作答", "已做：8/10"], ["文书", "审签", ZH["todo.todo"]]]);
    expect(tasks.rowTargets).toEqual(["resource:p1", "resource:p2"]);
  });
  it("the reply carries what each page's role gives back and the response; what is not done stays out", async () => {
    const w = world([["l", k("letter"), "第一次作业", "in", { "response.agree": "agree", "response.comment": "按时", "response.read": true }]], info, roles);
    const r = await registry(plugin).actions.reply(w.ctx("l"), {});
    expect(w.written[0]).toMatchObject({ root: "l", path: "/out/第一次作业-回件.odletter", reply: { pages: [{ page: "p1", task: "answer", data: { score: 8 }, summary: "8/10" }], response: { read: true, agree: "agree", comment: "按时" } } });
    expect(r.output.text).toContain(ZH["letter.notDone"].replace("{what}", "审签"));
    expect(w.res.get("l")!.body.repliedAt).toBeGreaterThan(0);
  });
});

describe("the registers", () => {
  it("received: date, from, subject, due, state", async () => {
    const info = { a: { dir: "in", at: NOW, from: { name: "张老师", known: "unchecked" }, subject: "作业", due: "" }, b: { dir: "in", at: NOW, from: { name: "科室", known: "checked" }, subject: "审签", due: "2000-01-01" } };
    const w = world([["in", k("inbox"), "收文簿", null], ["a", k("letter"), "作业", "in", { repliedAt: NOW }], ["b", k("letter"), "审签", "in"]], info);
    const v = await registry(plugin).pages.inbox.render(w.ctx("in"));
    checkView(v.view);
    expect(v.view[0].text).toBe(ZH["inbox.count"].replace("{n}", "2").replace("{todo}", "1"));
    const rows = v.view[1].rows;
    expect(rows.map((r: string[]) => r[4])).toEqual([ZH["state.overdue"], ZH["state.replied"]]);
  });
  it("sent: subject, recipients, answered", async () => {
    const info = { s: { dir: "out", to: [{ fingerprint: "A" }, { fingerprint: "B" }], replies: [{}] } };
    const w = world([["out", k("outbox"), "发文簿", null], ["s", k("sent"), "作业", "out", { subject: "作业", sentAt: NOW, due: "" }], ["d", k("sent"), "草稿", "out", { subject: "" }]], info);
    const v = await registry(plugin).pages.outbox.render(w.ctx("out"));
    checkView(v.view);
    const rows = v.view[0].rows;
    expect(rows.find((r: string[]) => r[1] === "作业").slice(2, 4)).toEqual(["2", "1"]);
    expect(rows.find((r: string[]) => r[4] === ZH["state.draft"])).toBeTruthy();
  });
});
