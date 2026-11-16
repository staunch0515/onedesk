import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { MAX_PACKAGES, compareVersions, statusOf } from "./main.js";
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
  JSON.stringify({ id, version, apiVersion: "2", name: "plugin.name", description: "plugin.description", main: "main.js", contributes: { locales: { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" } }, ...extra });
const pkgLocales = (dir: string, name: string, desc: string, zh?: [string, string]) => ({
  [`${dir}/locales/en-US.json`]: JSON.stringify({ "plugin.name": name, "plugin.description": desc }),
  [`${dir}/locales/zh-CN.json`]: JSON.stringify({ "plugin.name": zh?.[0] ?? name, "plugin.description": zh?.[1] ?? desc }),
});
const pkgFiles = (dir: string, id: string, version: string, name: string, desc: string, zh?: [string, string]) => ({
  [`${dir}/manifest.json`]: pkgManifest(id, version),
  ...pkgLocales(dir, name, desc, zh),
});

const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ target: "node:org.onedesk.market:market/local", node: { tree: "org.onedesk.market:market", key: "local" }, locale: "en-US", host, t: tt, ...extra });
const rowsOf = (out: any) => out.view.find((n: any) => n.type === "table").rows as string[][];

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
    const dynamic = ["reason.unreadable", "reason.invalidJson", "reason.missingFields"];
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
    const files = fakeFiles(pkgFiles(`${ROOT}/a/1.0.0`, "com.example.a", "1.0.0", "Alpha", "First", ["阿尔法", "第一个"]));
    const host = { files, plugins: { list: async () => [] } };
    expect(rowsOf(await pages.browse.render(ctxOf(host, { locale: "zh-CN" })))[0]!.slice(0, 3)).toEqual(["阿尔法", "1.0.0", "第一个"]);
    expect(rowsOf(await pages.browse.render(ctxOf(host, { locale: "fr-FR" })))[0]!.slice(0, 3)).toEqual(["Alpha", "1.0.0", "First"]);
  });

  it("falls back to the raw strings when the language file is missing or a path escapes the package", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles({
      [`${ROOT}/a/1.0.0/manifest.json`]: pkgManifest("com.example.a", "1.0.0"),
      [`${ROOT}/b/1.0.0/manifest.json`]: pkgManifest("com.example.b", "1.0.0", { contributes: { locales: { "en-US": "../../x.json" } } }),
    });
    const out = await pages.browse.render(ctxOf({ files, plugins: { list: async () => [] } }));
    expect(rowsOf(out).map((r) => r[0])).toEqual(["plugin.name", "plugin.name"]);
    expect(files.readText).not.toHaveBeenCalledWith(`${ROOT}/b/1.0.0/../../x.json`);
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
    // unavailable packages cannot be picked
    const pick = out.view.find((n: any) => n.id === "pick").fields[0];
    expect(pick.options.map((o: any) => o.value)).toEqual([`${ROOT}/good`]);
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
    expect(out.view.map((n: any) => n.id)).toEqual(["none", "pick"]);
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
    const options = out.view.find((n: any) => n.id === "pick").fields[0].options;
    expect(options.map((o: any) => o.value)).toEqual([`${ROOT}/new`, `${ROOT}/upd`]);
  });
  it("Chinese status text", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/same`, "com.example.same", "1.0.0", "Same", "d"));
    const plugins = { list: async () => [{ id: "com.example.same", name: "Same", versions: ["1.0.0"], active: "1.0.0" }] };
    const out = await pages.browse.render(ctxOf({ files, plugins }, { locale: "zh-CN" }));
    expect(rowsOf(out)[0]![3]).toBe("已安装 1.0.0");
  });
  it("keeps the draft selection only while it is still installable", async () => {
    const { pages } = registry(plugin);
    const files = fakeFiles(pkgFiles(`${ROOT}/new`, "com.example.new", "1.0.0", "New", "d"));
    const host = { files, plugins: { list: async () => [] } };
    expect((await pages.browse.render(ctxOf(host, { draft: { pick: `${ROOT}/new` } }))).values).toEqual({ pick: `${ROOT}/new` });
    expect((await pages.browse.render(ctxOf(host, { draft: { pick: "/elsewhere" } }))).values).toEqual({ pick: "" });
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
    return { pages, requestInstall, host: { plugins: { requestInstall, list: async () => [] }, files: fakeFiles({}) } };
  };
  const run = (s: ReturnType<typeof setup>, draft: unknown = { pick: FOLDER }) => s.pages.browse.onEvent(ctxOf(s.host, { draft }), "install");

  it("asks the framework with the package folder and reports an installed result", async () => {
    const s = setup({ outcome: "installed", id: "com.example.hello", version: "0.1.0" });
    const out = await run(s);
    expect(s.requestInstall).toHaveBeenCalledWith({ folder: FOLDER });
    expect(out).toEqual({ changes: { pick: "" }, message: "Installed com.example.hello 0.1.0." });
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
  it("does nothing without a selection", async () => {
    const s = setup({ outcome: "installed" });
    expect((await run(s, {})).message).toBe("Choose a package first.");
    expect((await s.pages.browse.onEvent(ctxOf(s.host), "install")).message).toBe("Choose a package first.");
    expect(s.requestInstall).not.toHaveBeenCalled();
  });
  it("messages are in the viewer's language", async () => {
    const s = setup({ outcome: "declined" });
    expect((await s.pages.browse.onEvent(ctxOf(s.host, { draft: { pick: FOLDER }, locale: "zh-CN" }), "install")).message).toBe("已取消安装。");
  });
  it("refresh answers with a message; unknown events are rejected", async () => {
    const s = setup({});
    expect((await s.pages.browse.onEvent(ctxOf(s.host), "refresh")).message).toBe("Refreshed.");
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
