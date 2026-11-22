import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { audit, buildRequest, checkSql, composeRequest, estimateTokens, extractSql, isSensitiveColumn, markdownTable, maskText, parseExtra, pickConnection, pickDocs, policyOf, redactTable, searchTerms, syncDocs, tableNamesIn } from "./main.js";
import { checkActionResult, checkView, hostError, onlyKeys, registry, RENDER_KEYS } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

type Host = Record<string, any>;
const table = {
  type: "table",
  columns: [
    { key: "c0", label: "id" },
    { key: "c1", label: "Email" },
    { key: "c2", label: "note" },
    { key: "c3", label: "apiKey" },
  ],
  rows: [["1", "a@b.com", "call 4111 1111 1111 1111 or a@b.com", "k"], ["2", "c@d.org", "ok", "k2"]],
  total: 2,
};
const reply = { text: "It looks fine.", model: "claude-haiku-5-5", usage: { input: 100, output: 20 }, stop: "end" };

function fakeHost(over: Host = {}, opts: { env?: Record<string, string>; settings?: Record<string, string>; cfg?: Record<string, string> } = {}): Host {
  const store = new Map<string, string>();
  const bodies = new Map<string, any>();
  const env: Record<string, string> = { "ai.connection": "c1", ...(opts.env || {}) };
  const settings = opts.settings || {};
  const cfg = opts.cfg || {};
  return {
    params: { config: vi.fn(async (n: string) => (cfg[n] ? { found: true, value: cfg[n], sourceName: "Workspace" } : { found: false, value: "", sourceName: "" })), get: vi.fn(async (n: string) => (env[n] ? { found: true, value: env[n], sourceName: "Env" } : { found: false, value: "", sourceName: "" })) },
    settings: { get: vi.fn(async (n: string) => settings[n] ?? "") },
    storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)), remove: vi.fn(async (k: string) => void store.delete(k)) },
    runs: { read: vi.fn(async () => ({ output: table, meta: { plugin: "org.onedesk.sql", kind: "query", resource: "q1", at: 1 } })) },
    resources: {
      get: vi.fn(async (id: string) => bodies.get(id) ?? (id === "c1" ? { id: "c1", name: "Local AI", body: { model: "llama3" } } : id === "q1" ? { id: "q1", name: "Q", body: { sql: "SELECT * FROM public.orders o JOIN users u ON 1=1" } } : id === "d1" ? { id: "d1", body: { text: "Orders hold one row per order." } } : null)),
      list: vi.fn(async () => []),
      search: vi.fn(async () => [{ id: "d1", kind: "org.onedesk.ai:doc", name: "orders.md", snippet: "Orders hold", score: 3 }]),
      create: vi.fn(async (r: any) => {
        bodies.set("a1", { id: "a1", name: r.name, body: r.body });
        return { id: "a1", name: r.name };
      }),
      update: vi.fn(async () => undefined),
      upsertByKey: vi.fn(async () => ({ ids: {} })),
    },
    interfaces: { call: vi.fn(async () => reply), list: vi.fn(async () => [{ plugin: "org.onedesk.ai.x", kind: "connection", label: "X" }]) },
    files: { roots: vi.fn(async () => [{ path: "/docs" }]), list: vi.fn(async () => ({ entries: [] })), readText: vi.fn(async () => ({ text: "x" })) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: "core:none", locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const A = (host: Host, name: string, input: unknown = {}, extra: Record<string, unknown> = {}) => registry(plugin).actions[name](ctxOf(host, extra), input);
const draftBody = (over: Record<string, string> = {}) => ({ request: "# Analysis request\n\nbody", docs: JSON.stringify([{ id: "d1", name: "orders.md", text: "Doc text", tokens: 3 }]), runId: "run1", answer: "", model: "", usage: "", connection: "", sent: "", use0: "true", ...over });
const analysisCtx = (host: Host, body = draftBody(), extra: Record<string, unknown> = {}) => ctxOf(host, { resource: { id: "a1", name: "Analysis", body }, ...extra });

describe("ai: masking (K4)", () => {
  it("masks whole columns by name: password, token, email, phone … as words, camelCase and parts; the user's own names too", () => {
    for (const n of ["password", "user_password", "apiKey", "API_KEY", "Email", "contactEmail", "phone_number", "secret", "auth-token", "card_number"]) expect(isSensitiveColumn(n, []), n).toBe(true);
    for (const n of ["id", "hotel", "telemetry", "name", "tokens_per_day_x"]) expect(isSensitiveColumn(n, []), n).toBe(n === "tokens_per_day_x" ? false : false);
    expect(isSensitiveColumn("salary", [])).toBe(false);
    expect(isSensitiveColumn("salary", parseExtra("Salary, bank_x"))).toBe(true);
    expect(parseExtra(" a, B ;c\n")).toEqual(["a", "b", "c"]);
  });
  it("masks emails and long digit strings in any cell and cuts cells", () => {
    expect(maskText("write to a.b@c.co now", 200)).toBe("write to [email] now");
    expect(maskText("card 4111 1111 1111 1111!", 200)).toBe("card [number]!");
    expect(maskText("order 12345678", 200)).toBe("order 12345678"); // 8 digits is not long
    expect(maskText("x".repeat(30), 10)).toBe(`${"x".repeat(10)}…`);
    expect(maskText(null, 10)).toBe("");
  });
  it("keeps only the first rows and masks sensitive columns as a whole", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [String(i), `u${i}@x.io`, "n", "k"]);
    const r = redactTable({ ...table, rows, total: 50 }, { maxRows: 20, maxCell: 200 });
    expect(r.shown).toBe(20);
    expect(r.total).toBe(50);
    expect(r.masked).toEqual(["Email", "apiKey"]);
    expect(r.rows[0]).toEqual(["0", "***", "n", "***"]);
    expect(JSON.stringify(r)).not.toContain("@");
  });
  it("the Markdown request says what was cut and masked, and never has the raw values", () => {
    const md = buildRequest(ctxOf(fakeHost()), { output: table, meta: { plugin: "org.onedesk.sql", kind: "query" } }, { maxRows: 1, maxCell: 200, extra: [] });
    expect(md).toContain("| id | Email | note | apiKey |");
    expect(md).toContain("Only the first 1 of 2 rows");
    expect(md).toContain("Masked columns: Email, apiKey");
    expect(md).not.toMatch(/a@b\.com|4111|c@d\.org/);
    expect(markdownTable({ columns: ["a|b"], rows: [["x\ny"]] })).toContain("a\\|b");
  });
  it("text results are masked and cut too", () => {
    const md = buildRequest(ctxOf(fakeHost()), { output: { type: "text", text: `mail me@x.io ${"y".repeat(5000)}` }, meta: {} }, {});
    expect(md).toContain("[email]");
    expect(md).toContain("cut at 4000");
  });
  it("estimates tokens: ASCII by 4, other characters one each", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("日本語")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("ai: reference documents (K2)", () => {
  it("terms: table names from FROM/JOIN, then column labels, no blanks, at most 20", () => {
    expect(tableNamesIn("select * from public.orders o join \"users\" u on 1 where x in (select 1 from items)")).toEqual(["orders", "users", "items"]);
    expect(searchTerms(["orders"], ["id", "a b", "x", "orders"])).toEqual(["orders", "id"]);
    expect(searchTerms(Array.from({ length: 30 }, (_, i) => `t${i}`), [])).toHaveLength(20);
  });
  it("searches with any-word / relevance / this plugin's documents, and stays inside the budget", async () => {
    const host = fakeHost();
    const docs = await pickDocs(ctxOf(host), ["orders", "id"], 1000);
    expect(host.resources.search).toHaveBeenCalledWith({ query: "orders id", mode: "any", rank: "relevance", kinds: ["org.onedesk.ai:doc"], limit: 8 });
    expect(docs).toEqual([{ id: "d1", name: "orders.md", text: "Orders hold one row per order.", tokens: estimateTokens("Orders hold one row per order."), score: 3 }]);
    const big = fakeHost({ resources: { ...host.resources, get: vi.fn(async () => ({ id: "d1", body: { text: "word ".repeat(2000) } })) } });
    const cut = await pickDocs(ctxOf(big), ["orders"], 500);
    expect(cut).toHaveLength(1);
    expect(cut[0].tokens).toBeLessThanOrEqual(500);
    expect(await pickDocs(ctxOf(big), ["orders"], 100)).toEqual([]); // what is left is too little to be worth a cut
    expect(await pickDocs(ctxOf(host), [], 1000)).toEqual([]);
  });
  it("a search that fails means no documents, not a failure", async () => {
    const host = fakeHost({ resources: { search: vi.fn(async () => { throw hostError("denied"); }) } });
    expect(await pickDocs(ctxOf(host), ["a"], 1000)).toEqual([]);
  });
  it("sync: reads the authorized folder's .md/.txt files into document resources, replacing the old set", async () => {
    const lists: Record<string, any> = {
      "/docs": { entries: [{ name: "a.md", path: "/docs/a.md" }, { name: "b.png", path: "/docs/b.png" }, { name: ".hid.md", path: "/docs/.hid.md" }, { name: "sub", path: "/docs/sub", dir: true }] },
      "/docs/sub": { entries: [{ name: "c.txt", path: "/docs/sub/c.txt" }] },
    };
    const host = fakeHost({ files: { roots: vi.fn(async () => [{ path: "/docs" }]), list: vi.fn(async (d: string) => lists[d]), readText: vi.fn(async (p: string) => ({ text: `text of ${p}` })) } }, { settings: { docFolder: "/docs" } });
    expect(await syncDocs(ctxOf(host))).toBe(2);
    expect(host.resources.upsertByKey).toHaveBeenCalledWith("doc", [{ key: "/docs/a.md", name: "a.md", body: { path: "/docs/a.md", text: "text of /docs/a.md" } }, { key: "/docs/sub/c.txt", name: "c.txt", body: { path: "/docs/sub/c.txt", text: "text of /docs/sub/c.txt" } }], { othersMissing: true });
    const res = await A(host, "syncDocs");
    expect(checkActionResult(res)).toEqual([]);
  });
  it("sync refuses a folder that was not authorized, or none set", async () => {
    await expect(syncDocs(ctxOf(fakeHost({}, { settings: { docFolder: "/etc" } })))).rejects.toThrow("not a folder you authorized");
    await expect(syncDocs(ctxOf(fakeHost()))).rejects.toThrow("No document folder");
  });
});

describe("ai: policy and connection (K10)", () => {
  it("ai.policy: the environment's value; anything else is preview", async () => {
    expect(await policyOf(ctxOf(fakeHost()))).toBe("preview");
    for (const p of ["off", "preview", "allow"]) expect(await policyOf(ctxOf(fakeHost({}, { env: { "ai.policy": p } })))).toBe(p);
    expect(await policyOf(ctxOf(fakeHost({}, { env: { "ai.policy": "yolo" } })))).toBe("preview");
  });
  it("the connection: the environment's ai.connection, else the workspace setting; says where a stale one came from", async () => {
    expect(await pickConnection(ctxOf(fakeHost()))).toEqual({ id: "c1", name: "Local AI", model: "llama3" });
    const def = fakeHost({}, { env: { "ai.connection": "" }, cfg: { "ai.connection.default": "c1" } });
    expect((await pickConnection(ctxOf(def))).id).toBe("c1");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" } })))).rejects.toThrow("No AI connection");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "ghost" } })))).rejects.toThrow("(from the environment) was not found");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" }, cfg: { "ai.connection.default": "ghost" } })))).rejects.toThrow("(the workspace default) was not found");
  });
  it("a connection can be found by name too", async () => {
    const host = fakeHost({}, { env: { "ai.connection": "My AI" } });
    host.resources.list = vi.fn(async () => [{ id: "c9", name: "My AI" }]);
    expect(await pickConnection(ctxOf(fakeHost()), "c1")).toMatchObject({ id: "c1" }); // the page's own choice wins
    expect((await pickConnection(ctxOf(host))).id).toBe("c9");
  });
});

