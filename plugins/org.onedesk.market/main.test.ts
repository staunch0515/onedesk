import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { MAX_DESCRIPTION, MAX_NAME, MAX_PACKAGES, MAX_PROBES, PACKAGE_FILE, PICK, clean, compareVersions, statusOf } from "./main.js";
import { RENDER_KEYS, TREE_NODE_KEYS, TREE_PAGE_KEYS, checkView, hostError, onlyKeys, registry } from "../_testing/view-check";

const ROOT = "/Users/me/market";
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (l: string) => JSON.parse(readFileSync(new URL(`./locales/${l}.json`, import.meta.url), "utf8")) as Record<string, string>;
// A real-looking translator: the page text comes from the plugin's own locale files.
const tt = (key: string) => ({ "en-US": locale("en-US")[key] ?? key, "zh-CN": locale("zh-CN")[key] ?? key });

/** Fake file system: `files` maps absolute path → text; directories are implied by the paths. */
function fakeFiles(files: Record<string, string>, roots = [{ path: ROOT, name: "market" }], broken: string[] = []): any {
  const children = (dir: string) => {
    const names = new Set<string>();
    for (const p of Object.keys(files)) if (p.startsWith(dir + "/")) names.add(p.slice(dir.length + 1).split("/")[0]!);
    return [...names];
  };
  return {
    roots: vi.fn(async () => roots),
    list: vi.fn(async (dir: string, _opts?: unknown) => ({
      entries: children(dir).map((n) => ({ name: n, path: `${dir}/${n}`, dir: !files[`${dir}/${n}`], size: 1, modifiedAt: 0, hidden: false })),
    })),
    readText: vi.fn(async (p: string) => {
      if (broken.includes(p)) throw hostError("denied");
      if (!(p in files)) throw hostError("notFound");
      return { text: files[p], basis: "b" };
    }),
  };
}

