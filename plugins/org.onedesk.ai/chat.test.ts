import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin from "./main.js";
// @ts-ignore plain JS module, no types
import { fingerprint, history, MAX_REFS, parseApply } from "./chat.js";
import { checkActionResult, checkView, hostError, onlyKeys, registry, RENDER_KEYS } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

const NOTE = "0123456789abcdef0123456789abcdef";
const QUERY = "fedcba9876543210fedcba9876543210";
const SECRETLESS = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHAT = "cccccccccccccccccccccccccccccccc";

const noteFields = { target: `resource:${NOTE}`, name: "Release notes", description: "Notes for the 2.0 release", kindLabel: { "en-US": "Note" }, title: "Release notes", fields: [{ name: "body.text", label: { "en-US": "Text" }, kind: "longtext", value: "Old text", editable: true }, { name: "body.owner", label: "Owner", kind: "text", value: "ann@example.com", editable: false }] };
const queryFields = { target: `resource:${QUERY}`, name: "Orders", description: "Orders of today", kindLabel: "SQL", fields: [{ name: "body.sql", label: "SQL", kind: "code", language: "sql", value: "SELECT * FROM orders", editable: true }] };
const latest = { runId: "r9", output: { type: "table", columns: [{ key: "id", label: "id" }, { key: "email", label: "email" }], rows: [["1", "x@y.z"], ["2", "q@w.e"]], total: 2 }, meta: { plugin: "org.onedesk.sql", at: 1764000000000, env: "Production" } };
const reply = { text: "Here is a better text.\n\n```onedesk-apply\n{\"body.text\": \"New text\", \"body.owner\": \"x\"}\n```", model: "m1", usage: { input: 10, output: 5 }, stop: "end" };

type Host = Record<string, any>;
function fakeHost(opts: { env?: Record<string, string>; visible?: string[]; answer?: any } = {}): Host {
  const store = new Map<string, string>();
  const env: Record<string, string> = { "ai.connection": "c1", ...(opts.env || {}) };
  const visible = new Set(opts.visible ?? [NOTE, QUERY]);
  const names: Record<string, string> = { [NOTE]: "Release notes", [QUERY]: "Orders", [SECRETLESS]: "Hidden" };
  return {
    params: { config: vi.fn(async () => ({ found: false, value: "", sourceName: "" })), get: vi.fn(async (n: string) => (env[n] ? { found: true, value: env[n], sourceName: "Env" } : { found: false, value: "", sourceName: "" })) },
    settings: { get: vi.fn(async () => "") },
    storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)), remove: vi.fn(async (k: string) => void store.delete(k)) },
    pages: {
      fields: vi.fn(async (target: string) => {
        if (target === `resource:${NOTE}`) return noteFields;
        if (target === `resource:${QUERY}`) return queryFields;
        if (target.startsWith("new:")) return { target, name: "", description: "", kindLabel: "Note", title: "New note", fields: [{ name: "body.text", label: "Text", kind: "longtext", value: "", editable: true }] };
        throw hostError("denied", { reason: "notAiVisible" });
      }),
    },
    runs: { latest: vi.fn(async (id: string) => (id === QUERY ? latest : null)) },
    resources: {
      search: vi.fn(async (q: any) => ({ items: (q.ids || []).filter((id: string) => names[id]).map((id: string) => ({ id, name: names[id], kind: "k", kindLabel: id === QUERY ? "SQL" : "Note", aiVisible: visible.has(id) })), total: 0 })),
      get: vi.fn(async (id: string) => (id === CHAT ? { id: CHAT, body: { targetTab: "t-old" } } : null)),
      create: vi.fn(async (r: any) => ({ id: CHAT, name: r.name })),
      update: vi.fn(async () => ({ rev: 2 })),
      move: vi.fn(async () => null),
    },
    interfaces: { call: vi.fn(async () => opts.answer ?? reply), resources: vi.fn(async () => [{ id: "c1", name: "Local AI", fields: { model: "llama3" } }]) },
  };
}

const chatBody = (over: Record<string, unknown> = {}) => ({ mode: "", target: `resource:${NOTE}`, targetTab: "t1", targetName: "Release notes", refs: [NOTE, QUERY], turns: [], connectionId: "", runText: "", ...over });
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: `resource:${CHAT}`, locale: "en-US", envId: "e1", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const chatCtx = (host: Host, body = chatBody(), extra: Record<string, unknown> = {}) => ctxOf(host, { resource: { id: CHAT, name: "AI: Release notes", description: "Keep it short.", body }, ...extra });
const send = (_host: Host, ctx: any, input: unknown = {}) => registry(plugin).actions.send(ctx, input);
const sentOf = (host: Host) => host.interfaces.call.mock.calls.at(-1)[2];

