import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin from "./main.js";
// @ts-ignore
import { checkValues, itemsOf, parseItem, replaceItems, valuesOf, withValues } from "./items.js";
// @ts-ignore
import { readText, prepared, stateOf } from "./doc.js";
import { checkView, registry, RENDER_KEYS, onlyKeys } from "../../plugins/_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const EN = locale("en-US");
const t = (key: string) => ({ "en-US": EN[key] ?? key, "zh-CN": ZH[key] ?? key });
const D = "org.onedesk.document";
const k = (s: string) => `${D}:${s}`;

type Res = { id: string; kind: string; name: string; parentId: string | null; body: Record<string, any>; rev: number; createdAt: number; stamps?: any[] };

/** A workspace and the host a document's code gets (environment values in `env`). */
function world(spec: Array<[string, string, string, string | null, Record<string, any>?]>, env: Record<string, string> = {}) {
  const res = new Map<string, Res>();
  const order: string[] = [];
  let clock = 0;
  for (const [id, kind, name, parent, body] of spec) {
    res.set(id, { id, kind, name, parentId: parent, body: body ?? {}, rev: 1, createdAt: ++clock });
    order.push(id);
  }
  let next = 0;
  const opened: string[] = [];
  const moved: string[] = [];
  const kids = (p: string) => order.filter((x) => res.get(x)?.parentId === p);
  const host = {
    params: { async get(n: string) { return n in env ? { found: true, value: env[n], sourceName: "Ward" } : { found: false }; } },
    resources: {
      async get(id: string) {
        return res.has(id) ? structuredClone(res.get(id)) : null;
      },
      async list(o: { kind: string; parent?: string }) {
        return order.map((id) => res.get(id)!).filter((r) => r.kind === k(o.kind) && (o.parent === undefined || r.parentId === o.parent)).map((r) => structuredClone(r));
      },
      async tree(id: string) {
        return { nodes: kids(id).map((x) => ({ id: x, kind: res.get(x)!.kind, name: res.get(x)!.name, depth: 1 })), next: null };
      },
      async create(o: { kind: string; name?: string; body?: any; parent?: string }) {
        const id = `n${++next}`;
        res.set(id, { id, kind: k(o.kind), name: o.name ?? o.kind, parentId: o.parent ?? null, body: structuredClone(o.body ?? {}), rev: 1, createdAt: ++clock });
        order.push(id);
        return structuredClone(res.get(id));
      },
      async update(id: string, changes: Record<string, any>) {
        const r = res.get(id)!;
        if (r.stamps && r.stamps.length) throw Object.assign(new Error("denied"), { code: "denied", params: { reason: "stamped" } });
        for (const [key, v] of Object.entries(changes)) r.body[key.slice(5)] = structuredClone(v);
        r.rev++;
        return { rev: r.rev };
      },
      async stamp(id: string, o: { label: string; signer: string }) {
        const r = res.get(id)!;
        r.stamps = [...(r.stamps ?? []), { label: o.label, signer: o.signer, at: 1 }];
        return { stamps: r.stamps };
      },
      async unstamp(id: string, o: { reason: string }) {
        if (!o.reason) throw Object.assign(new Error("invalid"), { code: "invalid", params: { reason: "noReason" } });
        res.get(id)!.stamps = [];
        return { stamps: [] };
      },
      async move(id: string) {
        moved.push(id);
      },
    },
    ui: { open: async (target: string) => void opened.push(target) },
  };
  const ctx = (id: string | null, extra: Record<string, any> = {}) => ({ t, locale: "zh-CN", host, params: {}, resource: id ? structuredClone(res.get(id)) : null, ...extra });
  return { res, ctx, opened, moved, order };
}

const ADMISSION = [
  "# 入院记录",
  "姓名 {{姓名}}",
  "体温 {{?体温 | 数字, ℃, 35~42, 必填}}　过敏史 {{?过敏史 | 单选: 无/有, 默认=无}}",
  "## 主诉",
  "{{?主诉 | 长文字, 必填}}",
  "体重 {{?体重 | 数字, kg, 默认={{体重}}}}　身高 {{?身高 | 数字, m}}　BMI [[=BMI | 体重=@体重, 身高=@身高]]",
].join("\n");