const pkgManifest = (id: string, version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, version, apiVersion: "2", name: "plugin.name", description: "plugin.description", icon: "box", main: "main.js", contributes: { locales: { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" } }, ...extra });
const pkgLocales = (dir: string, name: string, desc: string, zh?: [string, string]) => ({
  [`${dir}/locales/en-US.json`]: JSON.stringify({ "plugin.name": name, "plugin.description": desc }),
  [`${dir}/locales/zh-CN.json`]: JSON.stringify({ "plugin.name": zh?.[0] ?? name, "plugin.description": zh?.[1] ?? desc }),
});
const pkgFiles = (dir: string, id: string, version: string, name: string, desc: string, zh?: [string, string]) => ({
  [`${dir}/manifest.json`]: pkgManifest(id, version),
  ...pkgLocales(dir, name, desc, zh),
});

/** In-memory `ctx.host.storage`, attached once to the fake host so that renders of one test share it. */
const fakeStorage = () => {
  const m = new Map<string, string>();
  return { get: vi.fn(async (k: string) => m.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void m.set(k, v)) };
};
const ctxOf = (host: any, extra: Record<string, unknown> = {}) => {
  host.storage ??= fakeStorage();
  return { target: "node:org.onedesk.market:market/local", node: { tree: "org.onedesk.market:market", key: "local" }, locale: "en-US", host, t: tt, ...extra };
};
const tableOf = (out: any) => out.view.find((n: any) => n.type === "table");
const rowsOf = (out: any) => tableOf(out).rows as string[][];
// Each row's key is its folder; clicking a row picks it (D474).
const keysOf = (out: any) => tableOf(out).rowKeys as string[];

describe("market: manifest", () => {
  it("declares files and plugin-install, one provided tree and the page it opens", () => {
    expect(manifest.requires).toEqual({ files: true, plugins: { install: true } });
    expect(manifest.contributes.trees).toHaveLength(1);
    expect(manifest.contributes.trees[0]).toMatchObject({ id: "market", source: "provided", page: "browse", toolbar: ["plugin.grantFolder"] });
    expect(manifest.contributes.pages.map((p: any) => p.id)).toEqual(["browse"]);
    expect(manifest.contributes.pages[0].actions.map((a: any) => [a.id, a.role])).toEqual([["install", "event"], ["refresh", "event"]]);
  });
  it("registers exactly the tree and page the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.trees)).toEqual(["market"]);
    expect(Object.keys(r.pages)).toEqual(["browse"]);
  });
  it("has the same locale keys in both languages and every referenced key is defined", () => {
    expect(Object.keys(locale("en-US")).sort()).toEqual(Object.keys(locale("zh-CN")).sort());
    const src = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const used = [...src.matchAll(/(?:tr\(ctx, |ctx\.t\()"([a-zA-Z.]+)"/g)].map((m) => m[1]!);
    const dynamic = ["reason.unreadable", "reason.invalidJson", "reason.missingFields", "reason.incomplete", "reason.mismatch"];
    for (const k of [...used, ...dynamic, "tree.market", "action.install", "action.refresh"]) expect(locale("en-US")[k], k).toBeTruthy();
  });
});

describe("market: tree", () => {
  it("has one entry that opens the page", async () => {
    const { trees } = registry(plugin);
    const out = await trees.market.children(ctxOf({}), null, 0);
    expect(onlyKeys(out, TREE_PAGE_KEYS)).toEqual([]);
    expect(out.nodes).toHaveLength(1);
    expect(onlyKeys(out.nodes[0], TREE_NODE_KEYS)).toEqual([]);
    expect(out.nodes[0].target).toBe("node:org.onedesk.market:market/local");
    expect((await trees.market.children(ctxOf({}), "local", 0)).nodes).toEqual([]);
  });
});

describe("market: no authorized folder", () => {
  it("explains and does not scan or list", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({}, []);
    const plugins = { list: vi.fn(async () => []), requestInstall: vi.fn() };
    const out = await pages.browse.render(ctxOf({ files, plugins }));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["empty", "hint"]);
    expect(out.view[0].text).toBe("No folder authorized yet.");
    expect(files.list).not.toHaveBeenCalled();
    expect(plugins.list).not.toHaveBeenCalled();
  });
  it("shows the Chinese text for zh-CN", async () => {
    const { pages } = registry(plugin);
    const out = await pages.browse.render(ctxOf({ files: fakeFiles({}, []), plugins: { list: async () => [] } }, { locale: "zh-CN" }));
    expect(out.view[0].text).toBe("还没有授权文件夹。");
  });
});

describe("market: scanning", () => {
  it("reads both layouts: <dir>/manifest.json and <dir>/<version>/manifest.json", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      ...pkgFiles(`${ROOT}/flat`, "com.example.flat", "1.0.0", "Flat", "Flat pack"),
      ...pkgFiles(`${ROOT}/com.example.deep/0.2.0`, "com.example.deep", "0.2.0", "Deep", "Deep pack"),
      ...pkgFiles(`${ROOT}/com.example.deep/0.1.0`, "com.example.deep", "0.1.0", "Deep", "Deep pack"),
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(checkView(out.view)).toEqual([]);
    expect(rowsOf(out)).toEqual([
      ["Deep", "0.1.0", "Deep pack", "Not installed"],
      ["Deep", "0.2.0", "Deep pack", "Not installed"],
      ["Flat", "1.0.0", "Flat pack", "Not installed"],
    ]);
  });

  it("uses the package's own language file, falling back to English", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/com.example.a/1.0.0`, "com.example.a", "1.0.0", "Alpha", "First", ["阿尔法", "第一个"]));
    const host = { files, plugins: { list: async () => [] } };
    // the cache is per language, so the same host serves both
    expect(rowsOf(await pages.browse.render(ctxOf(host, { locale: "zh-CN" })))[0]!.slice(0, 3)).toEqual(["阿尔法", "1.0.0", "第一个"]);
    expect(rowsOf(await pages.browse.render(ctxOf(host, { locale: "fr-FR" })))[0]!.slice(0, 3)).toEqual(["Alpha", "1.0.0", "First"]);
  });

  it("shows the package id (never the raw key) when the language file is missing or a path escapes the package", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      [`${ROOT}/com.example.a/1.0.0/manifest.json`]: pkgManifest("com.example.a", "1.0.0"),
      [`${ROOT}/com.example.b/1.0.0/manifest.json`]: pkgManifest("com.example.b", "1.0.0", { contributes: { locales: { "en-US": "../../x.json" } } }),
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(rowsOf(out).map((r) => [r[0], r[2]])).toEqual([["com.example.a", ""], ["com.example.b", ""]]);
    expect(JSON.stringify(out.view)).not.toContain("plugin.name");
    expect(files.readText).not.toHaveBeenCalledWith(`${ROOT}/com.example.b/1.0.0/../../x.json`);
  });

  it("lists packages whose manifest cannot be read as unavailable with the reason, and keeps going", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(
      {
        ...pkgFiles(`${ROOT}/good`, "com.example.good", "1.0.0", "Good", "ok"),
        [`${ROOT}/bad-json/manifest.json`]: "{ nope",
        [`${ROOT}/no-id/manifest.json`]: JSON.stringify({ version: "1.0.0" }),
        [`${ROOT}/locked/manifest.json`]: "{}",
      },
      undefined,
      [`${ROOT}/locked/manifest.json`],
    );
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    const rows = rowsOf(out);
    expect(rows.find((r) => r[0] === "Good")?.[3]).toBe("Not installed");
    expect(rows.find((r) => r[0] === "bad-json")).toEqual(["bad-json", "", "The manifest is not valid JSON.", "Unavailable"]);
    expect(rows.find((r) => r[0] === "no-id")?.[2]).toBe("The manifest has no id or version.");
    expect(rows.find((r) => r[0] === "locked")?.[2]).toBe("The manifest cannot be read.");
    // every row is picked by its folder
    expect(tableOf(out).selectParam).toBe(PICK);
    expect(keysOf(out)).toHaveLength(rows.length);
    expect(keysOf(out)[rows.findIndex((r) => r[0] === "Good")]).toBe(`${ROOT}/good`);
  });

  it("marks packages with missing required fields or an id/version that differs from their folder as unavailable", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      ...pkgFiles(`${ROOT}/com.example.ok/1.0.0`, "com.example.ok", "1.0.0", "Ok", "fine"),
      ...pkgFiles(`${ROOT}/com.example.a/1.0.0`, "com.example.other", "1.0.0", "Wrong id", "x"),
      ...pkgFiles(`${ROOT}/com.example.b/1.0.0`, "com.example.b", "2.0.0", "Wrong version", "x"),
      [`${ROOT}/com.example.c/1.0.0/manifest.json`]: JSON.stringify({ id: "com.example.c", version: "1.0.0", apiVersion: "2" }),
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    const rows = rowsOf(out);
    expect(rows.find((r) => r[0] === "Ok")?.[3]).toBe("Not installed");
    expect(rows.find((r) => r[0] === "com.example.a/1.0.0")).toEqual(["com.example.a/1.0.0", "", "The manifest does not match its folder (id or version differs).", "Unavailable"]);
    expect(rows.find((r) => r[0] === "com.example.b/1.0.0")?.[3]).toBe("Unavailable");
    expect(rows.find((r) => r[0] === "com.example.c/1.0.0")).toEqual(["com.example.c/1.0.0", "", "The manifest is missing required fields.", "Unavailable"]);
    expect(keysOf(out)[rows.findIndex((r) => r[0] === "Ok")]).toBe(`${ROOT}/com.example.ok/1.0.0`);
  });

  it("ignores hidden and plain-file entries and folders without any manifest", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({ [`${ROOT}/README.txt`]: "x", [`${ROOT}/empty/notes.txt`]: "x" });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(out.view[0]).toMatchObject({ id: "none", tone: "muted" });
  });

  it("shows a muted line, not an error, when nothing is found", async () => {
    const { pages } = registry(plugin);
    const out = await pages.browse.render(ctxOf({ files: fakeFiles({}), plugins: { list: async () => [] } }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["none"]);
  });

  it("stops at 200 packages and says so", async () => {
    const { pages } = registry(plugin);
    const all: Record<string, string> = {};
    for (let i = 0; i < MAX_PACKAGES + 5; i++) Object.assign(all, pkgFiles(`${ROOT}/p${String(i).padStart(3, "0")}`, `com.example.p${i}`, "1.0.0", `P${i}`, "d"));
    const out = await pages.browse.render(ctxOf({ files: fakeFiles(all), plugins: { list: async () => [] } }));
    expect(rowsOf(out)).toHaveLength(200);
    expect(out.view.find((n: any) => n.id === "capped").text).toBe("Only the first 200 packages are shown.");
    expect(checkView(out.view)).toEqual([]);
  });

  it("a key the language file does not know shows the id and an empty description (the strict-manifest failure case)", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      [`${ROOT}/broken/manifest.json`]: JSON.stringify({ id: "com.example.broken-pack", version: "0.1.0", apiVersion: "2", icon: "box", main: "main.js", name: "plugin.name", description: "plugin.description", contributes: { locales: { "en-US": "locales/en-US.json" } } }),
      [`${ROOT}/broken/locales/en-US.json`]: JSON.stringify({ other: "x" }),
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(rowsOf(out)[0]).toEqual(["com.example.broken-pack", "0.1.0", "", "Not installed"]);
  });

  it("scans every authorized folder, and skips one that cannot be listed", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(
      { "/b/x": "", ...pkgFiles("/b/one", "com.example.one", "1.0.0", "One", "d") },
      [{ path: "/a", name: "a" }, { path: "/b", name: "b" }],
    );
    const list = files.list;
    files.list = vi.fn(async (dir: string, o: unknown) => {
      if (dir === "/a") throw hostError("notFound");
      return list(dir, o);
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(rowsOf(out).map((r) => r[0])).toEqual(["One"]);
  });

  it("follows paged listings", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({ ...pkgFiles(`${ROOT}/a`, "com.example.a", "1.0.0", "A", "d"), ...pkgFiles(`${ROOT}/b`, "com.example.b", "1.0.0", "B", "d") });
    const all = await files.list(ROOT);
    const [first, second] = all.entries;
    files.list = vi.fn(async (dir: string, o: any) => (dir !== ROOT ? { entries: [] } : o.offset === 0 ? { entries: [first], next: 1 } : { entries: [second] }));
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(rowsOf(out).map((r) => r[0])).toEqual(["A", "B"]);
  });
});

describe("market: status", () => {
  it("compares versions", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });
  it("not installed / installed / update", () => {
    const pkg = { id: "a", version: "0.2.0" };
    expect(statusOf(pkg, [])).toEqual({ kind: "notInstalled" });
    expect(statusOf(pkg, [{ id: "a", versions: ["0.2.0"], active: "0.2.0" }])).toEqual({ kind: "installed", version: "0.2.0" });
    expect(statusOf(pkg, [{ id: "a", versions: ["0.1.0"], active: "0.1.0" }])).toEqual({ kind: "update", version: "0.1.0" });
    // an older package than what is installed is not an update
    expect(statusOf(pkg, [{ id: "a", versions: ["0.3.0"], active: "0.3.0" }])).toEqual({ kind: "installed", version: "0.3.0" });
    expect(statusOf(pkg, [{ id: "b", versions: ["0.1.0"], active: "0.1.0" }])).toEqual({ kind: "notInstalled" });
  });
  it("is shown in the table and only installable packages are offered", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      ...pkgFiles(`${ROOT}/new`, "com.example.new", "1.0.0", "New", "d"),
      ...pkgFiles(`${ROOT}/same`, "com.example.same", "1.0.0", "Same", "d"),
      ...pkgFiles(`${ROOT}/upd`, "com.example.upd", "2.0.0", "Upd", "d"),
    });
    const plugins = { list: async () => [{ id: "com.example.same", name: "Same", versions: ["1.0.0"], active: "1.0.0" }, { id: "com.example.upd", name: "Upd", versions: ["1.0.0"], active: "1.0.0" }] };
    const out = await pages.browse.render(ctxOf({ files, plugins }));
    expect(rowsOf(out).map((r) => [r[0], r[3]])).toEqual([["New", "Not installed"], ["Same", "Installed 1.0.0"], ["Upd", "Update available (installed 1.0.0)"]]);
    expect(keysOf(out)).toEqual([`${ROOT}/new`, `${ROOT}/same`, `${ROOT}/upd`]);
  });
  it("Chinese status text", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/same`, "com.example.same", "1.0.0", "Same", "d"));
    const plugins = { list: async () => [{ id: "com.example.same", name: "Same", versions: ["1.0.0"], active: "1.0.0" }] };
    const out = await pages.browse.render(ctxOf({ files, plugins }, { locale: "zh-CN" }));
    expect(rowsOf(out)[0]![3]).toBe("已安装 1.0.0");
  });
  it("the package is picked in the table: view state of the page (no form, no bind, no returned values)", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/new`, "com.example.new", "1.0.0", "New", "d"));
    const host = { files, plugins: { list: async () => [] } };
    const out = await pages.browse.render(ctxOf(host, { params: { [PICK]: `${ROOT}/new` } }));
    expect(PICK.startsWith("view.")).toBe(true);
    expect(tableOf(out)).toMatchObject({ selectParam: PICK, rowKeys: [`${ROOT}/new`] });
    expect(out.view.some((n: any) => n.type === "form")).toBe(false);
    expect(out.values).toBeUndefined();
    expect(checkView(out.view)).toEqual([]);
  });
});

describe("market: package files (D461)", () => {
  it("reads id and version from <id>-<version>.odplugin; other names are not packages", () => {
    const parse = (n: string) => PACKAGE_FILE.exec(n)?.slice(1, 3) ?? null;
    expect(parse("org.example.notes-0.2.0.odplugin")).toEqual(["org.example.notes", "0.2.0"]);
    expect(parse("org.example.two-words-1.10.3-beta.1.odplugin")).toEqual(["org.example.two-words", "1.10.3-beta.1"]);
    expect(parse("org.example.notes.odplugin")).toBeNull();
    expect(parse("org.example.notes-0.2.0.zip")).toBeNull();
    expect(parse("readme.txt")).toBeNull();
  });

  it("lists package files at the top of an authorized folder next to package folders, with their status, and offers them", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      [`${ROOT}/com.example.zip-1.2.0.odplugin`]: "PK",
      [`${ROOT}/com.example.same-1.0.0.odplugin`]: "PK",
      [`${ROOT}/notes.txt`]: "x",
      ...pkgFiles(`${ROOT}/new`, "com.example.new", "1.0.0", "New", "d"),
    });
    const plugins = { list: async () => [{ id: "com.example.same", name: "Same", versions: ["1.0.0"], active: "1.0.0" }] };
    const out = await pages.browse.render(ctxOf({ files, plugins }));
    expect(checkView(out.view)).toEqual([]);
    const rows = rowsOf(out);
    expect(rows.map((r) => [r[0], r[1], r[3]])).toEqual([
      ["com.example.same", "1.0.0", "Installed 1.0.0"],
      ["com.example.zip", "1.2.0", "Not installed"],
      ["New", "1.0.0", "Not installed"],
    ]);
    expect(rows[1]![2]).toContain("com.example.zip-1.2.0.odplugin");
    expect(keysOf(out)).toEqual([`${ROOT}/com.example.same-1.0.0.odplugin`, `${ROOT}/com.example.zip-1.2.0.odplugin`, `${ROOT}/new`]);
  });

  it("installing a package file asks the framework with the file's path", async () => {
    const { pages } = registry(plugin);
    const requestInstall = vi.fn(async () => ({ outcome: "installed", id: "com.example.zip", version: "1.2.0" }));
    const file = `${ROOT}/com.example.zip-1.2.0.odplugin`;
    const host = { plugins: { requestInstall, list: async () => [] }, files: fakeFiles({ [file]: "PK" }) };
    const out = await pages.browse.onEvent(ctxOf(host, { params: { [PICK]: file }, draft: {} }), "install");
    expect(requestInstall).toHaveBeenCalledWith({ folder: file });
    expect(out.message).toBe("Installed com.example.zip 1.2.0.");
  });
});

describe("market: install", () => {
  const FOLDER = `${ROOT}/new`;
  const setup = (answer: unknown) => {
    const { pages } = registry(plugin);
    const requestInstall = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const files = fakeFiles({ ...pkgFiles(FOLDER, "com.example.hello", "0.1.0", "Hello", "d"), ...pkgFiles(`${ROOT}/same`, "com.example.same", "1.0.0", "Same", "d") });
    const list = async () => [{ id: "com.example.same", name: "Same", versions: ["1.0.0"], active: "1.0.0" }];
    return { pages, requestInstall, host: { plugins: { requestInstall, list }, files } };
  };
  const run = (s: ReturnType<typeof setup>, params: unknown = { [PICK]: FOLDER }) => s.pages.browse.onEvent(ctxOf(s.host, { params, draft: {} }), "install");

  it("asks the framework with the package folder and reports an installed result", async () => {
    const s = setup({ outcome: "installed", id: "com.example.hello", version: "0.1.0" });
    const out = await run(s);
    expect(s.requestInstall).toHaveBeenCalledWith({ folder: FOLDER });
    expect(out).toEqual({ params: { [PICK]: "" }, message: "Installed com.example.hello 0.1.0." });
  });
  it("declined: nothing changes", async () => {
    const out = await run(setup({ outcome: "declined" }));
    expect(out).toEqual({ message: "Installation cancelled." });
  });
  it("failed: shows the reason when there is one", async () => {
    expect((await run(setup({ outcome: "failed", reason: "badManifest" }))).message).toBe("Installation failed: badManifest");
    expect((await run(setup({ outcome: "failed" }))).message).toBe("Installation failed.");
  });
  it("expired", async () => {
    expect((await run(setup({ outcome: "expired" }))).message).toBe("The request timed out.");
  });
  it("a request already waiting is reported, other host errors propagate", async () => {
    expect((await run(setup(hostError("conflict", { reason: "pendingRequest" })))).message).toBe("Another install request is still waiting for an answer.");
    const denied = hostError("denied", { reason: "outsideGrant" });
    await expect(run(setup(denied))).rejects.toBe(denied);
  });
  it("a request turned away for the cooldown says how long to wait", async () => {
    const out = await run(setup(hostError("conflict", { reason: "cooldown", seconds: "17" })));
    expect(out.message).toBe("The last request was not completed. Try again in 17 s.");
  });
  it("a pick in the draft or under the old name is ignored: only ctx.params[view.pick] counts", async () => {
    const s = setup({ outcome: "installed" });
    expect((await s.pages.browse.onEvent(ctxOf(s.host, { draft: { [PICK]: FOLDER } }), "install")).message).toBe("Choose a package in the list first.");
    expect((await run(s, { pick: FOLDER })).message).toBe("Choose a package in the list first.");
    expect(s.requestInstall).not.toHaveBeenCalled();
  });
  it("a picked row that is installed already installs nothing", async () => {
    const s = setup({ outcome: "installed" });
    expect((await run(s, { [PICK]: `${ROOT}/same` })).message).toBe("Same: Installed 1.0.0. Nothing to install.");
    expect(s.requestInstall).not.toHaveBeenCalled();
  });
  it("does nothing without a selection", async () => {
    const s = setup({ outcome: "installed" });
    expect((await run(s, {})).message).toBe("Choose a package in the list first.");
    expect((await s.pages.browse.onEvent(ctxOf(s.host), "install")).message).toBe("Choose a package in the list first.");
    expect(s.requestInstall).not.toHaveBeenCalled();
  });
  it("messages are in the viewer's language", async () => {
    const s = setup({ outcome: "declined" });
    expect((await s.pages.browse.onEvent(ctxOf(s.host, { params: { [PICK]: FOLDER }, locale: "zh-CN" }), "install")).message).toBe("已取消安装。");
  });
  it("refresh answers with a message; unknown events are rejected", async () => {
    const s = setup({});
    expect((await s.pages.browse.onEvent(ctxOf(s.host), "refresh")).message).toBe("Rescanned.");
    await expect(s.pages.browse.onEvent(ctxOf(s.host), "explode")).rejects.toThrow("unknown event");
  });
  it("re-rendering after an install shows the new state", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/new`, "com.example.new", "1.0.0", "New", "d"));
    let installed: any[] = [];
    const host = { files, plugins: { list: async () => installed } };
    expect(rowsOf(await pages.browse.render(ctxOf(host)))[0]![3]).toBe("Not installed");
    installed = [{ id: "com.example.new", name: "New", versions: ["1.0.0"], active: "1.0.0" }];
    expect(rowsOf(await pages.browse.render(ctxOf(host)))[0]![3]).toBe("Installed 1.0.0");
  });
});