describe("ai chat: the page (D479)", () => {
  it("shows the connection, the target, the material with what AI may see, and the conversation with its input box", async () => {
    const host = fakeHost({ visible: [NOTE] });
    const turns = [{ role: "user", text: "Shorter please" }, { role: "assistant", text: "Done.", model: "m1", usage: "10 / 5", apply: { values: { "body.text": "New" } } }];
    const out = await registry(plugin).pages.analysis.render(chatCtx(host, chatBody({ turns })));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["info", "connection", "target", "refs", "chat"]);
    expect(out.view[0].text).toContain("Connection: Local AI · Model: llama3");
    expect(out.view[2]).toMatchObject({ type: "link", target: `resource:${NOTE}`, label: "Target: Release notes" });
    expect(out.view[3].rows).toEqual([["Release notes", "Note", "Allowed"], ["Orders", "SQL", "Not allowed for AI — not sent"]]);
    expect(out.view[3].rowKeys).toEqual([NOTE, QUERY]);
    expect(out.view[3].rowActions[0].id).toBe("removeRef");
    const chat = out.view[4];
    expect(chat).toMatchObject({ type: "conversation", targetTab: "t1", input: { name: "message", send: "send" } });
    expect(chat.turns[0]).toEqual({ role: "user", text: "Shorter please" });
    expect(chat.turns[1]).toMatchObject({ role: "assistant", text: "Done.", caption: "m1 · 10 / 5", actions: [{ id: "apply", label: "Apply to Release notes" }] });
    expect(host.interfaces.call).not.toHaveBeenCalled();
  });
  it("without material it says how to add some; a run page has no input and no Apply", async () => {
    const host = fakeHost();
    const empty = await registry(plugin).pages.analysis.render(chatCtx(host, chatBody({ refs: [] })));
    expect(empty.view.find((n: any) => n.id === "refsEmpty").text).toContain("Drag resources onto this conversation");
    const turns = [{ role: "assistant", text: "x", apply: { values: { "body.text": "y" } } }];
    const ro = await registry(plugin).pages.analysis.render(chatCtx(host, chatBody({ turns }), { run: { id: "r" } }));
    const chat = ro.view.find((n: any) => n.type === "conversation");
    expect(chat.input).toBeUndefined();
    expect(chat.turns[0].actions).toBeUndefined();
  });
});

