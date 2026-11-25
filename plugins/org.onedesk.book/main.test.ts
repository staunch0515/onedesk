import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin from "./main.js";
// @ts-ignore
import { place } from "./book.js";
// @ts-ignore
import { normalize, rolesData } from "./roles.js";
// @ts-ignore
import { outlineOf, readable } from "./text-page.js";
// @ts-ignore
import { chapterOf, entriesOf, numberText, settingsOf } from "./toc.js";
// @ts-ignore
import { chineseNumber, letter } from "./words.js";
import { checkView, onlyKeys, registry, RENDER_KEYS } from "../_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const EN = locale("en-US");
/** `ctx.t` as the kernel gives it: the label in every language. */
const t = (key: string) => ({ "en-US": EN[key] ?? key, "zh-CN": ZH[key] ?? key });

const B = "org.onedesk.book";
type Res = { id: string; kind: string; name: string; parentId: string | null; body: Record<string, any>; rev: number };

/** A workspace: resources in tree order, and the host a book's code gets. */
function world(spec: Array<[string, string, string, string | null, Record<string, any>?]>, opts: { implementers?: Record<string, any>; refs?: Record<string, Array<{ text: string; to: string | null; embed?: boolean }>> } = {}) {
  const res = new Map<string, Res>();
  const order: string[] = [];
  for (const [id, kind, name, parent, body] of spec) {
    // Revisions differ between worlds: the plugin keeps what it read by id and revision.
    res.set(id, { id, kind, name, parentId: parent, body: body ?? {}, rev: ++revs });
    order.push(id);
  }
  const kids = (p: string) => order.filter((x) => res.get(x)!.parentId === p);
  const storage = new Map<string, unknown>();
  const files = new Map<string, string>();
  const blobs: string[] = [];
  let next = 0;
  const host = {
    resources: {
      async tree(id: string, o: { offset?: number; limit?: number } = {}) {
        const all: any[] = [];
        const walk = (p: string, depth: number) => {
          for (const k of kids(p)) {
            const r = res.get(k)!;
            all.push({ id: r.id, name: r.name, kind: r.kind, icon: "x", depth, parent: p, rev: r.rev });
            walk(k, depth + 1);
          }
        };
        walk(id, 1);
        const off = o.offset ?? 0;
        const lim = o.limit ?? 2000;
        return { nodes: all.slice(off, off + lim), next: off + lim < all.length ? off + lim : null };
      },
      async get(id: string) {
        return res.get(id) ?? null;
      },
      async create(spec: { kind: string; parent: string }) {
        const id = `new${++next}`;
        const kind = `${B}:${spec.kind}`;
        res.set(id, { id, kind, name: EN[`kind.${spec.kind}.new`], parentId: spec.parent, body: {}, rev: 1 });
        order.push(id);
        return res.get(id);
      },
      async refs(id: string) {
        return (opts.refs?.[id] ?? []).map((r) => ({ text: r.text, embed: r.embed ?? false, section: null, target: r.to ? { id: r.to, name: res.get(r.to)?.name, kind: res.get(r.to)?.kind } : null }));
      },
      async embed(id: string) {
        const r = res.get(id)!;
        if (r.kind.endsWith(":pic")) return { view: [{ type: "image", id: "i", blob: "b".repeat(64), alt: "pic" }] };
        if (r.kind.endsWith(":grid")) return { view: [{ type: "table", id: "t", columns: [{ key: "a", label: "A" }], rows: [["x|y"]] }] };
        return { view: [{ type: "text", id: "t", text: `${r.body.text ?? ""} ![s](blob:${"c".repeat(64)})`, format: "markdown" }] };
      },
    },
    interfaces: {
      async list() {
        return Object.keys(opts.implementers ?? {}).map((plugin) => ({ plugin }));
      },
      async call(_i: string, action: string, input: any, o: any) {
        const imp = opts.implementers?.[o.plugin ?? String(o.resource).split("/")[0]];
        if (!imp) throw new Error("noImplementation");
        return { data: imp[action](input) };
      },
    },
    storage: {
      async get(k: string) {
        return storage.get(k) ?? null;
      },
      async set(k: string, v: unknown) {
        storage.set(k, v);
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
      async mkdir(p: string) {
        files.set(p, "<dir>");
      },
      async writeBlob(blob: string, p: string) {
        blobs.push(blob);
        files.set(`${p}.png`, "<png>");
        return { path: `${p}.png` };
      },
      async writeText(p: string, text: string) {
        files.set(p, text);
      },
    },
    params: { async get() { return { found: false }; } },
    util: {
      async collate(texts: string[], locale: string) {
        const c = new Intl.Collator(locale);
        return texts.map((_, i) => i).sort((a, b) => c.compare(texts[a]!, texts[b]!) || a - b);
      },
    },
  };
  const ctx = (id: string | null, extra: Record<string, any> = {}) => ({ t, locale: "zh-CN", host, params: {}, resource: id ? res.get(id) : null, ...extra });
  return { res, host, ctx, storage, files, blobs };
}

const k = (s: string) => `${B}:${s}`;
let revs = 0;

/** A book: cover, contents, preface, two chapters (one a group with two pages), an appendix with a table, an afterword. */
function sample() {
  return world([
    ["bk", k("book"), "文集", null],
    ["cv", k("cover"), "封面", "bk", { subtitle: "副", authors: "鲁迅 著", blurb: "简介" }],
    ["tc", k("toc"), "目录", "bk", { numbering: "words", levels: "", volume: "" }],
    ["pf", k("preface"), "序", "bk", { text: "序文" }],
    ["c1", k("page"), "秒的认识", "bk", { text: "图：钟面\n\n表：换算\n\n表：二" }],
    ["g2", "core:group", "分和时", "bk"],
    ["p21", k("page"), "分", "g2", { text: "图：分针" }],
    ["p22", "org.onedesk.note:note", "时", "g2", { text: "笔记" }],
    ["ap", k("appendix"), "换算表", "bk"],
    ["ap1", "x.grid:grid", "长度", "ap"],
    ["aw", k("afterword"), "后记", "bk", { text: "完" }],
  ]);
}

describe("words (D487 §13.4.4)", () => {
  it("Chinese numerals and letters", () => {
    expect([1, 2, 10, 11, 20, 21, 101, 110, 1001, 9999].map(chineseNumber)).toEqual(["一", "二", "十", "十一", "二十", "二十一", "一百零一", "一百一十", "一千零一", "九千九百九十九"]);
    expect([1, 2, 26, 27, 52].map(letter)).toEqual(["A", "B", "Z", "AA", "AZ"]);
  });
  it("numbers by level names, deeper by digits; numbers; none; English words", () => {
    const zh = { t, locale: "zh-CN" };
    const s = settingsOf(zh, {}, null);
    expect(s.levels).toEqual(["章", "节"]);
    expect([numberText(zh, s, [3]), numberText(zh, s, [3, 2]), numberText(zh, s, [3, 2, 1]), numberText(zh, s, ["A", 1])]).toEqual(["第三章", "第二节", "3.2.1", "A.1"]);
    expect(numberText(zh, settingsOf(zh, { numbering: "numbers" }, null), [3, 2])).toBe("3.2");
    expect(numberText(zh, settingsOf(zh, { numbering: "none" }, null), [3])).toBe("");
    const en = { t, locale: "en-US" };
    expect(numberText(en, settingsOf(en, {}, null), [3])).toBe("Chapter 3");
    expect(settingsOf(zh, { levels: "编，章、节" }, null).levels).toEqual(["编", "章", "节"]);
  });
});

describe("the contents (D487 §13.4)", () => {
  it("reads front, body, back in order; numbers chapters, sections, the appendix; skips cover and contents", async () => {
    const w = sample();
    const { items } = await entriesOf(w.ctx("tc"), "bk", settingsOf(w.ctx("tc"), {}, null));
    expect(items.map((x: any) => [x.title, x.level])).toEqual([
      ["序", 1],
      ["第一章 秒的认识", 1],
      ["第二章 分和时", 1],
      ["第一节 分", 2],
      ["第二节 时", 2],
      ["附录 A 换算表", 1],
      ["A.1 长度", 2],
      ["后记", 1],
    ]);
    // A group has no content of its own; captions carry on within a chapter.
    expect(items.find((x: any) => x.key === "g2").resource).toBeUndefined();
    expect(items.find((x: any) => x.key === "c1").args).toEqual({ book: { prefix: "1", figure: 0, table: 0 } });
    expect(items.find((x: any) => x.key === "p21").args).toEqual({ book: { prefix: "2", figure: 0, table: 0 } });
    expect(items.find((x: any) => x.key === "ap1").args.book.prefix).toBe("A");
    expect(checkView([{ type: "sequence", id: "s", items }])).toEqual([]);
  });

  it("captions continue from the pages before them in the same chapter", async () => {
    const w = world([
      ["bk", k("book"), "B", null],
      ["g", "core:group", "G", "bk"],
      ["a", k("page"), "a", "g", { text: "图：一\n\n图：二\n\n表：三" }],
      ["b", k("page"), "b", "g", { text: "图：四" }],
    ]);
    const { items } = await entriesOf(w.ctx(null), "bk", settingsOf(w.ctx(null), {}, null));
    expect(items.find((x: any) => x.key === "b").args.book).toEqual({ prefix: "1", figure: 2, table: 1 });
  });

  it("sub-books start numbering again with their own settings, or the outer ones; volumes are named", async () => {
    const w = world([
      ["bk", k("book"), "全集", null],
      ["v1", k("book"), "呐喊", "bk"],
      ["v1t", k("toc"), "目录", "v1", { numbering: "numbers" }],
      ["v1a", k("page"), "自序", "v1"],
      ["v1b", k("page"), "狂人日记", "v1"],
      ["v2", k("book"), "彷徨", "bk"],
      ["v2a", k("page"), "祝福", "v2"],
    ]);
    const { items } = await entriesOf(w.ctx(null), "bk", settingsOf(w.ctx(null), { volume: "卷" }, null));
    expect(items.map((x: any) => [x.title, x.level, x.book ?? false])).toEqual([
      ["第一卷 呐喊", 1, true],
      ["1 自序", 2, false],
      ["2 狂人日记", 2, false],
      ["第二卷 彷徨", 1, true],
      ["第一章 祝福", 2, false],
    ]);
  });

  it("another plugin's kinds play the roles it declares; asked once", async () => {
    let asked = 0;
    const implementers = {
      "x.quiz": {
        roles: () => {
          asked += 1;
          return { kinds: [{ kind: "answers", role: "answers", part: "back", numbering: "letter", container: false }, { kind: "quiz", role: "body", part: "weird" }] };
        },
        outline: () => ({ headings: [], figures: [{ type: "figure", caption: "x" }] }),
      },
    };
    const w = world(
      [
        ["bk", k("book"), "B", null],
        ["ans", "x.quiz:answers", "答案", "bk"],
        ["q", "x.quiz:quiz", "测验", "bk"],
        ["q2", "x.quiz:quiz", "测验二", "bk"],
      ],
      { implementers },
    );
    const { items } = await entriesOf(w.ctx(null), "bk", settingsOf(w.ctx(null), {}, null));
    expect(items.map((x: any) => x.title)).toEqual(["第一章 测验", "第二章 测验二", "附录 A 答案"]);
    expect(asked).toBe(1);
    expect(normalize({ part: "nowhere", numbering: "odd" })).toMatchObject({ role: "body", part: "body", numbering: "level", container: true });
  });

  it("a chapter by name, number or title, with what is below it", async () => {
    const w = sample();
    const e = await entriesOf(w.ctx(null), "bk", settingsOf(w.ctx(null), {}, null));
    expect(chapterOf(e, "分和时").map((x: any) => x.key)).toEqual(["g2", "p21", "p22"]);
    expect(chapterOf(e, "第二章").map((x: any) => x.key)).toEqual(["g2", "p21", "p22"]);
    expect(chapterOf(e, "第一章 秒的认识").map((x: any) => x.key)).toEqual(["c1"]);
    expect(chapterOf(e, "没有")).toBeNull();
  });

  it("the page: settings in one row, the book read through, from where the reader stopped; the position is kept", async () => {
    const w = sample();
    const { pages } = registry(plugin);
    await pages.toc.onEvent(w.ctx("tc", { row: "p21" }), "position");
    expect(w.storage.get("pos:tc")).toBe("p21");
    const out = await pages.toc.render(w.ctx("tc", { params: { "view.mode": "pages" } }));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0]).toMatchObject({ type: "form", layout: "strip" });
    expect(out.view[1]).toMatchObject({ type: "sequence", toc: true, mode: "pages", start: "p21", positionEvent: "position" });
    // Settings typed but not saved show at once.
    const draft = await pages.toc.render(w.ctx("tc", { draft: { "body.numbering": "numbers" } }));
    expect(draft.view[1].items[1].title).toBe("1 秒的认识");
    const toggled = await pages.toc.onEvent(w.ctx("tc"), "toggle");
    expect(toggled.params).toEqual({ "view.mode": "pages" });
    // Out of a book.
    const lone = world([["t", k("toc"), "目录", null]]);
    expect((await pages.toc.render(lone.ctx("t"))).view[1].id).toBe("alone");
  });

  it("exports the book to a file in the granted folder, images beside it, never over a file", async () => {
    const w = sample();
    w.res.set("pic", { id: "pic", kind: "x.pics:pic", name: "插图", parentId: "bk", body: {}, rev: 1 });
    const { actions } = registry(plugin);
    w.files.set("/out/文集.md", "old");
    const r = await actions.export(w.ctx("tc"), {});
    const md = w.files.get("/out/文集 2.md")!;
    expect(md).toContain("# 文集");
    expect(md).toContain("鲁迅 著");
    expect(md).toContain("## 第一章 秒的认识");
    expect(md).toContain("### 第一节 分");
    expect(md).toContain("| x\\|y |");
    expect(md).toMatch(/\(<文集 2-图片\/1\.png>\)/);
    expect(w.files.get("/out/文集.md")).toBe("old");
    expect(r.output.type).toBe("text");
  });
});