describe("ai: analyze (K1) and the preview page (K3)", () => {
  it("analyze reads the run's result (only now), builds a masked draft and opens it; nothing is sent", async () => {
    const host = fakeHost();
    const res = await A(host, "analyze", { runId: "run1" });
    expect(host.runs.read).toHaveBeenCalledWith("run1");
    expect(host.interfaces.call).not.toHaveBeenCalled();
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "link", label: "Analysis " + new Date().toISOString().slice(0, 10), target: "resource:a1" });
    const body = host.resources.create.mock.calls[0][0].body;
    expect(host.resources.create.mock.calls[0][0].kind).toBe("analysis");
    expect(body.request).toContain("Masked columns: Email, apiKey");
    expect(body.request).not.toMatch(/a@b\.com|4111/);
    expect(body.runId).toBe("run1");
    // documents by the statement's table names and the result's columns
    expect(host.resources.search.mock.calls[0][0]).toMatchObject({ mode: "any", rank: "relevance" });
    expect(host.resources.search.mock.calls[0][0].query.split(" ").slice(0, 2)).toEqual(["orders", "users"]);
    expect(JSON.parse(body.docs)[0]).toMatchObject({ id: "d1", name: "orders.md" });
  });
  it("uses the settings for rows, cell length and the user's sensitive columns", async () => {
    const host = fakeHost({}, { settings: { maxRows: "1", maxCell: "5", sensitiveColumns: "note" } });
    await A(host, "analyze", { runId: "run1" });
    const req = host.resources.create.mock.calls[0][0].body.request;
    expect(req).toContain("Only the first 1 of 2 rows");
    expect(req).toContain("Masked columns: Email, note, apiKey");
  });
  it("is refused when the environment says off; without a run there is nothing to analyze", async () => {
    await expect(A(fakeHost({}, { env: { "ai.policy": "off" } }), "analyze", { runId: "r" })).rejects.toThrow("turned off");
    await expect(A(fakeHost(), "analyze", {})).rejects.toThrow("no result");
    const none = fakeHost();
    none.runs.read = vi.fn(async () => { throw hostError("denied", { reason: "notInResultAction" }); });
    await expect(A(none, "analyze", { runId: "r" })).rejects.toMatchObject({ code: "denied" });
  });
  it("the page shows the connection, model, token estimate, the editable request, document check boxes and the full text", async () => {
    const host = fakeHost();
    const { pages } = registry(plugin);
    const out = await pages.analysis.render(analysisCtx(host));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["info", "connection", "request", "docs", "full"]);
    expect(out.view[1].fields[0]).toMatchObject({ kind: "ref", kinds: ["@implements:onedesk.ai.chat/1"], bind: "body.connectionId" });
    expect(host.resources.list).toHaveBeenCalledWith({ kind: "org.onedesk.ai.x:connection" });
    expect(out.view[0].text).toContain("Connection: Local AI · Model: llama3");
    expect(out.view[0].text).toMatch(/About \d+ tokens/);
    expect(out.view[2].fields[0]).toMatchObject({ kind: "longtext", bind: "body.request" });
    expect(out.view[3].fields[0]).toMatchObject({ kind: "boolean", bind: "body.use0", label: "orders.md" });
    expect(out.view[4].text).toContain("### orders.md");
    expect(host.interfaces.call).not.toHaveBeenCalled();
  });
  it("unticking a document and editing the request change the full text and the estimate at once (the draft counts)", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost();
    const on = await pages.analysis.render(analysisCtx(host));
    const off = await pages.analysis.render(analysisCtx(host, draftBody(), { draft: { "body.use0": "false", "body.request": "short" } }));
    expect(off.view.find((n: any) => n.id === "full").text).toBe("short");
    expect(on.view.find((n: any) => n.id === "full").text).toContain("Doc text");
    const tokens = (o: any) => Number(/About (\d+) tokens/.exec(o.view[0].text)![1]);
    expect(tokens(off)).toBeLessThan(tokens(on));
  });
  it("with policy off or no connection the page says so and nothing is hidden", async () => {
    const { pages } = registry(plugin);
    const off = await pages.analysis.render(analysisCtx(fakeHost({}, { env: { "ai.policy": "off" } })));
    expect(off.view[0]).toMatchObject({ tone: "danger" });
    expect(off.view[0].text).toContain("turned off");
    const none = await pages.analysis.render(analysisCtx(fakeHost({}, { env: { "ai.connection": "" } })));
    expect(none.view[0]).toMatchObject({ tone: "danger" });
    expect(none.view[0].text).toContain("No AI connection");
  });
  it("a run page of an analysis is read only; an answer is shown as Markdown with the model and usage, and the name field only when editable", async () => {
    const { pages } = registry(plugin);
    const body = draftBody({ answer: "**ok**", model: "m", usage: "1 / 2" });
    const live = await pages.analysis.render(analysisCtx(fakeHost(), body));
    expect(live.view.find((n: any) => n.id === "answer")).toMatchObject({ format: "markdown", text: "**ok**" });
    expect(live.view.find((n: any) => n.id === "keep").fields[0]).toMatchObject({ name: "name", param: true });
    const ro = await pages.analysis.render(analysisCtx(fakeHost(), body, { run: { id: "x", resourceId: "a1", input: {}, params: {} } }));
    expect(ro.view.find((n: any) => n.id === "keep")).toBeUndefined();
    expect(ro.view[2].fields[0].readOnly).toBe(true);
    expect(checkView(live.view)).toEqual([]);
  });
  it("the doc page shows the file's text", async () => {
    const out = await registry(plugin).pages.doc.render(ctxOf(fakeHost(), { resource: { id: "d1", body: { path: "/docs/a.md", text: "# A" } } }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[1]).toMatchObject({ text: "# A", format: "markdown" });
  });
});