describe("fill-in items (D487 §23.3)", () => {
  it("are read: type, unit, range, required, default; English words too; mistakes named", () => {
    expect(parseItem("体温 | 数字, ℃, 35~42, 必填")).toMatchObject({ name: "体温", type: "number", unit: "℃", min: 35, max: 42, required: true, error: null });
    expect(parseItem("Allergy | choice: none/yes, default=none")).toMatchObject({ type: "choice", options: ["none", "yes"], def: "none" });
    expect(parseItem("W | number, kg, default={{weight}}")).toMatchObject({ unit: "kg", def: "{{weight}}" });
    expect(parseItem("Note | longtext")).toMatchObject({ type: "longtext" });
    expect(parseItem("bad name | text").error).toBe("name");
    expect(parseItem("x | 单选:").error).toBe("options");
    expect(parseItem("x | 数字, kg, cm").error).toBe("unknown");
    const items = itemsOf("{{?a}} {{?a | 数字}}");
    expect(items[1].error).toBe("duplicate");
    expect(itemsOf(ADMISSION).map((i: any) => i.name)).toEqual(["体温", "过敏史", "主诉", "体重", "身高"]);
  });

  it("values: entered, else the default; required and range checked; @names go into calls", () => {
    const items = itemsOf("{{?a | 数字, 1~5, 必填}} {{?b | 默认=x}} {{?c | 默认={{none}}}}");
    const v = valuesOf(items, { a: "9" });
    expect(v).toEqual({ a: "9", b: "x", c: "" });
    expect(checkValues(items, v)).toEqual({ missing: [], out: [{ name: "a", value: "9", min: 1, max: 5, unit: "" }] });
    expect(checkValues(items, valuesOf(items, {})).missing).toEqual(["a"]);
    expect(withValues("[[=BMI | 体重=@体重]] @体重", { 体重: "70" })).toBe("[[=BMI | 体重=70]] @体重");
    expect(replaceItems("x {{?a}} y", () => "A")).toBe("x A y");
  });
});