describe("binding (D487 §13.2)", () => {
  const ctx = (w: any) => w.ctx("bk");
  it("a page lands in its own part, near where it was dropped; a second contents is refused", async () => {
    const w = sample();
    // An appendix dropped before chapter one goes to the back part, as near as can be: its start.
    expect(await place(ctx(w), { node: { id: null, kind: k("appendix"), name: "新" }, before: "c1" })).toEqual({ before: "ap" });
    // Dropped at the end it stays at the end.
    expect(await place(ctx(w), { node: { id: null, kind: k("appendix"), name: "新" }, before: null })).toEqual({ before: null });
    // A preface dropped at the end goes before the first chapter.
    expect(await place(ctx(w), { node: { id: null, kind: k("preface"), name: "新" }, before: null })).toEqual({ before: "c1" });
    // A body page dropped between two chapters stays there.
    expect(await place(ctx(w), { node: { id: "x", kind: "org.onedesk.note:note", name: "n" }, before: "g2" })).toEqual({ before: "g2" });
    // Contents and cover stay in front.
    const tocMoved = await place(ctx(w), { node: { id: "tc", kind: k("toc"), name: "目录" }, before: null });
    expect(tocMoved).toEqual({ before: "pf" });
    expect((await place(ctx(w), { node: { id: null, kind: k("toc"), name: "x" }, before: null })).refuse).toBeTruthy();
    expect((await place(ctx(w), { node: { id: null, kind: k("cover"), name: "x" }, before: null })).refuse).toBeTruthy();
  });

  it("a new book gets a cover and a contents", async () => {
    const w = world([["bk", k("book"), "B", null]]);
    const { events } = registry(plugin);
    await events["resource.changed"](w.ctx(null), { id: "bk", kind: k("book"), change: "created" });
    await events["resource.changed"](w.ctx(null), { id: "bk", kind: k("book"), change: "updated" });
    const kinds = [...w.res.values()].filter((r) => r.parentId === "bk").map((r) => r.kind);
    expect(kinds).toEqual([k("cover"), k("toc")]);
  });

  it("opening the book shows its cover and the way into reading; embedded, its cover or one chapter", async () => {
    const w = sample();
    const { pages, kinds } = registry(plugin);
    const out = await pages.book.render(w.ctx("bk"));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0]).toMatchObject({ type: "link", target: "resource:tc" });
    expect(out.view[1]).toMatchObject({ type: "sequence", items: [{ key: "cover", title: "文集", level: 1, resource: "cv" }] });
    expect((await pages.book.render(w.ctx(null))).view[0].id).toBe("unsaved");
    expect((await pages.toc.render(w.ctx(null))).view[1].id).toBe("alone");
    expect((await pages.cover.render(w.ctx(null))).view[0].tone).toBe("muted");
    expect((await pages.appendix.render(w.ctx(null))).view[0].id).toBe("alone");
    const face = await kinds.book.embed(w.ctx("bk"), { section: null });
    expect(face.view[0].items[0].resource).toBe("cv");
    const ch = await kinds.book.embed(w.ctx("bk"), { section: "分和时" });
    expect(ch.view[0].items.map((x: any) => x.key)).toEqual(["g2", "p21", "p22"]);
    expect(await kinds.book.embed(w.ctx("bk"), { section: "无" })).toEqual({ view: [], sectionMissing: true });
    const cover = kinds.cover.embed(w.ctx("cv"));
    expect(cover.view[0]).toMatchObject({ type: "text", format: "markdown" });
    expect(cover.view[0].text).toContain("鲁迅 著");
  });
});

