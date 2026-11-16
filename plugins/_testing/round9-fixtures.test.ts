/** Checks of the round-9 fixtures: keeper (fake host) and make-many-plugins (temp directory only). */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import keeper from "../../e2e/fixtures/plugins/com.example.keeper/0.1.0/main.js";
// @ts-ignore plain JS module, no types
import { isProtected, makeManyPlugins, manifestOf, packageId } from "../../e2e/fixtures/make-many-plugins.mjs";
import { checkActionResult, checkView, hostError, onlyKeys, registry, EVENT_RESULT_KEYS, RENDER_KEYS, TREE_NODE_KEYS, TREE_PAGE_KEYS } from "./view-check";

const fx = (p: string) => new URL(`../../e2e/fixtures/plugins/${p}`, import.meta.url);
const kdir = "com.example.keeper/0.1.0";
const json = (p: string) => JSON.parse(readFileSync(fx(`${kdir}/${p}`), "utf8"));
const locale = (l: string) => json(`locales/${l}.json`) as Record<string, string>;
const t = (key: string) => ({ "en-US": locale("en-US")[key], "zh-CN": locale("zh-CN")[key] });
const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ locale: "en-US", t, host, progress: vi.fn(), cancelled: () => false, ...extra }) as any;

describe("fixture: keeper", () => {
  const m = json("manifest.json");
  it("declares a fixed-host network, the box kind with its actions, the provided tree and two languages", () => {
    expect(m.requires).toEqual({ files: false, network: { hosts: ["example.com"] } });
    expect(m.contributes.kinds.map((k: any) => k.id)).toEqual(["box"]);
    expect(m.contributes.actions.map((a: any) => a.id)).toEqual(["stash", "slow"]);
    expect(m.contributes.trees).toEqual([expect.objectContaining({ id: "keeper", source: "provided" })]);
    const page = m.contributes.pages.find((p: any) => p.id === "editor");
    expect(page.actions.filter((a: any) => a.role === "event").map((a: any) => a.id)).toEqual(["remember", "recall", "abuse"]);
  });
  it("registers exactly what the manifest declares", () => {
    const r = registry(keeper);
    expect(Object.keys(r.kinds)).toEqual(["box"]);
    expect(Object.keys(r.actions).sort()).toEqual(["slow", "stash"]);
    expect(Object.keys(r.pages).sort()).toEqual(["editor", "tree"]);
    expect(Object.keys(r.trees)).toEqual(["keeper"]);
  });
  it("has the same locale keys in both languages and every key used is defined", () => {
    expect(Object.keys(locale("en-US")).sort()).toEqual(Object.keys(locale("zh-CN")).sort());
    const src = readFileSync(fx(`${kdir}/main.js`), "utf8");
    const used = [...src.matchAll(/(?:tr\(ctx, |ctx\.t\()"([a-zA-Z.]+)"/g)].map((x) => x[1]!);
    const labels = [...readFileSync(fx(`${kdir}/manifest.json`), "utf8").matchAll(/"(?:label|name|description|newName)":\s*"([a-zA-Z]+\.[a-zA-Z.]+)"/g)].map((x) => x[1]!);
    for (const k of [...used, ...labels]) expect(locale("en-US")[k], k).toBeTruthy();
  });
  it("renders a form bound to body.text, read-only while showing a run", async () => {
    const { pages } = registry(keeper);
    const out = await pages.editor.render(ctxOf({}));
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields[0]).toMatchObject({ name: "text", bind: "body.text" });
    expect((await pages.editor.render(ctxOf({}, { run: {} }))).view[0].fields[0].readOnly).toBe(true);
  });
  it("remember stores the draft text in storage; recall puts it back through changes", async () => {
    const { pages } = registry(keeper);
    const store = new Map<string, string>();
    const host = { storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)) } };
    expect((await pages.editor.onEvent(ctxOf(host, { draft: { "body.text": "hello" } }), "recall")).message).toBe("Nothing remembered.");
    const r = await pages.editor.onEvent(ctxOf(host, { draft: { "body.text": "hello" } }), "remember");
    expect(r.message).toBe("Remembered.");
    expect(store.get("draft")).toBe("hello");
    const back = await pages.editor.onEvent(ctxOf(host, { draft: { "body.text": "" } }), "recall");
    expect(back).toEqual({ changes: { "body.text": "hello" } });
    expect(onlyKeys(back, EVENT_RESULT_KEYS)).toEqual([]);
    await expect(pages.editor.onEvent(ctxOf(host), "nope")).rejects.toThrow("unknown event nope");
  });
  it("stash keeps that run's host; abuse uses it and returns the host's error as code/reason", async () => {
    const { pages, actions } = registry(keeper);
    expect((await pages.editor.onEvent(ctxOf({}), "abuse")).message).toBe("No handle kept.");
    const request = vi.fn(async () => {
      throw hostError("denied", { reason: "staleContext" });
    });
    const res = await actions.stash(ctxOf({ network: { request } }), {});
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.text).toBe("stashed");
    // the event's own host is not used: only the kept one
    const out = await pages.editor.onEvent(ctxOf({ network: { request: vi.fn() } }), "abuse");
    expect(request).toHaveBeenCalledWith({ method: "GET", url: "https://example.com/" });
    expect(out).toEqual({ message: "denied/staleContext" });
  });
  it("slow sleeps 20 seconds through the host, in two 10 s steps (the host caps one sleep at 10 s)", async () => {
    const { actions } = registry(keeper);
    const sleep = vi.fn(async () => undefined);
    const res = await actions.slow(ctxOf({ util: { sleep } }), {});
    expect(sleep.mock.calls).toEqual([[10000], [10000]]);
    expect(res.output.text).toBe("done slowly");
  });
  it("the provided tree has one node whose label follows ctx.locale", async () => {
    const { trees } = registry(keeper);
    const en = await trees.keeper.children(ctxOf({}), null, 0);
    expect(onlyKeys(en, TREE_PAGE_KEYS)).toEqual([]);
    expect(onlyKeys(en.nodes[0], TREE_NODE_KEYS)).toEqual([]);
    expect(en.nodes[0].label).toBe("Keeper node (en-US)");
    expect((await trees.keeper.children(ctxOf({}, { locale: "zh-CN" }), null, 0)).nodes[0].label).toBe("保管员节点（zh-CN）");
    expect((await trees.keeper.children(ctxOf({}), "node", 0)).nodes).toEqual([]);
  });
});