describe("ai chat: Send", () => {
  it("allow: sends the background, the target with its fields, the visible material and its last result, masked; the turn is stored", async () => {
    const host = fakeHost({ env: { "ai.policy": "allow" } });
    const res = await send(host, chatCtx(host, chatBody(), { params: { message: "Make it shorter" } }), { "target.draft": { "body.text": "Typed, not saved" } });
    expect(host.interfaces.call).toHaveBeenCalledTimes(1);
    const [iface, action, input, opts] = host.interfaces.call.mock.calls[0];
    expect([iface, action, opts]).toEqual(["onedesk.ai.chat/1", "chat", { resource: "c1" }]);
    expect(input.messages).toEqual([{ role: "user", text: "Make it shorter" }]);
    expect(input.system).toContain("Keep it short."); // the chat's description is the background
    expect(input.system).toContain("Target: Release notes (Note)");
    expect(input.system).toContain("Typed, not saved"); // what the target's tab shows, not only what is saved
    expect(input.system).not.toContain("Old text");
    expect(input.system).not.toContain("ann@example.com"); // a field named like an email: masked
    expect(input.system).toContain("onedesk-apply");
    expect(input.system).toContain("### Orders (SQL)");
    expect(input.system).toContain("SELECT * FROM orders");
    expect(input.system).toContain("Last run (environment Production");
    expect(input.system).not.toContain("x@y.z"); // the result is masked
    expect(host.runs.latest).toHaveBeenCalledWith(QUERY, "e1");
    expect(checkActionResult({ ...res, output: { type: res.output.type, text: res.output.text } })).toEqual([]);
    const [id, changes] = host.resources.update.mock.calls[0];
    expect(id).toBe(CHAT);
    const turns = changes["body.turns"];
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", text: "Make it shorter" });
    // only editable fields are applied; the block is taken out of the shown text
    expect(turns[1]).toMatchObject({ role: "assistant", text: "Here is a better text.", model: "m1", usage: "10 / 5", apply: { values: { "body.text": "New text" } } });
    expect(res.summary.message).toContain("changes for Release notes");
    const log = JSON.parse((await host.storage.get("audit"))!);
    expect(log[0]).toMatchObject({ kind: "chat", connection: "c1" });
    expect(JSON.stringify(log)).not.toContain("shorter");
  });
  it("material the user did not let AI see is not read and not sent", async () => {
    const host = fakeHost({ env: { "ai.policy": "allow" }, visible: [NOTE] });
    await send(host, chatCtx(host, chatBody({ refs: [QUERY] }), { params: { message: "x" } }));
    expect(host.runs.latest).not.toHaveBeenCalled();
    expect(host.pages.fields).not.toHaveBeenCalledWith(`resource:${QUERY}`, expect.anything());
    expect(sentOf(host).system).not.toContain("SELECT * FROM orders");
  });
  it("preview (the default): the first Send only shows the full text; the same Send again sends; a changed message is shown again", async () => {
    const host = fakeHost();
    const ctx = chatCtx(host, chatBody(), { params: { message: "Shorter" } });
    const first = await send(host, ctx);
    expect(host.interfaces.call).not.toHaveBeenCalled();
    expect(host.resources.update).not.toHaveBeenCalled();
    expect(first.output.text).toContain("What will be sent to Local AI (llama3)");
    expect(first.output.text).toContain("Shorter");
    expect(first.summary.message).toContain("Press Send again");
    const other = await send(host, chatCtx(host, chatBody(), { params: { message: "Longer" } }));
    expect(other.output.text).toContain("What will be sent");
    expect(host.interfaces.call).not.toHaveBeenCalled();
    await send(host, chatCtx(host, chatBody(), { params: { message: "Longer" } }));
    expect(host.interfaces.call).toHaveBeenCalledTimes(1);
  });
  it("empty box: the first time the description is the request; after that something must be written", async () => {
    const host = fakeHost({ env: { "ai.policy": "allow" } });
    await send(host, chatCtx(host));
    expect(sentOf(host).messages).toEqual([{ role: "user", text: "Keep it short." }]);
    const later = chatBody({ turns: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] });
    await expect(send(host, chatCtx(host, later))).rejects.toThrow("Write what you want first");
    const bare = fakeHost({ env: { "ai.policy": "allow" } });
    const ctx = ctxOf(bare, { resource: { id: CHAT, description: "", body: chatBody({ target: "", refs: [] }) } });
    await expect(send(bare, ctx)).rejects.toThrow("or a description in the info panel");
  });
  it("earlier turns go along (newest first within the budget); {{name}} is filled from the environment", async () => {
    const host = fakeHost({ env: { "ai.policy": "allow", region: "EU" } });
    const turns = [{ role: "user", text: "one" }, { role: "assistant", text: "two" }];
    await send(host, chatCtx(host, chatBody({ turns }), { params: { message: "Sales in {{region}}" } }));
    expect(sentOf(host).messages).toEqual([{ role: "user", text: "one" }, { role: "assistant", text: "two" }, { role: "user", text: "Sales in EU" }]);
    // the turn is stored as typed
    expect(host.resources.update.mock.calls[0][1]["body.turns"][2].text).toBe("Sales in {{region}}");
    expect(history([{ role: "user", text: "a".repeat(400) }, { role: "assistant", text: "b" }], 5, (s: string) => s.length)).toEqual([{ role: "assistant", text: "b" }]);
  });
  it("policy off sends nothing; a full conversation asks to clear it", async () => {
    const off = fakeHost({ env: { "ai.policy": "off" } });
    await expect(send(off, chatCtx(off, chatBody(), { params: { message: "x" } }))).rejects.toThrow("turned off");
    expect(off.interfaces.call).not.toHaveBeenCalled();
    const host = fakeHost({ env: { "ai.policy": "allow" } });
    const turns = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "t" }));
    await expect(send(host, chatCtx(host, chatBody({ turns }), { params: { message: "x" } }))).rejects.toThrow("is full");
  });
  it("Clear empties the turns only", async () => {
    const host = fakeHost();
    await registry(plugin).actions.clear(chatCtx(host), {});
    expect(host.resources.update).toHaveBeenCalledWith(CHAT, { "body.turns": [] });
  });
});