describe("text pages (D487 §13.5)", () => {
  const zh = { t, locale: "zh-CN" };
  it("captions numbered by the book's prefix, or alone; any of three languages' words", () => {
    const text = "![[电路]]\n图：并联电路\n\n表：电阻\n|a|\n\nFigure: two\n\n```\n图：不是题注\n```";
    const r = readable(zh, text, { prefix: "2", figure: 3, table: 0 });
    expect(r).toContain("*图 2-4　并联电路*");
    expect(r).toContain("*表 2-1　电阻*");
    expect(r).toContain("*图 2-5　two*");
    expect(r).toContain("图：不是题注");
    expect(readable(zh, "図：一", null)).toContain("*图 1　一*");
    expect(outlineOf(text).figures).toEqual([
      { type: "figure", caption: "并联电路", of: "电路" },
      { type: "table", caption: "电阻" },
      { type: "figure", caption: "two" },
    ]);
  });
  it("footnotes become numbers in the order they are used, listed at the end", () => {
    const r = readable(zh, "甲[^b]乙[^a]丙[^b][^none]\n\n[^a]: 注 A\n[^b]: 注 B", null);
    expect(r).toContain("甲¹乙²丙¹[^none]");
    expect(r).toContain("**注释**");
    expect(r).toContain("1. 注 B\n2. 注 A");
    expect(r).not.toContain("[^a]:");
  });
  it("read and edit; the preface says which kind it is; embedded with the book's numbers", async () => {
    const w = sample();
    const { pages, kinds } = registry(plugin);
    const edit = await pages.text.render(w.ctx("pf"));
    expect(checkView(edit.view)).toEqual([]);
    expect(edit.view.map((n: any) => n.id)).toEqual(["variant", "content"]);
    const read = await pages.text.render(w.ctx("c1", { params: { "view.mode": "read" } }));
    expect(read.view[0].text).toContain("*图 1　钟面*");
    const e = await kinds.page.embed(w.ctx("c1"), { section: null, args: { book: { prefix: "1", figure: 0, table: 0 } } });
    expect(e.view[0].text).toContain("*图 1-1　钟面*");
    expect(await kinds.page.embed(w.ctx("c1"), { section: "无" })).toEqual({ view: [], sectionMissing: true });
  });
});