describe("market: limits, cache and untrusted text", () => {
  it("looks at no more than 400 directories and says the scan was cut short", async () => {
    const { pages } = registry(plugin);
    const all: Record<string, string> = {};
    for (let i = 0; i < MAX_PROBES + 50; i++) all[`${ROOT}/d${String(i).padStart(4, "0")}/readme.txt`] = "x"; // folders without a manifest
    const files = fakeFiles(all);
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    const manifestReads = files.readText.mock.calls.filter((c: string[]) => c[0]!.endsWith("/manifest.json")).length;
    expect(manifestReads).toBeLessThanOrEqual(MAX_PROBES);
    expect(out.view.find((n: any) => n.id === "capped").text).toBe("Scan stopped: too many folders to look through (limit 400).");
    expect(checkView(out.view)).toEqual([]);
  });

  it("counts the second level against the same limit", async () => {
    const { pages } = registry(plugin);
    const all: Record<string, string> = {};
    for (let i = 0; i < 10; i++) for (let j = 0; j < 100; j++) all[`${ROOT}/p${i}/v${j}/x.txt`] = "x";
    const files = fakeFiles(all);
    await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(files.readText.mock.calls.length).toBeLessThanOrEqual(MAX_PROBES + 10);
  });

  it("scans once and serves later renders from the cache; Rescan scans again", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/a`, "com.example.a", "1.0.0", "A", "d"));
    const host: any = { files, plugins: { list: async () => [] } };
    await pages.browse.render(ctxOf(host));
    const listed = files.list.mock.calls.length;
    expect(listed).toBeGreaterThan(0);
    await pages.browse.render(ctxOf(host));
    await pages.browse.render(ctxOf(host, { params: { [PICK]: "" } }));
    expect(files.list.mock.calls.length).toBe(listed);
    // a new package shows up only after a rescan
    Object.assign((files as any), {});
    const files2 = fakeFiles({ ...pkgFiles(`${ROOT}/a`, "com.example.a", "1.0.0", "A", "d"), ...pkgFiles(`${ROOT}/b`, "com.example.b", "1.0.0", "B", "d") });
    host.files = files2;
    expect(rowsOf(await pages.browse.render(ctxOf(host))).map((r) => r[0])).toEqual(["A"]);
    expect((await pages.browse.onEvent(ctxOf(host), "refresh")).message).toBe("Rescanned.");
    expect(rowsOf(await pages.browse.render(ctxOf(host))).map((r) => r[0])).toEqual(["A", "B"]);
  });

  it("status is not cached: an install changes the row without a rescan", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/a`, "com.example.a", "1.0.0", "A", "d"));
    let list: any[] = [];
    const host = { files, plugins: { list: async () => list } };
    expect(rowsOf(await pages.browse.render(ctxOf(host)))[0]![3]).toBe("Not installed");
    const listed = files.list.mock.calls.length;
    list = [{ id: "com.example.a", name: "A", versions: ["1.0.0"], active: "1.0.0" }];
    expect(rowsOf(await pages.browse.render(ctxOf(host)))[0]![3]).toBe("Installed 1.0.0");
    expect(files.list.mock.calls.length).toBe(listed);
  });

  it("ignores a damaged cache and scans again; a storage that fails still renders", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/a`, "com.example.a", "1.0.0", "A", "d"));
    const storage = { get: async () => "{ not json", set: async () => { throw hostError("invalid"); } };
    const out = await pages.browse.render(ctxOf({ files, storage, plugins: { list: async () => [] } }));
    expect(rowsOf(out)[0]![0]).toBe("A");
  });

  it("clean: strings only, no control or bidi characters, cut by characters", () => {
    expect(clean("a\u0000b\u202ec\u200fd\n e\u009f", 80)).toBe("abcd e");
    expect(clean({ evil: 1 }, 80)).toBe("");
    expect(clean(42, 80)).toBe("");
    expect(clean(undefined, 80)).toBe("");
    expect(clean("你".repeat(100), 80)).toHaveLength(80);
    expect(Array.from(clean("😀".repeat(100), 5))).toHaveLength(5);
  });

  it("name 80 / description 300 characters, no control characters, non-strings are missing", async () => {
    const { pages } = registry(plugin);
    const long = "N".repeat(200);
    const files = fakeFiles({
      [`${ROOT}/a/manifest.json`]: JSON.stringify({ id: "com.example.a", version: "1.0.0", apiVersion: "2", icon: "box", main: "main.js", name: "n", description: "d", contributes: { locales: { "en-US": "l.json" } } }),
      [`${ROOT}/a/l.json`]: JSON.stringify({ n: "x\u202e" + long, d: "D".repeat(500) + "\u0007" }),
      [`${ROOT}/b/manifest.json`]: JSON.stringify({ id: "com.example.b", version: "1.0.0", apiVersion: "2", icon: "box", main: "main.js", name: "nokey", description: ["x"] }),
      [`${ROOT}/c\u202etxt/manifest.json`]: "{ broken",
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    const rows = rowsOf(out);
    const a = rows.find((r) => r[1] === "1.0.0" && r[0]!.startsWith("x"))!;
    expect(a[0]).toHaveLength(MAX_NAME);
    expect(a[2]).toHaveLength(MAX_DESCRIPTION);
    const b = rows.find((r) => r[0] === "com.example.b")!; // no usable name: the id stands in
    expect(b[2]).toBe("");
    expect(JSON.stringify(rows)).not.toContain("plugin.");
    expect(JSON.stringify(rows)).not.toMatch(/\[object Object\]|\\u202e|\\u0007/);
    const c = rows.find((r) => r[3] === "Unavailable")!;
    expect(c[0]).toBe("ctxt");
  });

  it("text from the package's language file is cleaned and cut too", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      [`${ROOT}/a/manifest.json`]: pkgManifest("com.example.a", "1.0.0"),
      [`${ROOT}/a/locales/en-US.json`]: JSON.stringify({ "plugin.name": "Evil\u202e" + "x".repeat(300), "plugin.description": { nested: 1 } }),
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    const row = rowsOf(out)[0]!;
    expect(row[0]).toHaveLength(MAX_NAME);
    expect(row[0]).not.toContain("\u202e");
    expect(row[2]).toBe(""); // the non-string translation is missing: no raw key
  });
});