describe("templates and documents (D487 §23.3, §23.4)", () => {
  const ward = { 姓名: "张三", 体重: "70", 签名人: "王医生" };
  function hospital() {
    return world(
      [
        ["tpl", k("template"), "入院记录模板", null, { text: ADMISSION, levels: "书写 / 审签" }],
        ["doc", k("document"), "张三入院记录", null, { template: "tpl" }],
      ],
      ward,
    );
  }

  it("a template previews as a new document would look, in the tab's environment", async () => {
    const w = hospital();
    const { pages } = registry(plugin);
    const out = await pages.template.render(w.ctx("tpl"));
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(checkView(out.view)).toEqual([]);
    const flow = out.view.find((n: any) => n.type === "flow");
    expect(flow.text).toContain("姓名 张三");
    expect(flow.fields.map((f: any) => f.name)).toEqual(["try.体温", "try.过敏史", "try.主诉", "try.体重", "try.身高"]);
    expect(flow.fields.every((f: any) => f.param)).toBe(true);
    expect(flow.fields.find((f: any) => f.name === "try.体重").envValue).toBe("70");
  });

  it("a new document copies the template once; changing the template later changes nothing", async () => {
    const w = hospital();
    const { events, pages } = registry(plugin);
    // Before it is saved: choose the template, see the form.
    const fresh = await pages.document.render({ ...w.ctx(null), draft: { "body.template": "tpl" } });
    expect(checkView(fresh.view)).toEqual([]);
    expect(fresh.view.some((n: any) => n.type === "flow")).toBe(true);
    await events["resource.changed"](w.ctx(null), { change: "created", kind: k("document"), id: "doc" });
    expect(w.res.get("doc")!.body).toMatchObject({ text: ADMISSION, levels: "书写 / 审签", templateRev: 1 });
    w.res.get("tpl")!.body.text = "changed";
    await events["resource.changed"](w.ctx(null), { change: "updated", kind: k("document"), id: "doc" });
    expect(w.res.get("doc")!.body.text).toBe(ADMISSION);
  });

  it("filled in place: controls at the items, the environment's values in, BMI from the values; out of range marked", async () => {
    const w = hospital();
    w.res.get("doc")!.body = { template: "tpl", text: ADMISSION, levels: "书写 / 审签", "v.身高": "1.75", "v.体温": "45" };
    const { pages } = registry(plugin);
    const out = await pages.document.render(w.ctx("doc"));
    expect(checkView(out.view)).toEqual([]);
    const flow = out.view.find((n: any) => n.type === "flow");
    expect(flow.text).toContain("{{field:体温}} ℃ （必填） ⚠ 超出 35~42");
    expect(flow.text).toContain("[[=BMI | 体重=70, 身高=1.75]]");
    expect(flow.fields.find((f: any) => f.name === "体温")).toMatchObject({ kind: "number", bind: "body.v.体温" });
    expect(flow.text).toContain("{{field:主诉}} （必填）");
    expect(flow.fields.find((f: any) => f.name === "过敏史")).toMatchObject({ kind: "enum", envValue: "无" });
    expect(out.view.find((n: any) => n.id === "status").text).toBe("草稿");
    // Editing the text itself.
    const src = await pages.document.render(w.ctx("doc", { params: { "view.mode": "source" } }));
    expect(src.view.find((n: any) => n.id === "source").fields[0].bind).toBe("body.text");
  });

  it("signing: required first, out of range confirmed; the text fixed; level by level; revised with a reason; voided", async () => {
    const w = hospital();
    w.res.get("doc")!.body = { template: "tpl", text: ADMISSION, levels: "书写 / 审签", "v.体温": "45" };
    const { pages } = registry(plugin);
    const ev = (extra: Record<string, any> = {}, name = "sign") => pages.document.onEvent(w.ctx("doc", extra), name);
    expect(JSON.stringify(await ev({ draft: { "body.v.主诉": "x" } }))).toContain("先保存");
    expect(JSON.stringify(await ev())).toContain("主诉");
    w.res.get("doc")!.body["v.主诉"] = "胸痛 2 小时";
    const warn = await ev();
    expect(warn.params).toEqual({ "view.force": "1" });
    expect(JSON.stringify(warn.message)).toContain("体温 45 ℃（35~42）");
    const done = await ev({ params: { "view.force": "1" } });
    expect(JSON.stringify(done.message)).toContain("王医生");
    const doc = w.res.get("doc")!;
    expect(doc.stamps).toEqual([{ label: "书写", signer: "王医生", at: 1 }]);
    expect(doc.body.signedText).toContain("姓名 张三");
    expect(doc.body.signedText).toContain("**45 ℃** ⚠ 超出 35~42");
    expect(doc.body.signedText).toContain("过敏史 无");
    expect(doc.body.signedText).toContain("[[=BMI | 体重=70, 身高=]]");
    expect(doc.body["v.体重"]).toBe("70");
    // Read only now; the next level.
    const ro = await pages.document.render(w.ctx("doc"));
    expect(ro.readOnly).toBe(true);
    expect(ro.view.find((n: any) => n.id === "status").text).toBe("书写：王医生　待审签");
    await ev({ params: { signer: "李主任" } });
    expect(stateOf({ t, locale: "zh-CN" }, w.res.get("doc")).done).toBe(true);
    expect(JSON.stringify(await ev())).toContain("已经全部签完");
    // Revise: a reason first.
    expect(JSON.stringify(await ev({}, "revise"))).toContain("先写修订理由");
    await ev({ params: { reason: "体温记错" } }, "revise");
    expect(w.res.get("doc")!.stamps).toEqual([]);
    expect((await pages.document.render(w.ctx("doc"))).view.some((n: any) => n.type === "flow")).toBe(true);
    // Void: a stamp of its own; no signing, no revising after.
    await ev({}, "void");
    const st = stateOf({ t, locale: "zh-CN" }, w.res.get("doc"));
    expect(st.voided).toBe(true);
    expect(JSON.stringify(await ev())).toContain("已经作废");
    expect(JSON.stringify(await ev({ params: { reason: "x" } }, "revise"))).toContain("不能修订");
  });

  it("referred to: a section by heading; one item's value (a signed one as it was fixed)", async () => {
    const w = hospital();
    w.res.get("doc")!.body = { template: "tpl", text: ADMISSION, "v.主诉": "胸痛", "v.身高": "1.75" };
    const { kinds } = registry(plugin);
    const sec = await kinds.document.embed(w.ctx("doc"), { section: "主诉" });
    expect(sec.view[0].text).toMatch(/^## 主诉 *\n胸痛 *\n体重 70 kg/);
    expect(await kinds.document.embed(w.ctx("doc"), { inline: true, args: { 项: "身高" } })).toEqual({ text: "1.75 m" });
    expect((await kinds.document.embed(w.ctx("doc"), { inline: true, args: { 项: "无" } })).error).toBe(true);
    expect(await kinds.document.embed(w.ctx("doc"), { section: "没有" })).toEqual({ view: [], sectionMissing: true });
    // Signed: what was fixed.
    w.res.get("doc")!.stamps = [{ label: "书写", signer: "王", at: 1 }];
    w.res.get("doc")!.body.signedText = "# 入院记录\n已定稿";
    expect((await kinds.document.embed(w.ctx("doc"), {})).view[0].text).toContain("已定稿");
    const p = await prepared({ t, locale: "zh-CN", host: { params: { get: async () => ({ found: false }) } }, params: {} }, "{{?x | 数字, kg}}", {});
    expect(readText({ t, locale: "zh-CN" }, p)).toBe("*未填*");
  });
});

describe("series and the book (D487 §23.6)", () => {
  it("adds one from its template, opened; documents land in order; a changed order item moves it", async () => {
    const w = world([
      ["tpl", k("template"), "日常病程记录", null, { text: "时间 {{?时间 | 文字}}\n{{?记录 | 长文字}}" }],
      ["s", k("series"), "病程记录", null, { template: "tpl", order: "时间" }],
      ["d1", k("document"), "a", "s", { "v.时间": "2026-11-24" }],
      ["d2", k("document"), "b", "s", { "v.时间": "2026-11-26" }],
    ]);
    const { pages, kinds, events } = registry(plugin);
    await pages.series.onEvent(w.ctx("s"), "add");
    const made = [...w.res.values()].find((r) => r.id.startsWith("n"))!;
    expect(made).toMatchObject({ parentId: "s", kind: k("document") });
    expect(made.body.text).toContain("{{?记录");
    expect(made.name).toMatch(/日常病程记录$/);
    expect(w.opened).toEqual([`resource:${made.id}`]);
    // Landing in order: the 25th goes between.
    made.body["v.时间"] = "2026-11-25";
    expect(await kinds.series.place(w.ctx("s"), { node: { id: made.id, kind: k("document") } })).toEqual({ before: "d2" });
    expect((await kinds.series.place(w.ctx("s"), { node: { id: null, kind: "x:y" } })).refuse).toBeTruthy();
    await events["resource.changed"](w.ctx(null), { change: "updated", kind: k("document"), id: made.id });
    expect(w.moved).toEqual([made.id]);
    const view = (await pages.series.render(w.ctx("s"))).view;
    expect(checkView(view)).toEqual([]);
    expect(view.find((n: any) => n.id === "docs").rows.length).toBe(3);
  });

  it("roles in a book; the manifest; every key in every language", async () => {
    const { actions } = registry(plugin);
    const roles = (await actions.roles({}, {})).data.kinds;
    expect(roles.find((r: any) => r.kind === "series")).toMatchObject({ part: "body", container: true });
    expect(roles.find((r: any) => r.kind === "template")).toMatchObject({ part: "none" });
    expect(manifest.contributes.kinds.find((x: any) => x.id === "document").fields.signedText.refs).toBe(true);
    expect(manifest.contributes.menus.new).toEqual(["template", "document", "series"]);
    for (const f of ["en-US", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual(Object.keys(ZH).sort());
  });
});

describe("what the book's conventions say of documents (D487 §31.6)", () => {
  it("documents and series say how signing works; templates nothing", async () => {
    const { actions } = registry(plugin);
    const say = async (kind: string) => (await actions.conventions({ t, locale: "zh-CN", resource: { id: "x", kind: `org.onedesk.document:${kind}`, body: {} } }, {})).data.lines;
    expect(await say("document")).toEqual([ZH["conv.document"]]);
    expect(await say("series")).toEqual([ZH["conv.document"]]);
    expect(await say("template")).toEqual([]);
  });
});

describe("review by letter (D487 §35.6)", () => {
  // @ts-ignore
  const sign = () => import("./signoff.js");
  function rw(opts: { signoffs?: any[]; letter?: any; origin?: string } = {}) {
    const made: any[] = [];
    const stamps: any[] = [];
    const host = {
      resources: {
        async list(o: { kind: string; parent?: string }) {
          return (opts.signoffs ?? []).filter((s) => o.parent === undefined || s.parentId === o.parent);
        },
        async get(id: string) {
          return id === "d1" ? { id: "d1", kind: k("document"), name: "出院小结", body: {} } : null;
        },
        async create(spec: any) {
          const r = { id: `n${made.length + 1}`, createdAt: 7, ...spec };
          made.push(r);
          return r;
        },
        async stamp(id: string, s: any) {
          stamps.push({ id, ...s });
          return {};
        },
      },
      letters: {
        async info() {
          return opts.letter ?? null;
        },
      },
      params: { async get() { return { found: true, value: "王主任", sourceName: "Default" }; } },
    };
    const ctx = (params: any = {}) => ({ t, locale: "zh-CN", host, params, resource: { id: "d1", kind: k("document"), name: "出院小结", origin: opts.origin ?? "subscribed", body: {} } });
    return { ctx, made, stamps };
  }
  const letter = { dir: "in", resource: "L", tasks: [{ page: "d1", task: "sign", label: "审签" }] };

  it("in a letter asking for it: the review form; reviewing makes a stamped record under the letter", async () => {
    const s = await sign();
    const w = rw({ letter });
    const nodes = await s.signoffNodes(w.ctx(), async () => ({ name: "signer", label: "签名人", kind: "text", param: true }));
    expect(nodes.find((n: any) => n.id === "review").fields.map((f: any) => f.name)).toEqual(["agree", "opinion", "signer"]);
    const r = await s.signoff(w.ctx({ agree: "disagree", opinion: "剂量要改" }), async () => "王主任");
    expect(r.message).toBe(ZH["signoff.signed"].replace("{how}", "不同意"));
    expect(w.made[0]).toMatchObject({ kind: "signoff", parent: "L", body: { document: "d1", agree: "disagree", comment: "剂量要改", signer: "王主任" } });
    expect(w.stamps[0]).toMatchObject({ id: "n1", label: ZH["stamp.signoff"], signer: "王主任" });
    // Not in a letter: nothing to review.
    const alone = rw({ origin: "original" });
    expect((await s.signoff(alone.ctx(), async () => "X")).message).toBe(ZH["signoff.notLetter"]);
  });

  it("what can be asked, whether it is done, what goes back; the sender's document lists the reviews", async () => {
    const s = await sign();
    const { actions, events } = registry(plugin);
    const own = { id: "so", kind: k("signoff"), parentId: "L", createdAt: 9, body: { document: "d1", agree: "agree", comment: "同意出院", signer: "王主任" } };
    const w = rw({ signoffs: [own], letter });
    expect((await actions.tasks(w.ctx(), {})).data.tasks.map((x: any) => x.task)).toEqual(["sign", "read"]);
    expect((await actions.todo(w.ctx(), { task: "sign" })).data).toEqual({ state: "done", summary: "同意" });
    expect((await actions.reply(w.ctx(), { task: "sign" })).data).toEqual({ data: { agree: "agree", comment: "同意出院", signer: "王主任", at: 9 }, summary: "同意：同意出院" });
    const empty = rw({ letter });
    expect((await actions.todo(empty.ctx(), { task: "sign" })).data.state).toBe("todo");
    expect((await actions.todo(empty.ctx(), { task: "read" })).data.state).toBe("done");
    // The sender's side: a review came back.
    const back = rw({ origin: "original" });
    await events["letter.reply"](back.ctx(), { page: "d1", task: "sign", data: { agree: "agree", comment: "同意出院", signer: "王主任" }, from: { name: "王主任", fingerprint: "F", known: "checked" } });
    expect(back.made[0]).toMatchObject({ kind: "signoff", parent: "d1", body: { agree: "agree", comment: "同意出院", from: { name: "王主任" } } });
    const listed = rw({ origin: "original", signoffs: [{ ...back.made[0], parentId: "d1" }] });
    const nodes = await s.signoffNodes(listed.ctx(), async () => ({}));
    expect(nodes[0].text).toContain("王主任：同意——同意出院（签名有效，已核对）");
  });
});