describe("ai: send (K3, K5, audit)", () => {
  it("sends the edited request plus the ticked documents through the chat interface to the picked connection; stores the answer; audits without content", async () => {
    const host = fakeHost();
    const res = await A(host, "send", { "body.request": "my edit" }, { resource: { id: "a1", body: draftBody() } });
    expect(host.interfaces.call).toHaveBeenCalledTimes(1);
    const [iface, action, input, opts] = host.interfaces.call.mock.calls[0];
    expect([iface, action, opts]).toEqual(["onedesk.ai.chat/1", "chat", { resource: "c1" }]);
    expect(input.messages).toEqual([{ role: "user", text: expect.stringContaining("my edit") }]);
    expect(input.messages[0].text).toContain("Doc text");
    expect(input.system).toContain("data analyst");
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "text", text: "It looks fine." });
    expect(host.resources.update).toHaveBeenCalledWith("a1", expect.objectContaining({ "body.answer": "It looks fine.", "body.model": "claude-haiku-5-5", "body.usage": "100 / 20", "body.connection": "Local AI" }));
    const log = JSON.parse((await host.storage.get("audit"))!);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "analyze", connection: "c1", model: "claude-haiku-5-5", usage: { input: 100, output: 20 } });
    expect(log[0].chars).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toContain("my edit");
    expect(JSON.stringify(log)).not.toContain("Doc text");
  });
  it("an unticked document is not sent", async () => {
    const host = fakeHost();
    await A(host, "send", { "body.use0": "false" }, { resource: { id: "a1", body: draftBody() } });
    expect(host.interfaces.call.mock.calls[0][2].messages[0].text).not.toContain("Doc text");
  });
  it("policy off sends nothing; an empty request sends nothing", async () => {
    const off = fakeHost({}, { env: { "ai.policy": "off" } });
    await expect(A(off, "send", {}, { resource: { id: "a1", body: draftBody() } })).rejects.toThrow("turned off");
    const host = fakeHost();
    await expect(A(host, "send", { "body.request": "  ", "body.use0": "false" }, { resource: { id: "a1", body: draftBody() } })).rejects.toThrow("nothing to send");
    expect(off.interfaces.call).not.toHaveBeenCalled();
    expect(host.interfaces.call).not.toHaveBeenCalled();
  });
  it("provider errors become words for the user; a refusal too; a missing implementation names the connection", async () => {
    const send = (res: any, thrown?: Error) => {
      const host = fakeHost();
      host.interfaces.call = vi.fn(async () => {
        if (thrown) throw thrown;
        return res;
      });
      return A(host, "send", {}, { resource: { id: "a1", body: draftBody() } });
    };
    await expect(send({ error: { code: "auth", message: "bad key" } })).rejects.toThrow("refused the key. bad key");
    await expect(send({ error: { code: "rateLimit", retryAfter: 7 } })).rejects.toThrow("in 7 s");
    await expect(send({ error: { code: "tooLong" } })).rejects.toThrow("too long");
    await expect(send({ error: { code: "weird" } })).rejects.toThrow("failed");
    await expect(send({ text: "", stop: "refusal", model: "m" })).rejects.toThrow("declined");
    await expect(send(null, hostError("invalid", { reason: "wrongInterface" }))).rejects.toThrow("“Local AI” is not an AI connection");
    await expect(send(null, hostError("denied", { reason: "cancelled" }))).rejects.toMatchObject({ code: "denied" });
  });
  it("keep (K6): saves the analysis with the run it came from (D442); without the host call it is an error, not a silent copy", async () => {
    const { pages } = registry(plugin);
    const body = draftBody({ answer: "A", model: "m", usage: "1 / 2", connection: "Local AI", sent: "S" });
    const host = fakeHost({ runs: { saveArtifact: vi.fn(async () => ({ id: "art1" })) } });
    const res = await pages.analysis.onEvent(analysisCtx(host, body, { params: { name: "Q3 look" } }), "keep");
    expect(host.runs.saveArtifact).toHaveBeenCalledWith("run1", { name: "Q3 look", kind: "analysis", data: { request: "S", answer: "A", connection: "Local AI", model: "m", usage: "1 / 2" } });
    expect(onlyKeys(res, ["changes", "params", "message"])).toEqual([]);
    expect(res.message).toContain("with the run");
    const plain = fakeHost();
    await expect(pages.analysis.onEvent(analysisCtx(plain, body, { params: { name: "N" } }), "keep")).rejects.toThrow("cannot attach");
    expect(plain.storage.set).not.toHaveBeenCalled();
    expect((await pages.analysis.onEvent(analysisCtx(plain), "keep")).message).toContain("no answer");
    expect((await pages.analysis.onEvent(analysisCtx(plain, draftBody({ answer: "A", runId: "" })), "keep")).message).toContain("not known");
    await expect(pages.analysis.onEvent(analysisCtx(plain), "nope")).rejects.toThrow();
  });
  it("the audit keeps the last 200 only and never fails the answer", async () => {
    const host = fakeHost();
    for (let i = 0; i < 205; i++) await audit(ctxOf(host), { kind: "analyze", n: i });
    const log = JSON.parse((await host.storage.get("audit"))!);
    expect(log).toHaveLength(200);
    expect(log[199].n).toBe(204);
    const broken = fakeHost({ storage: { get: vi.fn(async () => { throw new Error("x"); }), set: vi.fn() } });
    await expect(audit(ctxOf(broken), {})).resolves.toBeUndefined();
  });
});

