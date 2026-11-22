import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { audit, buildRequest, checkSql, composeRequest, cleanContext, dropDrafts, estimateTokens, extractSql, isSensitiveColumn, markdownTable, maskText, parseExtra, pickConnection, pickDocs, policyOf, redactTable, searchTerms, syncDocs } from "./main.js";
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
      // another plugin's resource is not readable (the connections come from interfaces.resources)
      get: vi.fn(async (id: string) => bodies.get(id) ?? (id === "d1" ? { id: "d1", body: { text: "Orders hold one row per order." } } : null)),
      list: vi.fn(async () => []),
      search: vi.fn(async (q: any) => (q.ids ? { items: [{ id: q.ids[0], name: "Orders report" }], total: 1 } : [{ id: "d1", kind: "org.onedesk.ai:doc", name: "orders.md", snippet: "Orders hold", score: 3 }])),
      remove: vi.fn(async () => undefined),
      create: vi.fn(async (r: any) => {
        bodies.set("a1", { id: "a1", name: r.name, body: r.body });
        return { id: "a1", name: r.name };
      }),
      update: vi.fn(async () => undefined),
      upsertByKey: vi.fn(async () => ({ ids: {} })),
    },
    interfaces: { call: vi.fn(async () => reply), list: vi.fn(async () => [{ plugin: "org.onedesk.ai.x", kind: "org.onedesk.ai.x:connection", label: "X" }]), resources: vi.fn(async () => [{ id: "c1", name: "Local AI", kind: "org.onedesk.ai.x:connection", fields: { model: "llama3" } }]) },
    files: { roots: vi.fn(async () => [{ path: "/docs" }]), list: vi.fn(async () => ({ entries: [] })), readText: vi.fn(async () => ({ text: "x" })) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: "core:none", locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const A = (host: Host, name: string, input: unknown = {}, extra: Record<string, unknown> = {}) => registry(plugin).actions[name](ctxOf(host, extra), input);
const draftBody = (over: Record<string, string> = {}) => ({ request: "# Analysis request\n\nbody", docs: JSON.stringify([{ id: "d1", name: "orders.md", text: "Doc text", tokens: 3 }]), runId: "run1", answer: "", model: "", usage: "", connection: "", sent: "", use0: "true", ...over });
const analysisCtx = (host: Host, body = draftBody(), extra: Record<string, unknown> = {}) => ctxOf(host, { resource: { id: "a1", name: "Analysis", body }, ...extra });

describe("ai: masking (K4)", () => {
  it("masks whole columns by name: a lower-cased substring of the label or the key; Chinese and Japanese words too; the user's own names", () => {
    for (const n of ["password", "passwordhash", "accessToken", "emailaddress", "Email", "contactEmail", "phone_number", "mobile", "api_key", "secret", "密码", "用户邮箱", "手机号", "身份证号", "银行卡", "電話番号", "パスワード"]) expect(isSensitiveColumn(n, []), n).toBe(true);
    expect(isSensitiveColumn(["c3", "PasswordHash"], [])).toBe(true); // the key counts as well as the label
    expect(isSensitiveColumn(["id", "c0"], [])).toBe(false);
    for (const n of ["id", "name", "created_at", "total", "city", "salary"]) expect(isSensitiveColumn(n, []), n).toBe(false);
    expect(isSensitiveColumn("Salary", parseExtra("Salary, bank_x"))).toBe(true);
    expect(parseExtra(" a, B ;c\n")).toEqual(["a", "b", "c"]);
  });
  it("masks emails and numbers with any separators (cards, phone numbers) in any cell, keeps dates, and cuts cells", () => {
    expect(maskText("write to a.b@c.co now", 200)).toBe("write to [email] now");
    expect(maskText("card 4111 1111 1111 1111!", 200)).toBe("card [number]!");
    for (const ph of ["+81 90-1234-5678", "(415) 555-2671", "138 0013 8000", "+44 (0)20 7946 0958", "13800138000", "010.1234.5678"]) expect(maskText(`call ${ph} now`, 200), ph).toBe("call [number] now");
    expect(maskText("order 1234567", 200)).toBe("order 1234567"); // 7 digits is not long
    expect(maskText("on 2026-11-22 at 10", 200)).toBe("on 2026-11-22 at 10");
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
  it("terms: names first, then column labels, no blanks or duplicates, at most 20", () => {
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
  it("the connection: page, then the environment's ai.connection, then the workspace config, then the setting; says where a stale one came from", async () => {
    expect(await pickConnection(ctxOf(fakeHost()))).toEqual({ id: "c1", name: "Local AI", model: "llama3" });
    expect(await pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" } })), "c1")).toMatchObject({ id: "c1" }); // the page's own choice
    const cfg = fakeHost({}, { env: { "ai.connection": "" }, cfg: { "ai.connection": "c1" }, settings: { connection: "ghost" } });
    expect((await pickConnection(ctxOf(cfg))).id).toBe("c1");
    expect(cfg.params.config).toHaveBeenCalledWith("ai.connection");
    expect((await pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" }, settings: { connection: "c1" } })))).id).toBe("c1");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" } })))).rejects.toThrow("No AI connection");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "ghost" } })))).rejects.toThrow("(from the environment) was not found");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" }, cfg: { "ai.connection": "ghost2" } })))).rejects.toThrow("(the workspace default) was not found");
    await expect(pickConnection(ctxOf(fakeHost({}, { env: { "ai.connection": "" }, settings: { connection: "ghost3" } })))).rejects.toThrow("(from the AI workbench settings) was not found");
  });
  it("connections come only from interfaces.resources (never resources.get/list of another plugin); a name works too; none when the host cannot say", async () => {
    const host = fakeHost({}, { env: { "ai.connection": "My AI" } });
    host.interfaces.resources = vi.fn(async () => [{ id: "c9", name: "My AI", kind: "x:connection", fields: {} }]);
    expect((await pickConnection(ctxOf(host))).id).toBe("c9");
    expect(host.interfaces.resources).toHaveBeenCalledWith("onedesk.ai.chat/1");
    expect(host.resources.list).not.toHaveBeenCalled();
    expect((await pickConnection(ctxOf(host))).model).toBe("");
    host.interfaces.resources = vi.fn(async () => { throw hostError("denied"); });
    await expect(pickConnection(ctxOf(host))).rejects.toThrow("was not found");
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
    const body = host.resources.create.mock.calls.map((c: any) => c[0]).find((r: any) => r.kind === "analysis").body;
    expect(body.request).toContain("Masked columns: Email, apiKey");
    expect(body.request).not.toMatch(/a@b\.com|4111/);
    expect(body.runId).toBe("run1");
    expect(body.answer).toBeUndefined();
    // documents by the producer's name (not another plugin's body) and the result's columns
    expect(host.resources.get).not.toHaveBeenCalledWith("q1");
    expect(host.resources.search.mock.calls[0][0]).toEqual({ ids: ["q1"], limit: 1 });
    const docSearch = host.resources.search.mock.calls[1][0];
    expect(docSearch).toMatchObject({ mode: "any", rank: "relevance", kinds: ["org.onedesk.ai:doc"] });
    expect(docSearch.query.split(" ").slice(0, 2)).toEqual(["Orders", "report"]);
    expect(JSON.parse(body.docs)[0]).toMatchObject({ id: "d1", name: "orders.md" });
  });
  it("the click stores a draft with the run first (a page event may save only where the plugin already has something)", async () => {
    const host = fakeHost({ runs: { read: vi.fn(async () => ({ output: table, meta: { plugin: "p", kind: "query", resource: "q1", at: 1 } })), saveArtifact: vi.fn(async () => ({ id: "dr1" })) } });
    await A(host, "analyze", { runId: "run1" });
    expect(host.runs.saveArtifact).toHaveBeenCalledWith("run1", { name: "Analysis draft", kind: "analysis-draft", data: { analysis: "a1", request: expect.stringContaining("Analysis request") } });
    // without the host call the draft still opens
    const plain = fakeHost();
    await expect(A(plain, "analyze", { runId: "run1" })).resolves.toBeTruthy();
  });
  it("uses the settings for rows, cell length and the user's sensitive columns", async () => {
    const host = fakeHost({}, { settings: { maxRows: "1", maxCell: "5", sensitiveColumns: "note" } });
    await A(host, "analyze", { runId: "run1" });
    const req = host.resources.create.mock.calls.map((c: any) => c[0]).find((r: any) => r.kind === "analysis").body.request;
    expect(req).toContain("Only the first 1 of 2 rows");
    expect(req).toContain("Masked columns: Email, note, apiKey");
  });
  it("is refused when the environment says off; without a run there is nothing to analyze", async () => {
    await expect(A(fakeHost({}, { env: { "ai.policy": "off" } }), "analyze", { runId: "r" })).rejects.toThrow("(ai.policy = off), so nothing was read or sent");
    const off = fakeHost({}, { env: { "ai.policy": "off" } });
    await expect(A(off, "analyze", { runId: "r" })).rejects.toThrow();
    expect(off.runs.read).not.toHaveBeenCalled();
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
    expect(out.view.map((n: any) => n.id)).toEqual(["info", "connection", "system", "request", "docs", "full"]);
    expect(out.view[1].fields[0]).toMatchObject({ kind: "ref", kinds: ["@implements:onedesk.ai.chat/1"], bind: "body.connectionId" });
    expect(out.view[1].fields[0].options).toBeUndefined(); // the host fills the list
    expect(out.view[2].text).toContain("System prompt");
    expect(out.view[2].text).toContain("data analyst");
    expect(out.view[0].text).toContain("Connection: Local AI · Model: llama3");
    expect(out.view[0].text).toMatch(/About \d+ tokens/);
    expect(out.view[3].fields[0]).toMatchObject({ kind: "longtext", bind: "body.request" });
    expect(out.view[4].fields[0]).toMatchObject({ kind: "boolean", bind: "body.use0", label: "orders.md" });
    expect(out.view[5].text).toContain("### orders.md");
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
    const body = draftBody();
    const hostA = fakeHost();
    await hostA.storage.set("last:a1", JSON.stringify({ answer: "**ok**", model: "m", usage: "1 / 2", connection: "Local AI", sent: "S" }));
    const live = await pages.analysis.render(analysisCtx(hostA, body));
    expect(live.view.find((n: any) => n.id === "answer")).toMatchObject({ format: "markdown", text: "**ok**" });
    expect(live.view.find((n: any) => n.id === "keep").fields[0]).toMatchObject({ name: "name", param: true });
    const ro = await pages.analysis.render(analysisCtx(hostA, body, { run: { id: "x", resourceId: "a1", input: {}, params: {} } }));
    expect(ro.view.find((n: any) => n.id === "keep")).toBeUndefined();
    expect(ro.view[3].fields[0].readOnly).toBe(true);
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
    expect(checkActionResult({ ...res, output: { type: res.output.type, text: res.output.text } })).toEqual([]);
    expect(res.output).toEqual({ type: "text", text: "It looks fine.", format: "markdown" });
    // the answer is NOT written into the resource (the index reads bodies): it waits in the plugin's storage
    expect(host.resources.update).not.toHaveBeenCalled();
    expect(JSON.parse((await host.storage.get("last:a1"))!)).toMatchObject({ answer: "It looks fine.", model: "claude-haiku-5-5", usage: "100 / 20", connection: "Local AI" });
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
  it("keep (K6): saves the analysis with the run it came from (D442), drops the draft, and only then forgets the stored answer; without the host call it is an error", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost({ runs: { saveArtifact: vi.fn(async () => ({ id: "art1" })), listArtifacts: vi.fn(async () => [{ id: "dr1", kind: "analysis-draft" }, { id: "x", kind: "analysis" }]), deleteArtifact: vi.fn(async () => null) } });
    await host.storage.set("last:a1", JSON.stringify({ answer: "A", model: "m", usage: "1 / 2", connection: "Local AI", sent: "S" }));
    const res = await pages.analysis.onEvent(analysisCtx(host, draftBody(), { params: { name: "Q3 look" } }), "keep");
    expect(host.runs.saveArtifact).toHaveBeenCalledWith("run1", { name: "Q3 look", kind: "analysis", data: { system: expect.stringContaining("data analyst"), request: "S", answer: "A", connection: "Local AI", model: "m", usage: "1 / 2" } });
    expect(host.runs.deleteArtifact).toHaveBeenCalledTimes(1);
    expect(host.runs.deleteArtifact).toHaveBeenCalledWith("dr1");
    expect(await host.storage.get("last:a1")).toBeNull();
    expect(onlyKeys(res, ["changes", "params", "message"])).toEqual([]);
    expect(res.message).toContain("with the run");
    const plain = fakeHost();
    await plain.storage.set("last:a1", JSON.stringify({ answer: "A" }));
    await expect(pages.analysis.onEvent(analysisCtx(plain, draftBody(), { params: { name: "N" } }), "keep")).rejects.toThrow("cannot attach");
    expect(await plain.storage.get("last:a1")).not.toBeNull(); // nothing is lost when saving fails
    expect((await pages.analysis.onEvent(analysisCtx(fakeHost()), "keep")).message).toContain("no answer");
    expect((await pages.analysis.onEvent(analysisCtx(plain, draftBody({ runId: "" })), "keep")).message).toContain("not known");
    await expect(pages.analysis.onEvent(analysisCtx(plain), "nope")).rejects.toThrow();
    await expect(dropDrafts(ctxOf(fakeHost()), "r")).resolves.toBeUndefined();
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
    expect(res).toEqual({ output: { type: "text", text: "SELECT 1", format: "markdown" }, data: { text: "SELECT 1", model: "m", usage: null, check: { ok: true } } });
    expect(checkActionResult({ output: { type: res.output.type, text: res.output.text } })).toEqual([]);
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
  it("preview (the default): the workbench makes the draft and its own page shows it; nothing is sent; the caller cannot send it (confirm is ignored)", async () => {
    const host = fakeHost();
    const first = await gen(host);
    expect(first).toMatchObject({ needsPreview: true, draft: "a1", connection: "Local AI", model: "llama3" });
    expect(first.request).toContain("orders per user");
    expect(first.system).toContain("single SELECT or WITH");
    expect(first.tokens).toBeGreaterThan(0);
    expect(host.interfaces.call).not.toHaveBeenCalled();
    const draft = host.resources.create.mock.calls[0][0];
    expect(draft).toMatchObject({ kind: "analysis", body: { mode: "sql", request: first.request, system: first.system } });
    for (const confirm of [true, "yes", first.draft]) {
      const again = await gen(host, { kind: "sql", instruction: "x", confirm });
      expect(again.needsPreview).toBe(true);
    }
    expect(host.interfaces.call).not.toHaveBeenCalled();
  });
  it("the user sends the draft on the workbench page: exactly the stored text and system go out (edits and input are ignored); the proposal waits for fetch", async () => {
    const host = fakeHost();
    const first = await gen(host);
    const body = host.resources.create.mock.calls[0][0].body;
    host.interfaces.call = vi.fn(async () => ({ data: { text: "```sql\nSELECT 1\n```", model: "m", usage: { input: 1, output: 2 }, stop: "end" } }));
    const res = await A(host, "send", { "body.request": "SMUGGLED rows: a@b.com" }, { resource: { id: first.draft, body } });
    const sent = host.interfaces.call.mock.calls[0][2];
    expect(sent.messages[0].text).toBe(body.request);
    expect(sent.system).toBe(body.system);
    expect(sent.format).toBe("text");
    expect(res.output.text).toBe("SELECT 1");
    expect(res.output.format).toBe("markdown");
    expect(host.resources.update).not.toHaveBeenCalled();
    // not asked for yet → fetch says it is pending for another draft; then gives the proposal once and removes the draft
    expect(await gen(host, { fetch: "other" })).toEqual({ pending: true });
    expect(await gen(host, { fetch: first.draft })).toEqual({ text: "SELECT 1", model: "m", usage: { input: 1, output: 2 }, check: { ok: true } });
    expect(host.resources.remove).toHaveBeenCalledWith(first.draft);
    expect(await gen(host, { fetch: first.draft })).toEqual({ pending: true });
    // the draft page is read only
    const page = await registry(plugin).pages.analysis.render(ctxOf(host, { resource: { id: first.draft, body } }));
    expect(page.view.find((n: any) => n.id === "request").fields[0].readOnly).toBe(true);
    expect(page.view.find((n: any) => n.id === "system").text).toContain("single SELECT or WITH");
  });
  it("only names go out: a long instruction is cut and masked, tables and columns must look like names", () => {
    const c = cleanContext({ instruction: `mail a@b.com ${"x".repeat(2000)}`, context: { tables: ["orders", "1; DROP TABLE x", { name: "users", columns: ["id", "a b", "name"] }, { name: "x y" }] } });
    expect(c.instruction.startsWith("mail [email] ")).toBe(true);
    expect(c.instruction.length).toBeLessThanOrEqual(1001);
    expect(c.tables).toEqual([{ name: "orders", columns: [] }, { name: "users", columns: ["id", "name"] }]);
    expect(cleanContext({ instruction: "x", context: { tables: Array.from({ length: 80 }, (_, i) => `t${i}`) } }).tables).toHaveLength(50);
    expect(cleanContext({ instruction: " " }).instruction).toBe("");
  });
  it("off: refused with an error value; nothing is sent", async () => {
    const host = fakeHost({}, { env: { "ai.policy": "off" } });
    expect((await gen(host)).error).toMatchObject({ code: "policyOff", message: expect.stringContaining("turned off") });
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
  it("implements the generate interface without a kind (no anchor resource, D445) and uses the chat interface; reads other resources only through its own permission", () => {
    expect(manifest.implements).toEqual({ "onedesk.ai.generate/1": { actions: ["generate"] } });
    expect(manifest.activation).toBeUndefined();
    expect(manifest.contributes.kinds.map((k: any) => k.id)).toEqual(["analysis", "doc"]);
    expect(manifest.requires).toEqual({ files: true, resources: true });
    const g = manifest.contributes.actions.find((a: any) => a.id === "generate");
    expect(g.kinds).toBeUndefined();
    expect(g.confirm).toBeNull();
  });
  it("the default connection is a resource setting of the plugin that accepts any implementer of the chat interface", () => {
    const st = manifest.contributes.settings.find((x: any) => x.name === "connection");
    expect(st).toMatchObject({ type: "resource", kinds: ["@implements:onedesk.ai.chat/1"], default: "" });
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
  it("refuses functions with side effects (PostgreSQL semantics), also when written in capitals or with a schema", () => {
    for (const s of ["SELECT pg_terminate_backend(1)", "select nextval('s')", "SELECT setval('s', 1)", "SELECT pg_sleep(100)", "SELECT lo_unlink(1)", "SELECT * FROM dblink('x','y') AS t(a int)", "SELECT pg_catalog.set_config('a','b',false)", "SELECT pg_read_file('x')", "SELECT pg_advisory_lock(1)"]) expect(checkSql(s), s).toEqual({ ok: false, reason: "sideEffects" });
    expect(checkSql("SELECT 'pg_sleep(1)' AS s, count(*) FROM t")).toEqual({ ok: true }); // inside a string it is only text
    expect(checkSql("SELECT lower(a), now() FROM t")).toEqual({ ok: true });
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
    expect(manifest.contributes.settings.map((s: any) => s.name)).toEqual(["connection", "sensitiveColumns", "maxRows", "maxCell", "docFolder", "docBudget"]);
    expect(manifest.requires).toEqual({ files: true, resources: true });
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
