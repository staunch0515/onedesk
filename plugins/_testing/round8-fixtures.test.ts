/** Checks of the round-8 fixtures: transfer, board, board-extra (fake host; the kernel is not involved). */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import transfer from "../../e2e/fixtures/plugins/com.example.transfer/0.1.0/main.js";
// @ts-ignore plain JS module, no types
import board from "../../e2e/fixtures/plugins/com.example.board/0.1.0/main.js";
// @ts-ignore plain JS module, no types
import extra, { shoutText } from "../../e2e/fixtures/plugins/com.example.board-extra/0.1.0/main.js";
import { checkActionResult, checkView, hostError, onlyKeys, registry, RENDER_KEYS } from "./view-check";

const fx = (p: string) => new URL(`../../e2e/fixtures/plugins/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(fx(p), "utf8"));
const dir = (id: string) => `${id}/0.1.0`;
const locale = (id: string, l: string) => json(`${dir(id)}/locales/${l}.json`) as Record<string, string>;
const mkCtx = (id: string) => {
  const t = (key: string) => ({ "en-US": locale(id, "en-US")[key], "zh-CN": locale(id, "zh-CN")[key] });
  return (host: unknown, extra: Record<string, unknown> = {}) => ({ locale: "en-US", t, host, progress: vi.fn(), cancelled: () => false, ...extra }) as any;
};

/** Every key the manifest and the code use is defined in both languages, and the two files have the same keys. */
function localeChecks(id: string, extraKeys: string[] = []) {
  it("has the same locale keys in both languages; every key used is defined", () => {
    const en = locale(id, "en-US");
    expect(Object.keys(en).sort()).toEqual(Object.keys(locale(id, "zh-CN")).sort());
    const src = readFileSync(fx(`${dir(id)}/main.js`), "utf8");
    const used = [...src.matchAll(/(?:tr\(ctx, |ctx\.t\()"([a-zA-Z.]+)"/g)].map((m) => m[1]!);
    const manifestText = readFileSync(fx(`${dir(id)}/manifest.json`), "utf8");
    const labels = [...manifestText.matchAll(/"(?:label|name|description|newName)":\s*"([a-zA-Z]+\.[a-zA-Z.]+)"/g)].map((m) => m[1]!);
    for (const k of [...used, ...labels, ...extraKeys]) expect(en[k], k).toBeTruthy();
  });
}

describe("fixture: transfer", () => {
  const id = "com.example.transfer";
  const m = json(`${dir(id)}/manifest.json`);
  const ctxOf = mkCtx(id);
  it("asks for files, the network of the connected resources and the system program cat", () => {
    expect(m.requires).toEqual({ files: true, network: { fromResources: true }, programs: [{ name: "cat", source: "system" }] });
  });
  it("has one kind `job` (url grants the network, path is text) and three text actions", () => {
    expect(m.contributes.kinds.map((k: any) => k.id)).toEqual(["job"]);
    expect(m.contributes.kinds[0].fields.url).toEqual({ type: "text", grants: "network" });
    expect(Object.keys(m.contributes.kinds[0].defaults)).toEqual(["url", "path"]);
    expect(m.contributes.actions.map((a: any) => [a.id, a.output, a.kinds])).toEqual([
      ["download", "text", ["job"]],
      ["upload", "text", ["job"]],
      ["capture", "text", ["job"]],
    ]);
    expect(m.contributes.pages[0].actions.filter((a: any) => a.role === "run").map((a: any) => a.action)).toEqual(["download", "upload", "capture"]);
  });
  localeChecks(id);
  it("registers the kind, the page and exactly three actions", () => {
    const r = registry(transfer);
    expect(Object.keys(r.kinds)).toEqual(["job"]);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions).sort()).toEqual(["capture", "download", "upload"]);
  });
  it("renders a form of url and path bound to the body; read-only while a run is shown", async () => {
    const { pages } = registry(transfer);
    const out = await pages.editor.render(ctxOf({}));
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(checkView(out.view)).toEqual([]);
    expect(out.view.flatMap((n: any) => n.fields.map((f: any) => f.bind))).toEqual(["body.url", "body.path"]);
    const ro = await pages.editor.render(ctxOf({}, { run: { id: "r1" } }));
    expect(ro.view.every((n: any) => n.fields.every((f: any) => f.readOnly))).toBe(true);
  });
  it("download: passes url and path, reports progress, answers with status and bytes", async () => {
    const { actions } = registry(transfer);
    const download = vi.fn(async (o: any) => {
      o.onProgress({ bytes: 10, total: 40 });
      o.onProgress({ bytes: 40 });
      return { status: 200, headers: {}, bytes: 40, path: o.to };
    });
    const ctx = ctxOf({ transfer: { download } });
    const res = await actions.download(ctx, { "body.url": "http://127.0.0.1:1/bytes/40", "body.path": "/tmp/x/out.bin" });
    expect(download).toHaveBeenCalledWith({ url: "http://127.0.0.1:1/bytes/40", to: "/tmp/x/out.bin", onProgress: expect.any(Function) });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.text).toBe("status 200, 40 bytes");
    expect(ctx.progress.mock.calls.map((c: any[]) => c[1])).toEqual(["10 of 40 bytes", "40 bytes"]);
  });
  it("download: a non-2xx answer is reported, not thrown", async () => {
    const { actions } = registry(transfer);
    const download = vi.fn(async () => ({ status: 404, headers: {}, bytes: 0 }));
    expect((await actions.download(ctxOf({ transfer: { download } }), { "body.url": "u", "body.path": "p" })).output.text).toBe("status 404, 0 bytes");
  });
  it("upload: reads from the path and reports the status", async () => {
    const { actions } = registry(transfer);
    const upload = vi.fn(async (o: any) => {
      o.onProgress({ bytes: 5, total: 5 });
      return { status: 201, headers: {}, body: "", truncated: false };
    });
    const ctx = ctxOf({ transfer: { upload } });
    const res = await actions.upload(ctx, { "body.url": "http://127.0.0.1:1/sink/a", "body.path": "/tmp/x/in.bin" });
    expect(upload).toHaveBeenCalledWith({ from: "/tmp/x/in.bin", url: "http://127.0.0.1:1/sink/a", onProgress: expect.any(Function) });
    expect(res.output.text).toBe("status 201");
    expect(checkActionResult(res)).toEqual([]);
  });
  it("capture: runs `cat <path>` into <path>.copy and reports the bytes", async () => {
    const { actions } = registry(transfer);
    const capture = vi.fn(async (o: any) => ({ code: 0, stderr: "", truncated: false, bytes: 12, path: o.to }));
    const res = await actions.capture(ctxOf({ transfer: { capture } }), { "body.path": "/tmp/x/in.txt" });
    expect(capture).toHaveBeenCalledWith({ program: "cat", args: ["/tmp/x/in.txt"], to: "/tmp/x/in.txt.copy", onProgress: expect.any(Function) });
    expect(res.output.text).toBe("12 bytes");
  });
  it("host errors are thrown as they are, with code and params", async () => {
    const { actions } = registry(transfer);
    const err = hostError("denied", { reason: "notAllowed", host: "evil.example" });
    const host = { transfer: { download: vi.fn(async () => Promise.reject(err)), upload: vi.fn(async () => Promise.reject(err)), capture: vi.fn(async () => Promise.reject(err)) } };
    for (const a of ["download", "upload", "capture"]) await expect(actions[a](ctxOf(host), { "body.url": "u", "body.path": "p" })).rejects.toBe(err);
  });
  it("answers in the viewer's language", async () => {
    const { actions } = registry(transfer);
    const download = vi.fn(async () => ({ status: 200, headers: {}, bytes: 3 }));
    expect((await actions.download(ctxOf({ transfer: { download } }, { locale: "zh-CN" }), {})).output.text).toBe("状态码 200，3 字节");
  });
});

describe("fixture: board", () => {
  const id = "com.example.board";
  const m = json(`${dir(id)}/manifest.json`);
  const ctxOf = mkCtx(id);
  it("owns two stored trees and exports only `board` and the `card` page", () => {
    expect(m.contributes.trees.map((t: any) => [t.id, t.source])).toEqual([["board", "stored"], ["hidden", "stored"]]);
    expect(m.exports).toEqual({ trees: [{ id: "board" }], pages: [{ id: "card" }] });
  });
  it("has kind card in the board tree using page card; the page has a save and an event action", () => {
    expect(m.contributes.kinds).toHaveLength(1);
    expect(m.contributes.kinds[0]).toMatchObject({ id: "card", tree: "board", page: "card" });
    expect(m.contributes.pages[0].actions.map((a: any) => [a.id, a.role])).toEqual([["save", "save"], ["upper", "event"]]);
    expect(m.contributes.menus.new).toEqual(["card"]);
  });
  localeChecks(id, ["action.upper", "action.save"]);
  it("registers the kind and the page", () => {
    const r = registry(board);
    expect(Object.keys(r.kinds)).toEqual(["card"]);
    expect(Object.keys(r.pages)).toEqual(["card"]);
  });
  it("renders one long text field bound to body.text; read-only when a run or a foreign resource is shown", async () => {
    const { pages } = registry(board);
    const out = await pages.card.render(ctxOf({}));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields).toEqual([expect.objectContaining({ name: "text", kind: "longtext", bind: "body.text" })]);
    expect(out.view[0].fields[0].readOnly).toBeUndefined();
    expect((await pages.card.render(ctxOf({}, { run: { id: "r" } }))).view[0].fields[0].readOnly).toBe(true);
  });
  it("upper: upper-cases the unsaved text and returns it through `changes`", async () => {
    const { pages } = registry(board);
    const res = await pages.card.onEvent(ctxOf({}, { draft: { "body.text": "hello wörld" }, resource: { body: { text: "saved" } } }), "upper");
    expect(res).toEqual({ changes: { "body.text": "HELLO WÖRLD" }, message: "Changed to upper case." });
    expect(onlyKeys(res, ["changes", "params", "message"])).toEqual([]);
  });
  it("upper: falls back to the saved text without a draft; unknown events are rejected", async () => {
    const { pages } = registry(board);
    expect((await pages.card.onEvent(ctxOf({}, { resource: { body: { text: "abc" } } }), "upper")).changes).toEqual({ "body.text": "ABC" });
    expect((await pages.card.onEvent(ctxOf({}, {}), "upper")).changes).toEqual({ "body.text": "" });
    await expect(pages.card.onEvent(ctxOf({}), "boom")).rejects.toThrow("unknown event");
  });
  it("answers in the viewer's language", async () => {
    const { pages } = registry(board);
    expect((await pages.card.onEvent(ctxOf({}, { locale: "zh-CN", draft: { "body.text": "a" } }), "upper")).message).toBe("已转为大写。");
  });
});

describe("fixture: board-extra", () => {
  const id = "com.example.board-extra";
  const m = json(`${dir(id)}/manifest.json`);
  const ctxOf = mkCtx(id);
  it("depends on the board plugin", () => {
    expect(m.depends).toEqual([{ id: "com.example.board", version: ">=0.1.0" }]);
    expect(json(`${dir("com.example.board")}/manifest.json`).id).toBe(m.depends[0].id);
  });
  it("memo lives in the board's exported tree and uses its exported page, both by full name", () => {
    const board = json(`${dir("com.example.board")}/manifest.json`);
    const memo = m.contributes.kinds.find((k: any) => k.id === "memo");
    expect(memo).toMatchObject({ tree: "com.example.board:board", page: "com.example.board:card" });
    expect(board.exports.trees.map((t: any) => `${board.id}:${t.id}`)).toContain(memo.tree);
    expect(board.exports.pages.map((p: any) => `${board.id}:${p.id}`)).toContain(memo.page);
    expect(memo.defaults).toEqual({ text: "" });
  });
  it("stray names a tree the board does not export", () => {
    const board = json(`${dir("com.example.board")}/manifest.json`);
    const stray = m.contributes.kinds.find((k: any) => k.id === "stray");
    expect(stray.tree).toBe("com.example.board:hidden");
    expect(board.exports.trees.map((t: any) => `${board.id}:${t.id}`)).not.toContain(stray.tree);
    expect(board.contributes.trees.map((t: any) => `${board.id}:${t.id}`)).toContain(stray.tree);
  });
  it("lists memo in the new menu; shout works on memos and outputs text", () => {
    expect(m.contributes.menus.new).toContain("memo");
    expect(m.contributes.actions).toEqual([expect.objectContaining({ id: "shout", kinds: ["memo"], output: "text" })]);
    expect(m.exports).toBeUndefined();
  });
  localeChecks(id);
  it("registers its two kinds and the shout action; no page of its own", () => {
    const r = registry(extra);
    expect(Object.keys(r.kinds).sort()).toEqual(["memo", "stray"]);
    expect(Object.keys(r.actions)).toEqual(["shout"]);
    expect(Object.keys(r.pages)).toEqual([]);
  });
  it("shout adds an exclamation mark to the text (resource first, input snapshot as fallback)", async () => {
    const { actions } = registry(extra);
    const a = await actions.shout(ctxOf({}, { resource: { id: "m", body: { text: "hello" } } }), {});
    expect(checkActionResult(a)).toEqual([]);
    expect(a.output).toEqual({ type: "text", text: "hello!" });
    expect((await actions.shout(ctxOf({}, { resource: { id: "m", body: {} } }), { "body.text": "hey" })).output.text).toBe("hey!");
    expect(shoutText(undefined)).toBe("!");
  });
});