describe("the interface and the manifest (D487 §13.6, §13.7)", () => {
  it("roles, outline and entries answer as the interface says", async () => {
    const w = sample();
    const { actions } = registry(plugin);
    expect((await actions.roles(w.ctx(null), {})).data).toEqual(rolesData());
    expect(rolesData().kinds.find((x: any) => x.kind === "appendix")).toMatchObject({ part: "back", numbering: "letter", container: true });
    expect((await actions.outline(w.ctx("c1"), { resource: "c1" })).data.figures).toHaveLength(3);
    const e = (await actions.entries(w.ctx("tc"), { resource: "tc", depth: 1 })).data.items;
    expect(e[1]).toMatchObject({ title: "第一章 秒的认识", level: 2 });
  });

  it("eleven kinds; the book binds and places; the contents exports; every key in every language", () => {
    const kinds = manifest.contributes.kinds.map((x: any) => x.id);
    expect(kinds).toEqual(["book", "cover", "toc", "preface", "page", "afterword", "appendix", "references", "reference", "index", "figures"]);
    expect(manifest.implements["onedesk.book/1"].kinds).toEqual(expect.arrayContaining(["references", "reference", "index", "figures"]));
    expect(manifest.contributes.kinds[0]).toMatchObject({ accepts: ["*"], place: true, embed: true });
    expect(manifest.requires).toEqual({ files: true, resources: true, contents: true });
    expect(manifest.implements["onedesk.book/1"].actions).toEqual(["roles", "outline", "entries", "number", "cite"]);
    const keys = Object.keys(EN);
    for (const f of ["zh-CN", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual([...keys].sort());
    const used = JSON.stringify(manifest).match(/"(kind|action|tab|plugin|field)\.[\w.]+"/g)!.map((s) => s.slice(1, -1));
    for (const key of used) expect(EN[key], key).toBeTruthy();
  });
});

// @ts-ignore
import { authorsText, formatEntry } from "./references.js";

describe("step ③: references, index, figures, cross references (D487 §15)", () => {
  /** A book with references (two entries), a figure list, an index, and pages citing, marking terms and referring. */
  function scholar(system = "numeric", list = "cited") {
    return world(
      [
        ["bk", k("book"), "书", null],
        ["tc", k("toc"), "目录", "bk", {}],
        ["fg", k("figures"), "图表目录", "bk"],
        ["c1", k("page"), "电学", "bk", { text: "![[电路]]\n图：并联电路\n\n见[@张三2020]与[@李四2019, 第 12 页; @张三2020]，{{索引:欧姆定律}}{{索引:电路/并联}}\n\n如[[电路]]所示，见[[磁学]]，[@无此人]" }],
        ["c2", k("page"), "磁学", "bk", { text: "表：单位\n\n{{索引:电路/串联}}{{索引:安培}}[@李四2019]" }],
        ["pic", "x.pics:pic", "电路", "c1"],
        ["rf", k("references"), "参考文献", "bk", { system, list }],
        ["e1", k("reference"), "张三2020", "rf", { type: "M", authors: "张三, 王五", title: "电学原理", place: "北京", publisher: "某出版社", year: "2020" }],
        ["e2", k("reference"), "李四2019", "rf", { type: "J", authors: "李四", title: "磁场", container: "物理学报", year: "2019", volume: "68", issue: "3", pages: "1-9" }],
        ["e3", k("reference"), "Smith2018", "rf", { type: "EB/OL", authors: "Smith, John", title: "Web", year: "2018", accessed: "2026-01-01", url: "https://x.org" }],
        ["ix", k("index"), "索引", "bk"],
      ],
      { refs: { c1: [{ text: "电路", to: "pic", embed: true }, { text: "电路", to: "pic" }, { text: "磁学", to: "c2" }] } },
    );
  }

  it("GB/T 7714: books, articles, web pages; more than three authors", () => {
    expect(formatEntry({ type: "M", authors: "张三", title: "书", place: "北京", publisher: "社", year: "2020", pages: "12" })).toBe("张三. 书[M]. 北京: 社, 2020: 12.");
    expect(formatEntry({ type: "J", authors: "李四", title: "文", container: "学报", year: "2019", volume: "68", issue: "3", pages: "1-9" })).toBe("李四. 文[J]. 学报, 2019, 68(3): 1-9.");
    expect(formatEntry({ type: "EB/OL", authors: "Smith", title: "Web", year: "2018", accessed: "2026-01-01", url: "https://x.org" })).toBe("Smith. Web[EB/OL]. (2018)[2026-01-01]. https://x.org.");
    expect(formatEntry({ type: "C", authors: "甲", title: "篇", container: "论文集", place: "上海", publisher: "社", year: "2001", doi: "10.1/x" })).toBe("甲. 篇[C]//论文集. 上海: 社, 2001. DOI: 10.1/x.");
    expect(authorsText("甲, 乙, 丙, 丁")).toBe("甲, 乙, 丙, 等");
    expect(authorsText("A, B, C, D")).toBe("A, B, C, et al.");
  });

  it("citations are numbered in the order first cited; notes; a missing key; the list and what was not found", async () => {
    const w = scholar();
    const e = await entriesOf(w.ctx(null), "bk", settingsOf(w.ctx(null), {}, null));
    const c1 = e.items.find((x: any) => x.key === "c1");
    expect(c1.args.book.cites).toEqual(["[1]", "[2: 第 12 页, 1]", "[?无此人]"]);
    expect(e.items.find((x: any) => x.key === "c2").args.book.cites).toEqual(["[2]"]);
    const { pages } = registry(plugin);
    const out = await pages.references.render(w.ctx("rf"));
    expect(checkView(out.view)).toEqual([]);
    const table = out.view.find((n: any) => n.id === "list");
    expect(table.rows).toEqual([["[1]", "张三, 王五. 电学原理[M]. 北京: 某出版社, 2020."], ["[2]", "李四. 磁场[J]. 物理学报, 2019, 68(3): 1-9."]]);
    expect(table.rowTargets).toEqual(["resource:e1", "resource:e2"]);
    const lost = out.view.find((n: any) => n.id === "lost");
    expect(lost.rows).toEqual([["无此人", "第一章 电学"]]);
    // All entries: the uncited one comes after.
    const all = await pages.references.render(scholar("numeric", "all").ctx("rf"));
    expect(all.view.find((n: any) => n.id === "list").rows).toHaveLength(3);
  });

  it("author and year: in the text and the list (sorted)", async () => {
    const w = scholar("authorYear");
    const e = await entriesOf(w.ctx(null), "bk", settingsOf(w.ctx(null), {}, null));
    expect(e.items.find((x: any) => x.key === "c1").args.book.cites).toEqual(["（张三，等，2020）", "（李四，2019：第 12 页；张三，等，2020）", "（?无此人）"]);
    const en = await entriesOf(w.ctx(null, { locale: "en-US" }), "bk", settingsOf(w.ctx(null, { locale: "en-US" }), {}, null));
    expect(en.items.find((x: any) => x.key === "c2").args.book.cites).toEqual(["(李四, 2019)"]);
    const out = await registry(plugin).pages.references.render(w.ctx("rf"));
    expect(out.view.find((n: any) => n.id === "list").rows.map((r: any) => r[0].slice(0, 2))).toEqual(["李四", "张三"]);
  });

  it("cross references show numbers: a chapter, a captioned image; in the page's text", async () => {
    const w = scholar();
    const e = await entriesOf(w.ctx(null), "bk", settingsOf(w.ctx(null), {}, null));
    expect(e.items.find((x: any) => x.key === "c1").args.book.labels).toEqual({ 电路: "图 1-1", 磁学: "第二章" });
    const { kinds } = registry(plugin);
    const r = await kinds.page.embed(w.ctx("c1"), { args: e.items.find((x: any) => x.key === "c1").args });
    expect(r.view[0].refLabels).toEqual({ 电路: "图 1-1", 磁学: "第二章" });
    expect(r.view[0].text).toContain("见[1]与[2: 第 12 页, 1]");
    expect(r.view[0].text).not.toContain("{{索引");
    expect(checkView(r.view)).toEqual([]);
    // Alone: names, keys as written.
    const alone = await kinds.page.embed(w.ctx("c1"), {});
    expect(alone.view[0].refLabels).toBeUndefined();
    expect(alone.view[0].text).toContain("见[张三2020]");
  });

  it("the index: sorted by pinyin, sub-terms under their term, places once each", async () => {
    const w = scholar();
    const out = await registry(plugin).pages.index.render(w.ctx("ix"));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].rows).toEqual([
      ["安培", "第二章"],
      ["电路", ""],
      ["　并联", "第一章"],
      ["　串联", "第二章"],
      ["欧姆定律", "第一章"],
    ]);
    expect(out.view[0].rowTargets[0]).toBe("resource:c2");
  });

  it("the list of figures: figures and tables with numbers, captions and chapters", async () => {
    const w = scholar();
    const out = await registry(plugin).pages.figures.render(w.ctx("fg"));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view.find((n: any) => n.id === "figure").rows).toEqual([["图 1-1", "并联电路", "第一章"]]);
    expect(out.view.find((n: any) => n.id === "table").rows).toEqual([["表 2-1", "单位", "第二章"]]);
    const lone = await registry(plugin).pages.figures.render(world([["f", k("figures"), "x", null]]).ctx("f"));
    expect(lone.view[0].id).toBe("alone");
  });

  it("the interface: number and cite; entries says figures, terms and citations", async () => {
    const w = scholar();
    const { actions } = registry(plugin);
    const n = await actions.number(w.ctx("tc"), { targets: ["c2", "pic", "nobody"] });
    expect(n.data.labels).toEqual({ c2: "第二章", pic: "图 1-1" });
    const c = await actions.cite(w.ctx("rf"), { cites: [{ keys: ["李四2019"] }, { keys: ["张三2020"], notes: ["5"] }] });
    expect(c.data.labels).toEqual(["[1]", "[2: 5]"]);
    const e = (await actions.entries(w.ctx("tc"), {})).data;
    expect(e.figures.map((f: any) => f.number)).toEqual(["1-1", "2-1"]);
    expect(e.terms).toHaveLength(4);
    expect(e.cites[0]).toEqual({ keys: ["张三2020"], notes: [null], item: "c1" });
  });
});