describe("make-many-plugins", () => {
  const tmp = mkdtempSync(join(tmpdir(), "onedesk-many-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  it("writes the asked number of minimal valid packages and nothing else", () => {
    const dir = join(tmp, "plugins");
    const ids = makeManyPlugins(dir, 20);
    expect(ids).toHaveLength(20);
    expect(readdirSync(dir).sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(20);
    expect(ids[0]).toBe(packageId(0));
    for (const id of ids) {
      const pkg = join(dir, id, "0.1.0");
      expect(readdirSync(pkg).sort()).toEqual(["locales", "main.js", "manifest.json"]);
      const m = JSON.parse(readFileSync(join(pkg, "manifest.json"), "utf8"));
      expect(m).toEqual(manifestOf(id));
      for (const k of ["id", "version", "apiVersion", "name", "icon", "main"]) expect(typeof m[k], k).toBe("string");
      expect(Object.keys(JSON.parse(readFileSync(join(pkg, "locales", "en-US.json"), "utf8")))).toEqual(["plugin.name", "plugin.description"]);
    }
    expect(readdirSync(tmp)).toEqual(["plugins"]);
  });
  it("refuses the real data directory and bad arguments", () => {
    const real = join(homedir(), "Library", "Application Support", "onedesk");
    expect(isProtected(real)).toBe(true);
    expect(isProtected(join(real, "plugins"))).toBe(true);
    expect(isProtected(join(homedir(), "Library", "Application Support", "onedesk-dev", "x"))).toBe(true);
    expect(isProtected(join(tmp, "x"))).toBe(false);
    expect(() => makeManyPlugins(join(real, "plugins"), 1)).toThrow(/refusing/);
    expect(existsSync(join(real, "plugins", packageId(0)))).toBe(false);
    expect(() => makeManyPlugins(join(tmp, "y"), -1)).toThrow();
    expect(() => makeManyPlugins(join(tmp, "y"), 1.5)).toThrow();
    expect(() => makeManyPlugins("", 1)).toThrow();
  });
});