describe("ai chat: answers that change the target", () => {
  const fields = [{ name: "body.sql", kind: "code", language: "sql", editable: true }];
  it("reads the onedesk-apply block, keeps only editable fields, and takes the block out", () => {
    const r = parseApply("Text\n```onedesk-apply\n{\"body.text\":\"N\",\"name\":\"x\"}\n```", [{ name: "body.text", editable: true }, { name: "name", editable: false }]);
    expect(r).toEqual({ text: "Text", values: { "body.text": "N" } });
    expect(parseApply("Text", [])).toEqual({ text: "Text", values: null });
  });
  it("one editable code field: a single block in its language is the change; a JSON block of field names too", () => {
    expect(parseApply("Try:\n```sql\nSELECT 1\n```", fields).values).toEqual({ "body.sql": "SELECT 1" });
    expect(parseApply("```sql\nA\n```\n```sql\nB\n```", fields).values).toBeNull();
    expect(parseApply("```json\n{\"body.sql\": \"SELECT 2\"}\n```", fields).values).toEqual({ "body.sql": "SELECT 2" });
    expect(parseApply("```json\n{\"other\": 1}\n```", fields).values).toBeNull();
  });
  it("Apply hands the values to the shell for the target page (its tab, if open); nothing is written here", async () => {
    const host = fakeHost();
    const turns = [{ role: "user", text: "a" }, { role: "assistant", text: "b", apply: { values: { "body.text": "New" } } }];
    const res = await registry(plugin).pages.analysis.onEvent(chatCtx(host, chatBody({ turns }), { row: "1" }), "apply");
    expect(res).toEqual({ apply: { target: `resource:${NOTE}`, tabId: "t1", label: "Release notes", values: { "body.text": "New" } } });
    expect(host.resources.update).not.toHaveBeenCalled();
    const none = await registry(plugin).pages.analysis.onEvent(chatCtx(host, chatBody({ turns }), { row: "0" }), "apply");
    expect(none.message).toBeTruthy();
  });
});

describe("ai chat: material and the AI chat button", () => {
  it("a drop adds new resources (not itself, not twice, at most 20); Remove takes one out", async () => {
    const host = fakeHost();
    const { kinds, pages } = registry(plugin);
    const res = await kinds.analysis.drop(chatCtx(host, chatBody({ refs: [NOTE] })), { sources: [{ id: NOTE }, { id: QUERY }, { id: CHAT }, { id: "bad" }] });
    expect(res).toMatchObject({ handled: true });
    expect(host.resources.update).toHaveBeenCalledWith(CHAT, { "body.refs": [NOTE, QUERY] });
    const full = Array.from({ length: MAX_REFS }, (_, i) => i.toString(16).padStart(32, "0"));
    host.resources.update.mockClear();
    await kinds.analysis.drop(chatCtx(host, chatBody({ refs: full })), { sources: [{ id: QUERY }] });
    expect(host.resources.update).not.toHaveBeenCalled();
    await pages.analysis.onEvent(chatCtx(host, chatBody(), { row: NOTE }), "removeRef");
    expect(host.resources.update).toHaveBeenLastCalledWith(CHAT, { "body.refs": [QUERY] });
  });
  it("openChat makes the chat about a page next to it the first time, then opens the same one", async () => {
    const host = fakeHost();
    const open = registry(plugin).commands.openChat;
    const first = await open(ctxOf(host), { target: `resource:${NOTE}`, tabId: "t1", args: { envId: "e1" } });
    expect(first).toEqual([{ type: "open", target: `resource:${CHAT}`, envId: "e1" }]);
    const made = host.resources.create.mock.calls[0][0];
    expect(made).toMatchObject({ kind: "analysis", name: "AI: Release notes", body: { target: `resource:${NOTE}`, targetTab: "t1", targetName: "Release notes", refs: [NOTE], turns: [] } });
    expect(host.resources.move).toHaveBeenCalledWith(CHAT, { before: NOTE });
    const again = await open(ctxOf(host), { target: `resource:${NOTE}`, tabId: "t2", args: {} });
    expect(again).toEqual([{ type: "open", target: `resource:${CHAT}` }]);
    expect(host.resources.create).toHaveBeenCalledTimes(1);
    expect(host.resources.update).toHaveBeenCalledWith(CHAT, { "body.targetTab": "t2" });
  });
  it("a new, unsaved page gets its own chat per tab, without material; anything else is not a page", async () => {
    const host = fakeHost();
    const open = registry(plugin).commands.openChat;
    await open(ctxOf(host), { target: "new:org.onedesk.note:note", tabId: "t9", args: { name: "Moon poem" } });
    expect(host.resources.create.mock.calls[0][0]).toMatchObject({ name: "AI: Moon poem", body: { target: "new:org.onedesk.note:note", targetTab: "t9", targetName: "Moon poem", refs: [] } });
    expect(host.resources.move).not.toHaveBeenCalled();
    expect(await host.storage.get("chat:new:t9")).toBe(CHAT);
    const none = await open(ctxOf(host), { target: "shell:welcome" });
    expect(none[0]).toMatchObject({ type: "toast" });
  });
  it("the fingerprint changes with the text", () => {
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
    expect(fingerprint("same")).toBe(fingerprint("same"));
  });
});
