import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { arrange, chain, languageOf } from "./main.js";
import { CRUMB_KEYS, RENDER_KEYS, SAVE_KEYS, TREE_NODE_KEYS, TREE_PAGE_KEYS, checkView, hostError, onlyKeys, registry, t } from "../_testing/view-check";

const ROOT = "/Users/me/docs";
const roots = [{ path: ROOT, name: "docs" }];
const entry = (name: string, dir = false, hidden = false) => ({ name, path: `${ROOT}/${name}`, dir, size: 1, modifiedAt: 0, hidden });

function ctxOf(files: Record<string, unknown>, key: string, extra: Record<string, unknown> = {}) {
  return { target: `node:org.onedesk.files:files/${encodeURIComponent(key)}`, node: { tree: "org.onedesk.files:files", key }, locale: "en-US", host: { files }, t, ...extra };
}

describe("files plugin: tree", () => {
  it("top level is the authorized folders; empty when none", async () => {
    const { trees } = registry(plugin);
    const files = { roots: vi.fn(async () => roots) };
    const out = await trees.files.children(ctxOf(files, ""), null, 0);
    expect(out.nodes).toEqual([{ key: ROOT, label: "docs", icon: "folder", expandable: true, target: `node:org.onedesk.files:files/${encodeURIComponent(ROOT)}` }]);
    files.roots.mockResolvedValue([]);
    expect((await trees.files.children(ctxOf(files, ""), null, 0)).nodes).toEqual([]);
  });

  it("lists folders first, sorted, no hidden, files target a node page", async () => {
    const { trees } = registry(plugin);
    const files = {
      list: vi.fn(async () => ({
        entries: [entry("b.txt"), entry("Zeta", true), entry(".git", true, true), entry("a.md"), entry("alpha", true), entry(".env", false, false)],
        next: 200,
      })),
    };
    const out = await trees.files.children(ctxOf(files, ROOT), ROOT, 0);
    expect(out.nodes.map((n: any) => n.label)).toEqual(["alpha", "Zeta", "a.md", "b.txt"]);
    expect(out.nodes[0]).toMatchObject({ expandable: true, key: `${ROOT}/alpha` });
    expect(out.nodes[0].target).toBe(`node:org.onedesk.files:files/${encodeURIComponent(`${ROOT}/alpha`)}`); // folders open the operations page
    expect(out.nodes[2].target).toBe(`node:org.onedesk.files:files/${encodeURIComponent(`${ROOT}/a.md`)}`);
    expect(out.next).toBe(200);
    expect(onlyKeys(out, TREE_PAGE_KEYS)).toEqual([]);
    for (const n of out.nodes) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
    expect(files.list).toHaveBeenCalledWith(ROOT, { offset: 0, limit: 200 });
  });

  it("passes the offset on and omits next at the end", async () => {
    const { trees } = registry(plugin);
    const files = { list: vi.fn(async () => ({ entries: [entry("x.txt")] })) };
    const out = await trees.files.children(ctxOf(files, ROOT), ROOT, 200);
    expect("next" in out).toBe(false);
    expect(files.list).toHaveBeenCalledWith(ROOT, { offset: 200, limit: 200 });
  });

  it("a denied listing propagates", async () => {
    const { trees } = registry(plugin);
    const files = { list: async () => { throw hostError("denied"); } };
    await expect(trees.files.children(ctxOf(files, "/etc"), "/etc", 0)).rejects.toMatchObject({ code: "denied" });
  });

  it("path runs from the authorized folder down", async () => {
    const { trees } = registry(plugin);
    const files = { roots: async () => roots };
    expect(await trees.files.path(ctxOf(files, ""), `${ROOT}/a/b.txt`)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b.txt`]);
  });

  it("helpers", () => {
    expect(chain("/Users/me/docs2/x", roots)).toBeNull();
    expect(chain(ROOT, roots)).toEqual([ROOT]);
    expect(languageOf("a.RS")).toBe("rust");
    expect(languageOf("Makefile")).toBeUndefined();
    expect(arrange([entry("b"), entry("a")]).map((e: { name: string }) => e.name)).toEqual(["a", "b"]);
  });
});

describe("files plugin: text page", () => {
  const key = `${ROOT}/notes.md`;

  it("shows a full-height code field with language, values and basis", async () => {
    const { pages } = registry(plugin);
    const files = { roots: async () => roots, readText: vi.fn(async () => ({ text: "# hi", basis: "b1" })) };
    const out = await pages.text.render(ctxOf(files, key));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view.find((n: any) => n.id === "content").fields[0]).toMatchObject({ kind: "code", bind: "content", fill: true, language: "markdown" });
    expect(out).toMatchObject({ title: "notes.md", values: { content: "# hi" }, basis: "b1" });
    expect(out.breadcrumb.map((c: any) => c.label)).toEqual(["docs", "notes.md"]);
    expect(out.readOnly).toBeUndefined();
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    for (const c of out.breadcrumb) expect(onlyKeys(c, CRUMB_KEYS)).toEqual([]);
  });

  it("no language for unknown extensions", async () => {
    const { pages } = registry(plugin);
    const files = { roots: async () => roots, readText: async () => ({ text: "", basis: "b" }) };
    const out = await pages.text.render(ctxOf(files, `${ROOT}/data.xyz`));
    expect("language" in out.view.find((n: any) => n.id === "content").fields[0]).toBe(false);
  });

  it.each([
    ["invalid", { reason: "tooLarge" }, "reason.tooLarge"],
    ["invalid", { reason: "notText" }, "reason.notText"],
    ["denied", {}, "reason.denied"],
    ["notFound", {}, "reason.notFound"],
    ["internal", {}, "reason.failed"],
  ])("%s %j → muted explanation", async (code, params, textKey) => {
    const { pages } = registry(plugin);
    const files = { roots: async () => roots, readText: async () => { throw hostError(code, params as Record<string, string>); } };
    const out = await pages.text.render(ctxOf(files, key));
    expect(checkView(out.view)).toEqual([]);
    const reason = out.view.find((n: any) => n.id === "reason");
    expect(reason).toMatchObject({ type: "text", id: "reason", tone: "muted" });
    expect(reason.text).toBe(textKey); // fake t() returns the key for en-US
    expect(out.readOnly).toBe(true);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    for (const c of out.breadcrumb) expect(onlyKeys(c, CRUMB_KEYS)).toEqual([]);
  });

  it("save writes with the basis and returns the new one", async () => {
    const { pages } = registry(plugin);
    const files = { writeText: vi.fn(async () => ({ basis: "b2" })) };
    const res = await pages.text.save(ctxOf(files, key), { content: "new" }, "b1");
    expect(files.writeText).toHaveBeenCalledWith(key, "new", { basis: "b1" });
    expect(res).toEqual({ basis: "b2" });
    expect(onlyKeys(res, SAVE_KEYS)).toEqual([]);
  });

  it("save without a basis passes no options", async () => {
    const { pages } = registry(plugin);
    const files = { writeText: vi.fn(async () => ({ basis: "b" })) };
    await pages.text.save(ctxOf(files, key), { content: "x" }, undefined);
    expect(files.writeText).toHaveBeenCalledWith(key, "x", undefined);
  });

  it.each(["conflict", "denied", "invalid"])("save: %s propagates to the kernel", async (code) => {
    const { pages } = registry(plugin);
    const files = { writeText: async () => { throw hostError(code); } };
    await expect(pages.text.save(ctxOf(files, key), { content: "x" }, "b1")).rejects.toMatchObject({ code });
  });
});

/* ---------------------------------------------------------------- round 17 */

import { readFileSync } from "node:fs";
// @ts-ignore plain JS module, no types
import { diskFileItem, importFolder, joinPath, normalize, rootOf, validName } from "./main.js";
import { checkActionResult } from "../_testing/view-check";

const loadLocale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = loadLocale("en-US");
const ZH = loadLocale("zh-CN");
const JA = loadLocale("ja-JP");
const tt = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

type Node = { dir: boolean; size: number };
/** An in-memory disk behind the assumed X18 host interface, plus a Trash and a log of every call. */
function fakeDisk(initial: Record<string, number | null>, roots = [{ path: ROOT, name: "docs" }]) {
  const fs = new Map<string, Node>();
  const trash: string[] = [];
  const calls: string[] = [];
  const grants = [...roots];
  const put = (p: string, size: number | null) => fs.set(p, { dir: size === null, size: size ?? 0 });
  for (const r of roots) put(r.path, null);
  for (const [p, s] of Object.entries(initial)) put(p, s);
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const under = (p: string) => [...fs.keys()].filter((k) => k === p || k.startsWith(`${p}/`));
  const log = (name: string, ...a: unknown[]) => void calls.push(`${name} ${a.filter((x) => typeof x === "string").join(" ")}`);
  // The host's own conflict handling (round 17 §3.1): fail | overwrite | skip | keepBoth.
  const place = (op: "copy" | "move", a: string, b: string, conflict: string) => {
    let to = b;
    if (fs.has(b)) {
      if (conflict === "fail") throw hostError("conflict", { reason: "exists" });
      if (conflict === "skip") return { path: b, skipped: true };
      if (conflict === "keepBoth") {
        const dot = b.lastIndexOf(".");
        for (let i = 2; fs.has(to); i++) to = dot > b.lastIndexOf("/") ? `${b.slice(0, dot)} ${i}${b.slice(dot)}` : `${b} ${i}`;
      } else for (const k of under(b)) fs.delete(k);
    }
    log(op, a, to, conflict);
    for (const k of under(a)) {
      put(to + k.slice(a.length), fs.get(k)!.dir ? null : fs.get(k)!.size);
      if (op === "move") fs.delete(k);
    }
    return { path: to, skipped: false };
  };
  const files = {
    roots: vi.fn(async () => grants.map((g) => ({ ...g }))),
    stat: vi.fn(async (p: string) => {
      const n = fs.get(p);
      if (!n) throw hostError("notFound");
      return { name: p.split("/").pop(), path: p, dir: n.dir, size: n.size, modifiedAt: 1700000000000 };
    }),
    list: vi.fn(async (p: string) => ({
      entries: [...fs.entries()].filter(([k]) => k !== p && parent(k) === p).map(([k, n]) => ({ name: k.split("/").pop(), path: k, dir: n.dir, size: n.size, modifiedAt: 1700000000000, hidden: false })),
    })),
    mkdir: vi.fn(async (p: string) => {
      if (fs.has(p)) throw hostError("conflict", { reason: "exists" });
      log("mkdir", p);
      put(p, null);
      return { name: p.split("/").pop(), path: p, dir: true };
    }),
    writeText: vi.fn(async (p: string) => (log("writeText", p), put(p, 0), { basis: "b" })),
    copy: vi.fn(async (a: string, b: string, o?: { conflict?: string }) => place("copy", a, b, o?.conflict ?? "fail")),
    move: vi.fn(async (a: string, b: string, o?: { conflict?: string }) => place("move", a, b, o?.conflict ?? "fail")),
    trash: vi.fn(async (p: string) => {
      log("trash", p);
      trash.push(p);
      for (const k of under(p)) fs.delete(k);
      return { path: `/Users/me/.Trash/${p.split("/").pop()}` };
    }),
    find: vi.fn(async (dir: string, query: string) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return { entries: [...fs.entries()].filter(([k]) => k.startsWith(`${dir}/`) && words.every((w) => k.split("/").pop()!.toLowerCase().includes(w))).map(([k, n]) => ({ name: k.split("/").pop(), path: k, dir: n.dir, size: n.size, modifiedAt: 1700000000000, hidden: false })), next: null };
    }),
    remove: vi.fn(async (p: string) => {
      log("remove", p);
      for (const k of under(p)) fs.delete(k);
    }),
    open: vi.fn(async (p: string) => void log("open", p)),
    reveal: vi.fn(async (p: string) => void log("reveal", p)),
    addRoot: vi.fn(async () => {
      // the shell's chooser: the grant arrives later
      grants.push({ path: "/Users/me/new", name: "new" });
      put("/Users/me/new", null);
      return null;
    }),
    replaceRoot: vi.fn(async (p: string) => {
      if (!grants.some((g) => g.path === p)) throw hostError("notFound", { reason: "grant" });
      return null;
    }),
    removeRoot: vi.fn(async (p: string) => {
      const i = grants.findIndex((g) => g.path === p);
      if (i < 0) throw hostError("notFound", { reason: "grant" });
      grants.splice(i, 1);
      return { folders: grants.map((g) => g.path) };
    }),
  };
  return { fs, trash, calls, files, grants };
}

/** Resources with the semantics of `resources.upsertByKey` (round 16 §2.2) for the kind(s) a test touches. */
function fakeResources() {
  const rows = new Map<string, { id: string; kind: string; name: string; externalKey: string; missing: boolean; body: Record<string, string>; parent?: string }>();
  let n = 0;
  return {
    rows,
    list: vi.fn(async ({ kind }: { kind: string }) => [...rows.values()].filter((r) => r.kind === kind)),
    upsertByKey: vi.fn(async (kind: string, items: any[], opts?: { othersMissing?: boolean }) => {
      const out = { created: 0, updated: 0, unchanged: 0, restored: 0, missing: 0, ids: {} as Record<string, string> };
      const seen = new Set<string>();
      for (const it of items) {
        seen.add(it.key);
        const id = `${kind}:${it.key}`;
        const row = rows.get(id);
        if (!row) {
          rows.set(id, { id: `r${++n}`, kind, name: it.name ?? it.key.split("/").pop(), externalKey: it.key, missing: false, body: { ...(it.body || {}) }, parent: it.parent });
          out.created++;
        } else if (row.missing) {
          row.missing = false;
          Object.assign(row.body, it.body || {});
          out.restored++;
        } else if (it.body && JSON.stringify({ ...row.body, ...it.body }) !== JSON.stringify(row.body)) {
          Object.assign(row.body, it.body);
          out.updated++;
        } else out.unchanged++;
        out.ids[it.key] = rows.get(id)!.id;
      }
      if (opts?.othersMissing) for (const [, r] of rows) if (r.kind === kind && !seen.has(r.externalKey) && !r.missing) ((r.missing = true), out.missing++);
      return out;
    }),
  };
}

function actionCtx(host: Record<string, unknown>, key: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { target: `node:org.onedesk.files:files/${encodeURIComponent(key)}`, node: { tree: "org.onedesk.files:files", key }, locale: "en-US", host, t: tt, params, progress: vi.fn(), ...extra };
}
const SUB = `${ROOT}/sub`;
const run = (name: string, host: any, key: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => registry(plugin).actions[name](actionCtx(host, key, params, extra), {});

describe("files plugin: paths", () => {
  it("normalizes, and rejects relative or escaping paths", () => {
    expect(normalize("/a/b/../c//d/.")).toBe("/a/c/d");
    expect(normalize("a/b")).toBeNull();
    expect(normalize("/../etc")).toBeNull();
    expect(normalize("/a\0b")).toBeNull();
  });
  it("a path belongs to a root by whole segments", () => {
    expect(rootOf(`${ROOT}/x`, roots)).toBe(ROOT);
    expect(rootOf("/Users/me/docs2/x", roots)).toBeNull();
    expect(rootOf(`${ROOT}/../secret`, roots)).toBeNull();
    expect(rootOf(ROOT, roots)).toBe(ROOT);
  });
  it("names", () => {
    expect([validName("a.txt"), validName("a/b"), validName(".."), validName("."), validName(""), validName(" x"), validName("é 周")]).toEqual([true, false, false, false, false, false, true]);
    expect(joinPath("/", "a")).toBe("/a");
    expect(joinPath("/a/", "b")).toBe("/a/b");
  });
});

describe("files plugin: nothing outside the authorized folders", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["mkdir", { newName: "x" }],
    ["touch", { newName: "x" }],
    ["rename", { newName: "x" }],
    ["trash", {}],
    ["delete", {}],
    ["open", {}],
    ["reveal", {}],
    ["search", { query: "a" }],
    ["import", {}],
    ["grantRemove", {}],
    ["grantReplace", {}],
  ];
  it.each(cases)("%s on a path outside, a sibling with the same prefix, or one that climbs out is refused before the host is called", async (name, params) => {
    for (const key of ["/etc/passwd", "/Users/me/docs2/a.txt", `${ROOT}/../secret.txt`, "relative.txt"]) {
      const d = fakeDisk({ "/Users/me/docs2": null, "/Users/me/docs2/a.txt": 1, "/etc": null, "/etc/passwd": 1 });
      await expect(run(name, { files: d.files, resources: fakeResources() }, key, params), `${name} ${key}`).rejects.toThrow(EN["error.outside"]);
      expect(d.calls).toEqual([]);
      for (const m of ["mkdir", "writeText", "copy", "move", "trash", "remove", "open", "reveal", "removeRoot", "replaceRoot", "find", "list"] as const) expect(d.files[m], `${name} ${key} ${m}`).not.toHaveBeenCalled();
    }
  });

  it.each(["move", "copy"])("%s: a destination outside is refused, the source outside too", async (op) => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1, "/etc": null });
    await expect(run(op, { files: d.files }, `${ROOT}/a.txt`, { destination: "/etc" })).rejects.toThrow(EN["error.outside"]);
    await expect(run(op, { files: d.files }, `${ROOT}/a.txt`, { destination: `${ROOT}/../etc` })).rejects.toThrow(EN["error.outside"]);
    await expect(run(op, { files: d.files }, "/etc/passwd", { destination: ROOT })).rejects.toThrow(EN["error.outside"]);
    expect(d.calls).toEqual([]);
  });

  it("a new name cannot carry a path", async () => {
    const d = fakeDisk({});
    for (const name of ["../x", "a/b", "..", ""]) {
      await expect(run("mkdir", { files: d.files }, ROOT, { newName: name })).rejects.toThrow(EN["error.badName"]);
      await expect(run("rename", { files: d.files }, ROOT, { newName: name })).rejects.toThrow(EN["error.badName"]);
    }
    expect(d.calls).toEqual([]);
  });
});

describe("files plugin: operations", () => {
  it("new folder and new file go into the folder (or next to a file); an existing name is refused", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 3 });
    const r = await run("mkdir", { files: d.files }, ROOT, { newName: "sub" });
    expect(checkActionResult(r)).toEqual([]);
    expect(d.fs.get(SUB)?.dir).toBe(true);
    await run("touch", { files: d.files }, `${ROOT}/a.txt`, { newName: "b.md" }); // next to a file
    expect(d.fs.has(`${ROOT}/b.md`)).toBe(true);
    await expect(run("mkdir", { files: d.files }, ROOT, { newName: "sub" })).rejects.toThrow("already exists");
    await expect(run("touch", { files: d.files }, ROOT, { newName: "b.md" })).rejects.toThrow("already exists");
  });

  it("rename and move keep the content; the result goes to the result area", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 3, [SUB]: null });
    const r = await run("rename", { files: d.files }, `${ROOT}/a.txt`, { newName: "z.txt" });
    expect(checkActionResult(r)).toEqual([]);
    expect(r.output.text).toContain(`${ROOT}/z.txt`);
    await run("move", { files: d.files }, `${ROOT}/z.txt`, { destination: SUB });
    expect([...d.fs.keys()].sort()).toEqual([ROOT, SUB, `${SUB}/z.txt`].sort());
  });

  it("a folder cannot go into itself, a file cannot replace itself", async () => {
    const d = fakeDisk({ [SUB]: null, [`${ROOT}/a.txt`]: 1 });
    await expect(run("move", { files: d.files }, ROOT, { destination: SUB })).rejects.toThrow(EN["error.intoItself"]);
    await expect(run("copy", { files: d.files }, `${ROOT}/a.txt`, { destination: ROOT, conflict: "overwrite" })).rejects.toThrow(EN["error.sameFile"]);
    expect(d.calls).toEqual([]);
  });

  it("the destination must be a folder", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1, [`${ROOT}/b.txt`]: 2 });
    await expect(run("copy", { files: d.files }, `${ROOT}/a.txt`, { destination: `${ROOT}/b.txt` })).rejects.toThrow(EN["error.destNotFolder"]);
  });
});

describe("files plugin: a name that is taken (copy and move)", () => {
  const setup = () => fakeDisk({ [`${ROOT}/a.txt`]: 1, [SUB]: null, [`${SUB}/a.txt`]: 99, [`${SUB}/a copy.txt`]: 5 });
  const cmd = (name: string, d: ReturnType<typeof setup>, args: Record<string, unknown>, nodeKey = `${ROOT}/a.txt`) =>
    registry(plugin).commands[name]({ locale: "en-US", host: { files: d.files }, t: tt }, { nodeKey, args });
  const go = (op: string, d: ReturnType<typeof setup>, conflict?: string) => cmd(op, d, { destination: SUB, ...(conflict ? { conflict, confirmed: true } : {}) });

  it("the first call uses conflict fail, and the clash becomes a confirm with the three choices; nothing is touched", async () => {
    const d = setup();
    const effects = await go("copy", d);
    expect(d.files.copy).toHaveBeenCalledWith(`${ROOT}/a.txt`, `${SUB}/a.txt`, { conflict: "fail" });
    expect(effects).toEqual([
      {
        type: "confirm",
        message: expect.stringContaining("a.txt"),
        command: "org.onedesk.files:copy",
        danger: false,
        choices: [{ id: "overwrite", danger: true }, { id: "skip" }, { id: "keepBoth" }],
        choiceArg: "conflict",
      },
    ]);
    expect(d.calls).toEqual([]);
    expect((await go("move", d))[0]).toMatchObject({ type: "confirm", command: "org.onedesk.files:move" });
  });

  it("the page action has no choice: a clash is an error in the result area, the host is asked to fail", async () => {
    const d = setup();
    await expect(run("copy", { files: d.files }, `${ROOT}/a.txt`, { destination: SUB })).rejects.toThrow("already exists");
    expect(d.calls).toEqual([]);
  });

  it("overwrite: the rerun tells the host to overwrite", async () => {
    const d = setup();
    const [toast] = await go("copy", d, "overwrite");
    expect(d.files.copy).toHaveBeenLastCalledWith(`${ROOT}/a.txt`, `${SUB}/a.txt`, { conflict: "overwrite" });
    expect(d.fs.get(`${SUB}/a.txt`)?.size).toBe(1);
    expect(toast).toMatchObject({ type: "toast", tone: "success" });
    expect(toast.message).toContain("Copied");
  });

  it("skip: nothing is written, the source stays", async () => {
    const d = setup();
    const [toast] = await go("move", d, "skip");
    expect(d.calls).toEqual([]);
    expect(d.fs.has(`${ROOT}/a.txt`)).toBe(true);
    expect(d.fs.get(`${SUB}/a.txt`)?.size).toBe(99);
    expect(toast.message).toContain("Skipped");
  });

  it("keep both: the host names the new one, the old one is untouched, the toast names the new path", async () => {
    const d = setup();
    const [toast] = await go("copy", d, "keepBoth");
    expect(d.files.copy).toHaveBeenLastCalledWith(`${ROOT}/a.txt`, `${SUB}/a.txt`, { conflict: "keepBoth" });
    expect(d.fs.get(`${SUB}/a.txt`)?.size).toBe(99);
    expect(d.fs.get(`${SUB}/a 2.txt`)?.size).toBe(1);
    expect(toast.message).toContain(`${SUB}/a 2.txt`);
    const m = setup();
    await go("move", m, "keepBoth");
    expect(m.fs.has(`${ROOT}/a.txt`)).toBe(false);
    expect(m.fs.has(`${SUB}/a 2.txt`)).toBe(true);
  });

  it("no clash: it just works on the first call, with conflict fail", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1, [SUB]: null });
    const [toast] = await go("copy", d);
    expect(toast).toMatchObject({ type: "toast" });
    expect(d.files.copy).toHaveBeenCalledWith(`${ROOT}/a.txt`, `${SUB}/a.txt`, { conflict: "fail" });
  });

  it("host codes become words: into itself, authorized folder itself, Trash unavailable", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1, [SUB]: null });
    d.files.copy.mockRejectedValueOnce(hostError("invalid", { reason: "intoItself" }));
    await expect(run("copy", { files: d.files }, `${ROOT}/a.txt`, { destination: SUB })).rejects.toThrow(EN["error.intoItself"]);
    d.files.move.mockRejectedValueOnce(hostError("invalid", { reason: "isRoot" }));
    await expect(run("move", { files: d.files }, `${ROOT}/a.txt`, { destination: SUB })).rejects.toThrow(EN["error.isRoot"]);
    d.files.trash.mockRejectedValueOnce(hostError("invalid", { reason: "trashUnavailable" }));
    await expect(run("trash", { files: d.files }, `${ROOT}/a.txt`)).rejects.toThrow(EN["error.trashUnavailable"]);
    d.files.removeRoot.mockRejectedValueOnce(hostError("notFound", { reason: "grant" }));
    await expect(run("grantRemove", { files: d.files }, ROOT)).rejects.toThrow(EN["error.notGranted"]);
  });

  it("rename asks too (and keeps both with the host's naming); a path outside is a danger toast without touching the host", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1, [`${ROOT}/b.txt`]: 2 });
    expect((await cmd("rename", d, { newName: "b.txt" }))[0]).toMatchObject({ type: "confirm", command: "org.onedesk.files:rename", choiceArg: "conflict" });
    await cmd("rename", d, { newName: "b.txt", conflict: "keepBoth", confirmed: true });
    expect([...d.fs.keys()].sort()).toEqual([ROOT, `${ROOT}/b.txt`, `${ROOT}/b 2.txt`].sort());
    const out = await cmd("move", d, { destination: ROOT }, "/etc/passwd");
    expect(out[0]).toMatchObject({ type: "toast", tone: "danger" });
  });

  it("the page has no conflict dropdown any more", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1 });
    const { pages } = registry(plugin);
    const out = await pages.text.render(ctxOf({ roots: d.files.roots, stat: d.files.stat, readText: async () => ({ text: "", basis: "b" }) }, `${ROOT}/a.txt`));
    expect(out.view.find((n: any) => n.id === "ops").fields.map((f: any) => f.name)).not.toContain("conflict");
  });
});

describe("files plugin: delete", () => {
  it("the default goes to the Trash and is not removed for good", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1 });
    const r = await run("trash", { files: d.files }, `${ROOT}/a.txt`);
    expect(d.trash).toEqual([`${ROOT}/a.txt`]);
    expect(d.files.remove).not.toHaveBeenCalled();
    expect(r.output.text).toContain("Trash");
  });

  it("permanent delete is its own action, and the manifest makes the shell ask first", async () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    const del = m.contributes.actions.find((a: any) => a.id === "delete");
    const trash = m.contributes.actions.find((a: any) => a.id === "trash");
    expect(del.confirm).toBe("confirm.delete");
    expect(trash.confirm).toBeNull();
    for (const page of m.contributes.pages.filter((p: any) => p.actions.some((a: any) => a.action === "delete"))) expect(page.actions.find((a: any) => a.action === "delete").danger).toBe(true);
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1 });
    await run("delete", { files: d.files }, `${ROOT}/a.txt`);
    expect(d.files.remove).toHaveBeenCalledWith(`${ROOT}/a.txt`);
    expect(d.files.trash).not.toHaveBeenCalled();
    expect(d.fs.has(`${ROOT}/a.txt`)).toBe(false);
  });

  it("permanent delete as a command: first an irreversible confirm, only the rerun deletes", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1 });
    const cmd = (args: Record<string, unknown>) => registry(plugin).commands.delete({ locale: "en-US", host: { files: d.files }, t: tt }, { nodeKey: `${ROOT}/a.txt`, args });
    const [ask] = await cmd({});
    expect(ask).toMatchObject({ type: "confirm", command: "org.onedesk.files:delete", danger: true, irreversible: true });
    expect(d.files.remove).not.toHaveBeenCalled();
    const [done] = await cmd({ confirmed: true });
    expect(d.files.remove).toHaveBeenCalledWith(`${ROOT}/a.txt`);
    expect(done).toMatchObject({ type: "toast", tone: "success" });
  });

  it("an authorized folder itself is not deleted (its authorization is removed instead)", async () => {
    const d = fakeDisk({});
    await expect(run("delete", { files: d.files }, ROOT)).rejects.toThrow(EN["error.isRoot"]);
    expect(d.files.remove).not.toHaveBeenCalled();
  });

  it("open and Finder work on the path (also from a disk-file resource)", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1 });
    await run("open", { files: d.files }, `${ROOT}/a.txt`);
    const ctx = { target: "resource:r1", locale: "en-US", host: { files: d.files }, t: tt, params: {}, resource: { id: "r1", body: { path: `${ROOT}/a.txt` } } };
    await registry(plugin).actions.reveal(ctx, {});
    expect(d.calls).toEqual([`open ${ROOT}/a.txt`, `reveal ${ROOT}/a.txt`]);
  });
});

describe("files plugin: search by name", () => {
  const disk = () => fakeDisk({ [`${ROOT}/Report 2024.md`]: 10, [`${ROOT}/notes.txt`]: 1, [SUB]: null, [`${SUB}/report-final.pdf`]: 5, [`${SUB}/old report 2023.md`]: 7 });
  it("every word has to be in the name, case does not matter, subfolders included", async () => {
    const d = disk();
    const r = await run("search", { files: d.files }, ROOT, { query: "REPORT md" });
    expect(checkActionResult(r)).toEqual([]);
    expect(r.output.rows.map((x: string[]) => x[0]).sort()).toEqual(["Report 2024.md", "old report 2023.md"]);
    expect(r.summary).toEqual({ rows: 2, message: "2 found" });
    expect(r.output.rows[0]).toHaveLength(r.output.columns.length);
  });
  it("an empty query is refused; from a file it searches its folder", async () => {
    const d = disk();
    await expect(run("search", { files: d.files }, ROOT, { query: "  " })).rejects.toThrow(EN["error.noQuery"]);
    const r = await run("search", { files: d.files }, `${SUB}/report-final.pdf`, { query: "report" });
    expect(r.output.rows.map((x: string[]) => x[0]).sort()).toEqual(["old report 2023.md", "report-final.pdf"]);
  });
});

describe("files plugin: authorized folders", () => {
  it("add, look, rename, remove; removing the authorization touches no resource and no file", async () => {
    const d = fakeDisk({ [`${ROOT}/a.txt`]: 1 });
    const res = fakeResources();
    const host = { files: d.files, resources: res };
    const { trees } = registry(plugin);
    expect((await trees.folders.children(ctxOf(d.files, ""), null, 0)).nodes.map((n: any) => n.key)).toEqual(["~add", ROOT]);

    const added = await run("grantAdd", host, "~add");
    expect(d.files.addRoot).toHaveBeenCalledTimes(1); // the shell's chooser
    expect(added.output.text).toBe(EN["grant.choose"]);
    const nodes = (await trees.folders.children(ctxOf(d.files, ""), null, 0)).nodes;
    expect(nodes.map((n: any) => (typeof n.label === "string" ? n.label : n.label["en-US"]))).toEqual(["folders.add", "docs", "new"]);
    expect(onlyKeys(nodes[1], TREE_NODE_KEYS)).toEqual([]);

    await run("grantReplace", host, "/Users/me/new");
    expect(d.files.replaceRoot).toHaveBeenCalledWith("/Users/me/new");

    await run("import", host, ROOT, {});
    const before = [...res.rows.values()].map((r) => ({ ...r, body: { ...r.body } }));
    const fsBefore = [...d.fs.keys()];
    const removed = await run("grantRemove", host, "/Users/me/new");
    expect(removed.output.text).toContain("not touched");
    expect(d.grants.map((g) => g.path)).toEqual([ROOT]);
    expect([...res.rows.values()]).toEqual(before);
    expect([...d.fs.keys()]).toEqual(fsBefore);
    expect(d.calls.filter((c) => /^(trash|remove|move)/.test(c))).toEqual([]);
  });

  it("the grant page shows the form for a folder and a hint for the add node", async () => {
    const d = fakeDisk({});
    const { pages } = registry(plugin);
    const ctx = (key: string) => ({ ...ctxOf(d.files, key), node: { tree: "org.onedesk.files:folders", key } });
    const add = await pages.folders.render(ctx("~add"));
    const one = await pages.folders.render(ctx(ROOT));
    for (const out of [add, one]) {
      expect(checkView(out.view)).toEqual([]);
      expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    }
    expect(one.title).toBe("docs");
  });
});

describe("files plugin: import", () => {
  const tree = () => ({
    [`${ROOT}/a.txt`]: 1,
    [`${ROOT}/b.md`]: 2,
    [SUB]: null,
    [`${SUB}/c.txt`]: 3,
    [`${SUB}/deep`]: null,
    [`${SUB}/deep/d.txt`]: 4,
    "/Users/me/other": null,
    "/Users/me/other/x.txt": 9,
  });
  const roots2 = [{ path: ROOT, name: "docs" }, { path: "/Users/me/other", name: "other" }];
  const imp = (d: ReturnType<typeof fakeDisk>, res: ReturnType<typeof fakeResources>, key: string, recursive = false) =>
    run("import", { files: d.files, resources: res }, key, { recursive });
  const files = (res: ReturnType<typeof fakeResources>) => [...res.rows.values()].filter((r) => r.kind === "disk-file");

  it("registers files with name, full path, size, modified time, extension; groups by folder name", async () => {
    const d = fakeDisk(tree(), roots2);
    const res = fakeResources();
    const r = await imp(d, res, ROOT);
    expect(checkActionResult(r)).toEqual([]);
    const a = files(res).find((x) => x.name === "a.txt")!;
    expect(a.body).toEqual({ path: `${ROOT}/a.txt`, size: "1", modifiedAt: "2023-11-14T22:13:20.000Z", ext: "txt", folder: ROOT });
    expect(a.externalKey).toBe(`${ROOT}/a.txt`);
    const group = [...res.rows.values()].find((x) => x.kind === "disk-folder" && x.externalKey === ROOT)!;
    expect(group.name).toBe("docs");
    expect(a.parent).toBe(group.id);
    expect(files(res).map((x) => x.name).sort()).toEqual(["a.txt", "b.md"]); // subfolders only when asked
  });

  it("with subfolders: nested groups named after their folders", async () => {
    const d = fakeDisk(tree(), roots2);
    const res = fakeResources();
    await imp(d, res, ROOT, true);
    expect(files(res).map((x) => x.name).sort()).toEqual(["a.txt", "b.md", "c.txt", "d.txt"]);
    const byKey = (k: string) => [...res.rows.values()].find((x) => x.kind === "disk-folder" && x.externalKey === k)!;
    expect(byKey(`${SUB}/deep`).parent).toBe(byKey(SUB).id);
    expect(byKey(SUB).parent).toBe(byKey(ROOT).id);
    expect(files(res).find((x) => x.name === "d.txt")!.parent).toBe(byKey(`${SUB}/deep`).id);
  });

  it("importing again only updates; a changed file is updated, the rest unchanged", async () => {
    const d = fakeDisk(tree(), roots2);
    const res = fakeResources();
    await imp(d, res, ROOT);
    const n = res.rows.size;
    d.fs.get(`${ROOT}/a.txt`)!.size = 50;
    const r = await imp(d, res, ROOT);
    expect(res.rows.size).toBe(n);
    expect(r.output.text).toContain("0 new, 1 updated");
    expect(files(res).find((x) => x.name === "a.txt")!.body.size).toBe("50");
  });

  it("a file that is gone becomes missing (not deleted); it comes back when it reappears", async () => {
    const d = fakeDisk(tree(), roots2);
    const res = fakeResources();
    await imp(d, res, ROOT);
    d.fs.delete(`${ROOT}/b.md`);
    const r = await imp(d, res, ROOT);
    expect(r.output.text).toContain("1 missing");
    const b = files(res).find((x) => x.name === "b.md")!;
    expect(b.missing).toBe(true);
    expect(files(res).find((x) => x.name === "a.txt")!.missing).toBe(false);
    d.fs.set(`${ROOT}/b.md`, { dir: false, size: 2 });
    const back = await imp(d, res, ROOT);
    expect(back.output.text).toContain("1 restored");
    expect(b.missing).toBe(false);
  });

  it("importing one folder never marks the files of another folder, nor deeper ones when subfolders are off", async () => {
    const d = fakeDisk(tree(), roots2);
    const res = fakeResources();
    await imp(d, res, ROOT, true);
    await imp(d, res, "/Users/me/other");
    expect(files(res).every((x) => !x.missing)).toBe(true);
    await imp(d, res, ROOT, false); // not recursive now: c.txt and d.txt stay as they are
    expect(files(res).every((x) => !x.missing)).toBe(true);
    d.fs.delete(`${SUB}/c.txt`);
    await imp(d, res, ROOT, true);
    expect(files(res).filter((x) => x.missing).map((x) => x.name)).toEqual(["c.txt"]);
  });

  it("from a file it imports its folder; a folder outside is refused", async () => {
    const d = fakeDisk(tree(), roots2);
    const res = fakeResources();
    await imp(d, res, `${ROOT}/a.txt`);
    expect(files(res).map((x) => x.name).sort()).toEqual(["a.txt", "b.md"]);
    await expect(imp(d, res, "/Users/me")).rejects.toThrow(EN["error.outside"]);
  });

  it("the record never holds file content", () => {
    const item = diskFileItem({ name: "a.txt", path: `${ROOT}/a.txt`, size: 1, modifiedAt: 0 }, "g1");
    expect(Object.keys(item.body).sort()).toEqual(["ext", "folder", "modifiedAt", "path", "size"]);
  });

  it("importFolder is usable on its own (the exported helper)", async () => {
    const d = fakeDisk(tree(), roots2);
    const res = fakeResources();
    const r = await importFolder({ host: { files: d.files, resources: res }, t: tt, locale: "en-US" }, ROOT, false);
    expect(r).toMatchObject({ created: 2, files: 2, missing: 0 });
  });
});

describe("files plugin: package", () => {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("registers every action and page the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.actions).sort()).toEqual(manifest.contributes.actions.map((a: any) => a.id).sort());
    expect(Object.keys(r.pages).sort()).toEqual(manifest.contributes.pages.map((p: any) => p.id).sort());
    expect(Object.keys(r.trees).sort()).toEqual(manifest.contributes.trees.map((x: any) => x.id).sort());
  });
  it("every key the code uses exists in en, zh and ja", () => {
    const src = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const keys = [...src.matchAll(/(?:tr2?\(ctx, |ctx\.t\(|fail\(ctx, |done\(ctx, )"([a-zA-Z.]+)"/g)].map((m) => m[1]!);
        for (const k of keys) for (const L of [EN, ZH, JA]) expect(L[k], k).toBeTypeOf("string");
    const mkeys = [...JSON.stringify(manifest).matchAll(/"((?:plugin|kind|action|tab|tree|confirm)\.[A-Za-z.]+)"/g)].map((m) => m[1]!);
    for (const k of mkeys.filter((k) => k !== "plugin.grantFolder")) for (const L of [EN, ZH, JA]) expect(L[k], k).toBeTypeOf("string");
  });
});