describe("ai: generate (K7–K9)", () => {
  const genRaw = (host: Host, input: any = { kind: "sql", instruction: "orders per user", context: { tables: ["orders", { name: "users", columns: ["id", "name"] }] } }) => A(host, "generate", input);
  const gen = async (host: Host, input?: any) => (await genRaw(host, input)).data; // D441: the structured result is `data`
  it("returns readable text in output and the structured result in data (D441); reads a provider's data too", async () => {
    const host = fakeHost({}, { env: { "ai.policy": "allow" } });
    host.interfaces.call = vi.fn(async () => ({ output: { type: "text", text: "words" }, data: { text: "SELECT 1", model: "m", stop: "end" } }));
    const res = await genRaw(host);
    expect(res).toEqual({ output: { type: "text", text: "SELECT 1" }, data: { text: "SELECT 1", model: "m", usage: null, check: { ok: true } } });
    expect(checkActionResult({ output: res.output })).toEqual([]);
    const off = await genRaw(fakeHost({}, { env: { "ai.policy": "off" } }));
    expect(off.output.text).toContain("turned off");
  });
  const allow = { "ai.policy": "allow" };
  it("allow: one chat call from the words and the table names (and relevant documents), no data; returns text, model, usage and the check", async () => {
    const host = fakeHost({}, { env: allow });
    host.interfaces.call = vi.fn(async () => ({ text: "Here:\n```sql\nSELECT o.id FROM orders o;\n```", model: "m", usage: { input: 5, output: 6 }, stop: "end" }));
    const res = await gen(host);
    expect(res).toEqual({ text: "SELECT o.id FROM orders o;", model: "m", usage: { input: 5, output: 6 }, check: { ok: true } });
    const input = host.interfaces.call.mock.calls[0][2];
    expect(input.format).toBe("text");
    expect(input.system).toContain("single SELECT or WITH");
    const text = input.messages[0].text;
    expect(text).toContain("orders per user");
    expect(text).toContain("- users(id, name)");
    expect(text).toContain("- orders");
    expect(text).toContain("Orders hold one row per order."); // a relevant document
    expect(host.resources.search.mock.calls[0][0].query).toBe("orders users id name");
    expect(host.runs.read).not.toHaveBeenCalled();
    expect(JSON.parse((await host.storage.get("audit"))!)[0]).toMatchObject({ kind: "generate", connection: "c1" });
  });
  it("preview (the default): the first call sends nothing and returns the request; with confirm it sends", async () => {
    const host = fakeHost();
    const first = await gen(host);
    expect(first).toMatchObject({ needsPreview: true, connection: "Local AI", model: "llama3" });
    expect(first.request).toContain("orders per user");
    expect(first.tokens).toBeGreaterThan(0);
    expect(host.interfaces.call).not.toHaveBeenCalled();
    const bad = await gen(host, { kind: "sql", instruction: "x", confirm: "yes" });
    expect(bad.needsPreview).toBe(true); // only the boolean true confirms
    host.interfaces.call = vi.fn(async () => ({ text: "SELECT 1", model: "m", stop: "end" }));
    const sent = await gen(host, { kind: "sql", instruction: "x", confirm: true });
    expect(sent).toMatchObject({ text: "SELECT 1", check: { ok: true } });
  });
  it("off: refused with an error value; nothing is sent", async () => {
    const host = fakeHost({}, { env: { "ai.policy": "off" } });
    expect(await gen(host)).toEqual({ error: { code: "policyOff", message: "AI is turned off in this environment." } });
    expect(host.interfaces.call).not.toHaveBeenCalled();
  });
  it("bad input and a missing connection come back as error values, provider errors too", async () => {
    expect((await gen(fakeHost({}, { env: allow }), { kind: "shell", instruction: "x" })).error.code).toBe("badKind");
    expect((await gen(fakeHost({}, { env: allow }), { kind: "sql", instruction: "  " })).error.code).toBe("empty");
    expect((await gen(fakeHost({}, { env: { ...allow, "ai.connection": "" } }))).error.code).toBe("noConnection");
    const host = fakeHost({}, { env: allow });
    host.interfaces.call = vi.fn(async () => ({ error: { code: "overloaded", message: "" } }));
    expect(await gen(host)).toEqual({ error: { code: "chat", message: "The AI service is busy. Try again later." } });
  });
  it("an answer that is not one SELECT/WITH comes back with check.ok false and a reason — it is still only a proposal", async () => {
    const host = fakeHost({}, { env: allow });
    host.interfaces.call = vi.fn(async () => ({ text: "DELETE FROM t", model: "m", stop: "end" }));
    expect((await gen(host)).check).toEqual({ ok: false, reason: "notSelect" });
  });
  it("implements the generate interface with its settings kind (a resource to call through) and uses the chat interface", () => {
    expect(manifest.implements).toEqual({ "onedesk.ai.generate/1": { actions: ["generate"], kind: "settings" } });
    expect(manifest.contributes.kinds.map((k: any) => k.id)).toContain("settings");
    const g = manifest.contributes.actions.find((a: any) => a.id === "generate");
    expect(g.kinds).toBeUndefined();
    expect(g.confirm).toBeNull();
  });
  it("the settings page: a reference field for the default connection (any implementer); the choice is used last", async () => {
    const host = fakeHost({}, { env: { "ai.connection": "" } });
    const out = await registry(plugin).pages.settings.render(ctxOf(host, { resource: { id: "set1", kind: "org.onedesk.ai:settings", body: { connection: "c1" } } }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields[0]).toMatchObject({ kind: "ref", kinds: ["@implements:onedesk.ai.chat/1"], bind: "body.connection" });
    // read order: page, environment, workspace config, then the settings resource
    expect((await pickConnection(ctxOf(host, { resource: { id: "set1", kind: "org.onedesk.ai:settings", body: { connection: "c1" } } }))).id).toBe("c1");
    host.resources.list = vi.fn(async (q: any) => (q.kind === "org.onedesk.ai:settings" ? [{ id: "set1", body: { connection: "c1" } }] : []));
    expect((await pickConnection(ctxOf(host))).id).toBe("c1");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" } })))).rejects.toThrow("No AI connection");
  });
  it("is exported and declared", () => {
    expect(manifest.exports.actions).toEqual(["analyze", "generate"]);
    expect(manifest.contributes.actions.map((a: any) => a.id).sort()).toEqual(["analyze", "generate", "send", "syncDocs"]);
    expect(Object.keys(registry(plugin).actions).sort()).toEqual(["analyze", "generate", "send", "syncDocs"]);
  });
});

describe("ai: the check of a statement (K8)", () => {
  it("accepts one SELECT or WITH, with comments, strings that look like SQL, a trailing semicolon", () => {
    for (const s of ["SELECT 1", "select * from t;", "-- c\nWITH a AS (SELECT 1) SELECT * FROM a", "SELECT 'drop table x; delete' AS s", "SELECT \"update\" FROM t /* insert; */", "SELECT $$a;b$$", "(SELECT 1) UNION (SELECT 2)", "SELECT 1;;  "]) expect(checkSql(s), s).toEqual({ ok: true });
  });
  it("refuses empty, several statements, other statements and anything that writes", () => {
    expect(checkSql("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkSql("-- only a comment")).toEqual({ ok: false, reason: "empty" });
    expect(checkSql("SELECT 1; SELECT 2")).toEqual({ ok: false, reason: "multiple" });
    expect(checkSql("SELECT 1; DROP TABLE t")).toEqual({ ok: false, reason: "multiple" });
    for (const s of ["DELETE FROM t", "UPDATE t SET a = 1", "EXPLAIN SELECT 1", "SHOW ALL", "DROP TABLE t"]) expect(checkSql(s), s).toEqual({ ok: false, reason: "notSelect" });
    for (const s of ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "SELECT * INTO new_t FROM t", "WITH x AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT 1"]) expect(checkSql(s), s).toEqual({ ok: false, reason: "writes" });
  });
  it("extracts the statement from a fenced block, else takes the text", () => {
    expect(extractSql("x\n```sql\nSELECT 1\n```\ny")).toBe("SELECT 1");
    expect(extractSql("```\nSELECT 2\n```")).toBe("SELECT 2");
    expect(extractSql("  SELECT 3  ")).toBe("SELECT 3");
  });
});

describe("ai: manifest and text", () => {
  it("asks for the chat interface, adds the Analyze result action for tables and text, and keeps settings for K10", () => {
    expect(manifest.uses).toEqual(["onedesk.ai.chat/1"]);
    expect(manifest.contributes.resultActions).toEqual([{ id: "analyze", label: "action.analyze", icon: "sparkles", outputTypes: ["table", "text"], action: "analyze" }]);
    expect(manifest.contributes.settings.map((s: any) => s.name)).toEqual(["sensitiveColumns", "maxRows", "maxCell", "docFolder", "docBudget"]);
    expect(manifest.requires).toEqual({ files: true });
  });
  it("names no provider; the plugin has no CSS or TSX; every key the code and manifest use exists in all languages", () => {
    const src = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/anthropic|ollama|claude/i);
    const keys = new Set<string>();
    for (const m of src.matchAll(/\b(?:tr\(ctx, |ctx\.t\()[`"]([\w.]+)[`"]/g)) keys.add(m[1]!);
    for (const m of JSON.stringify(manifest).matchAll(/"((?:plugin|kind|action|tab|setting|doc|analysis)\.[\w.]+)"/g)) keys.add(m[1]!);
    for (const k of keys) for (const L of [EN, ZH, JA]) expect(L[k], k).toBeTruthy();
    // dynamic keys
    for (const k of ["info.policy.off", "info.policy.preview", "info.policy.allow", "error.chat.auth", "error.chat.rateLimit", "error.chat.overloaded", "error.chat.timeout", "error.chat.tooLong", "error.chat.refusal", "error.chat.network", "error.chat.other", "error.connectionMissingEnv", "error.connectionMissingDefault"]) expect(EN[k], k).toBeTruthy();
  });
  it("composes the request: the edit, then the documents under their own heading", () => {
    expect(composeRequest(ctxOf(fakeHost()), "A  \n", [])).toBe("A");
    expect(composeRequest(ctxOf(fakeHost()), "A", [{ name: "n", text: "T" }])).toBe("A\n\n## Reference documents\n\n### n\n\nT");
  });
});
