import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { forbiddenName, freeQueryProblem, tableRows, getChunked, putChunked, rememberSent, sentOf, snapshot, atSql, changesSql, currentSql, deletedSql, existingSet, historySql, isMissing, prefixesOf, rowsSql, selectList, timeLiteral, treeChildren, treePath } from "./main.js";
import { checkActionResult, checkView, hostError, onlyKeys, registry, RENDER_KEYS, TREE_NODE_KEYS } from "../../plugins/_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

type Host = Record<string, any>;

// The mapping as the catalog's `mapping` action returns it (normalized).
const ORDERS = {
  table: "shop.order_line",
  description: "Order lines, one row per version",
  columns: { id: { column: "line_id", description: "" }, qty: { column: "qty", description: "pieces" }, from: { column: "valid_from", description: "" } },
  versioned: { key: ["line_id"], from: "valid_from", to: "valid_to", deleted: "is_deleted" },
};
const PLAIN = { table: "customer", description: "", columns: { name: { column: "Full Name", description: "" } } };
const MAPPING = {
  path: "/work/mapping.yaml",
  problem: "",
  entities: {
    line: ORDERS,
    lineTax: { table: "shop.order_line_tax", description: "", columns: {} },
    order: { table: "shop.order_head", description: "", columns: {} },
    customer: PLAIN,
    ghost: { table: "shop.ghost", description: "", columns: {} },
    pricing: { table: "price_list", description: "", columns: {}, versioned: { key: ["sku", "region"], from: "valid_from" } },
  },
};
const DB_TABLES = [
  ["shop", "order_line"],
  ["shop", "order_line_tax"],
  ["shop", "order_head"],
  ["public", "customer"],
  ["public", "price_list"],
];

function fakeHost(over: Host = {}) {
  const store = new Map<string, string>();
  const host: Host = {
    storage: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        // the kernel's limits (host.rs): 256 KB a value, 1000 keys
        if (JSON.stringify(v).length > 256 * 1024) throw hostError("invalid", { reason: "tooLarge" });
        if (!store.has(k) && store.size >= 1000) throw hostError("invalid", { reason: "tooManyKeys" });
        store.set(k, v);
      }),
      remove: vi.fn(async (k: string) => void store.delete(k)),
    },
    params: {
      get: vi.fn(async (n: string) => (n === "datasource" ? { found: true, value: "Prod", sourceName: "dev" } : { found: false, value: "" })),
      config: vi.fn(async () => ({ found: false, value: "" })),
    },
    resources: { list: vi.fn(async () => [{ id: "s1", name: "Prod" }]) },
    actions: {
      call: vi.fn(async (id: string, input: any) => {
        if (id === "org.onedesk.catalog:mapping") return { output: { type: "text", text: JSON.stringify(MAPPING) } };
        if (input.sql.includes("information_schema.tables")) return { output: { type: "table", columns: [{ key: "c0", label: "s" }, { key: "c1", label: "t" }], rows: DB_TABLES, total: DB_TABLES.length } };
        return { output: { type: "table", columns: [{ key: "c0", label: "x" }], rows: [["1"]], total: 1 }, summary: { message: "1 row" } };
      }),
    },
    ...over,
  };
  return { host, store };
}
// Like the kernel (D421): `actions.call` only inside a run, i.e. when the ctx has a runId.
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => {
  const inRun = typeof extra.runId === "string";
  const call = (...a: unknown[]) => (inRun ? host.actions.call(...a) : Promise.reject(hostError("denied", { reason: "notInRun" })));
  return { locale: "en-US", host: { ...host, actions: { ...host.actions, call } }, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra };
};
// Runs the refresh action, as the user does from the overview page.
const refreshed = async (host: Host) => registry(plugin).actions.refresh(ctxOf(host, { runId: "refresh-1" }), {});
const nodeCtx = (host: Host, key: string, extra: Record<string, unknown> = {}) => ctxOf(host, { target: `node:org.onedesk.table:tables/${encodeURIComponent(key)}`, node: { tree: "org.onedesk.table:tables", key }, ...extra });

describe("table: SQL of the five version queries (H5)", () => {
  it("1. current version: latest per key, still in force now, not deleted", () => {
    expect(currentSql(ORDERS, ["id", "qty"], 50)).toBe(
      "SELECT line_id AS id, qty FROM (SELECT DISTINCT ON (line_id) * FROM shop.order_line WHERE valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) ORDER BY line_id, valid_from DESC) AS od_v WHERE NOT od_v.is_deleted LIMIT 50",
    );
  });

  it("2. history of one record: every version, oldest first; compound keys take comma-separated values", () => {
    expect(historySql(ORDERS, [], "L-1")).toBe("SELECT * FROM shop.order_line WHERE line_id = 'L-1' ORDER BY valid_from");
    expect(historySql(MAPPING.entities.pricing, [], "A'1, eu")).toBe("SELECT * FROM price_list WHERE sku = 'A''1' AND region = 'eu' ORDER BY valid_from");
    expect(() => historySql(ORDERS, [], "")).toThrow();
    expect(() => historySql(MAPPING.entities.pricing, [], "only-one")).toThrow();
  });

  it("3. state at a moment (UTC)", () => {
    expect(atSql(ORDERS, [], "2026-01-02T03:04", undefined)).toBe(
      "SELECT * FROM (SELECT DISTINCT ON (line_id) * FROM shop.order_line WHERE valid_from <= CAST('2026-01-02T03:04:00Z' AS timestamptz) AND (valid_to IS NULL OR valid_to > CAST('2026-01-02T03:04:00Z' AS timestamptz)) ORDER BY line_id, valid_from DESC) AS od_v WHERE NOT od_v.is_deleted LIMIT 100",
    );
    expect(atSql(MAPPING.entities.pricing, [], "2026-01-02", 10)).toBe(
      "SELECT * FROM (SELECT DISTINCT ON (sku, region) * FROM price_list WHERE valid_from <= CAST('2026-01-02T00:00:00Z' AS timestamptz) ORDER BY sku, region, valid_from DESC) AS od_v LIMIT 10",
    );
    expect(() => atSql(ORDERS, [], "yesterday'; DROP", 1)).toThrow();
  });

  it("4. changes in a period: versions that started in [from, to)", () => {
    expect(changesSql(ORDERS, ["from", "qty"], "2026-01-01T00:00", "2026-02-01T00:00Z", 20)).toBe(
      "SELECT valid_from AS \"from\", qty FROM shop.order_line WHERE valid_from >= CAST('2026-01-01T00:00:00Z' AS timestamptz) AND valid_from < CAST('2026-02-01T00:00Z' AS timestamptz) ORDER BY valid_from, line_id LIMIT 20",
    );
    expect(() => changesSql(ORDERS, [], "2026-01-01", "", 1)).toThrow();
  });

  it("5. deleted records: the latest version is a deletion, or has ended when there is no flag", () => {
    expect(deletedSql(ORDERS, [], 5)).toBe("SELECT * FROM (SELECT DISTINCT ON (line_id) * FROM shop.order_line ORDER BY line_id, valid_from DESC) AS od_v WHERE od_v.is_deleted LIMIT 5");
    const ended = { ...ORDERS, versioned: { key: ["line_id"], from: "valid_from", to: "valid_to" } };
    expect(deletedSql(ended, [], 5)).toBe("SELECT * FROM (SELECT DISTINCT ON (line_id) * FROM shop.order_line ORDER BY line_id, valid_from DESC) AS od_v WHERE od_v.valid_to IS NOT NULL AND od_v.valid_to <= now() LIMIT 5");
    expect(() => deletedSql(MAPPING.entities.pricing, [], 5)).toThrow();
  });

  it("only versioned tables have version queries; rows works on any", () => {
    expect(() => currentSql(PLAIN, [], 1)).toThrow();
    expect(rowsSql(PLAIN, ["name"], "abc")).toBe('SELECT "Full Name" AS name FROM customer LIMIT 100');
    expect(rowsSql(PLAIN, [], 999999999)).toBe("SELECT * FROM customer LIMIT 100000");
    expect(selectList(PLAIN, ["nope"])).toBe("*");
    expect(timeLiteral("2026-01-02T03:04:05+09:00")).toBe("CAST('2026-01-02T03:04:05+09:00' AS timestamptz)");
  });
});

describe("table: tree (H1–H3)", () => {
  const snap = { mapping: MAPPING, existing: [...existingSet(DB_TABLES)] };

  it("groups tables by name prefix, one level", () => {
    const root = treeChildren(snap, "", 1);
    expect(root.map((n: any) => n.key)).toEqual(["g:order", "g:price", "t:customer", "t:ghost"]);
    for (const n of root) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
    expect(treeChildren(snap, "g:order", 1).map((n: any) => n.label)).toEqual(["order_head", "order_line", "order_line_tax"]);
  });

  it("two levels split the second prefix as well", () => {
    expect(treeChildren(snap, "", 2).map((n: any) => n.key)).toEqual(["g:order", "g:price", "t:customer", "t:ghost"]);
    // a table sits under all but the last segment of its name: order_line under order, order_line_tax under order_line
    expect(treeChildren(snap, "g:order", 2).map((n: any) => n.key)).toEqual(["g:order_line", "t:order", "t:line"]);
    expect(treeChildren(snap, "g:order_line", 2).map((n: any) => n.key)).toEqual(["t:lineTax"]);
    expect(prefixesOf("shop.order_line_tax", 2)).toEqual(["order", "order_line"]);
    expect(prefixesOf("customer", 2)).toEqual([]);
  });

  it("table nodes open the table page and list their columns; the entity name is the badge", () => {
    const line = treeChildren(snap, "g:order", 1).find((n: any) => n.key === "t:line");
    expect(line).toEqual({ key: "t:line", label: "order_line", icon: "history", expandable: true, target: "node:org.onedesk.table:tables/t%3Aline", badge: "line" });
    expect(treeChildren(snap, "t:line", 1)).toEqual([
      { key: "c:line.id", label: "id", icon: "columns-3", expandable: false, target: "node:org.onedesk.table:tables/t%3Aline", badge: "line_id" },
      { key: "c:line.qty", label: "qty", icon: "columns-3", expandable: false, target: "node:org.onedesk.table:tables/t%3Aline" },
      { key: "c:line.from", label: "from", icon: "columns-3", expandable: false, target: "node:org.onedesk.table:tables/t%3Aline", badge: "valid_from" },
    ]);
  });

  it("marks tables the database does not have as missing; without a database nothing is marked", () => {
    const ghost = treeChildren(snap, "", 1, "gone").find((n: any) => n.key === "t:ghost");
    expect(ghost).toEqual({ key: "t:ghost", label: "ghost", icon: "triangle-alert", expandable: false, target: "node:org.onedesk.table:tables/t%3Aghost", badge: "gone" });
    const marked = (s: any) => treeChildren(s, "", 1).filter((n: any) => n.icon === "triangle-alert").map((n: any) => n.key);
    expect(marked(snap)).toEqual(["t:ghost"]);
    expect(marked({ mapping: MAPPING, existing: null })).toEqual([]);
    expect(isMissing({ table: "price_list" }, existingSet(DB_TABLES))).toBe(false);
    expect(isMissing({ table: "public.customer" }, existingSet(DB_TABLES))).toBe(false);
    // review #10: names keep their case — a query quotes `Order_Head`, so only that exact name exists
    expect(isMissing({ table: "SHOP.Order_Head" }, existingSet(DB_TABLES))).toBe(true);
    expect(isMissing({ table: "Orders" }, existingSet([["public", "orders"]]))).toBe(true);
    expect(isMissing({ table: "Orders" }, existingSet([["public", "Orders"]]))).toBe(false);
  });

  it("paths from the root", () => {
    expect(treePath(snap, "t:lineTax", 2)).toEqual(["g:order", "g:order_line", "t:lineTax"]);
    expect(treePath(snap, "c:line.qty", 1)).toEqual(["g:order", "t:line", "c:line.qty"]);
    expect(treePath(snap, "g:order_line", 2)).toEqual(["g:order", "g:order_line"]);
  });

  it("outside a run nothing is fetched: the tree asks for a refresh (D421)", async () => {
    const { host } = fakeHost();
    const reg = registry(plugin);
    const out = await reg.trees.tables.children(ctxOf(host), "");
    expect(out.nodes).toEqual([{ key: "none", label: EN["tree.notLoaded"], icon: "refresh-cw", expandable: false, target: "page:org.onedesk.table/overview" }]);
    expect((await reg.trees.tables.children(ctxOf(host), "g:order")).nodes).toEqual([]);
    expect(await reg.commands.refresh(ctxOf(host), {})).toEqual([{ type: "open", target: "page:org.onedesk.table/overview" }]);
    const page = await reg.pages.overview.render(ctxOf(host));
    expect(checkView(page.view)).toEqual([]);
    expect(page.view.map((n: any) => n.id)).toEqual(["about", "none"]);
    const table = await reg.pages.table.render(nodeCtx(host, "t:line"));
    expect(table.view.map((n: any) => n.text)).toEqual([EN["overview.none"]]);
    expect(host.actions.call).not.toHaveBeenCalled();
  });

  it("the refresh action reads the mapping and the database in its run; the tree then reads the stored snapshot, and the toolbar switches the depth (X9)", async () => {
    const { host } = fakeHost();
    const reg = registry(plugin);
    const res = await refreshed(host);
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.text).toBe("6 tables read, 1 missing in the database");
    expect(host.actions.call.mock.calls[0]).toEqual(["org.onedesk.catalog:mapping", {}]);
    expect(host.actions.call.mock.calls[1][2]).toEqual({ resource: "s1" });
    const calls = host.actions.call.mock.calls.length;
    const one = await reg.trees.tables.children(ctxOf(host), "");
    expect(one.nodes.find((n: any) => n.key === "t:ghost").badge).toBe("missing");
    expect((await reg.trees.tables.children(ctxOf(host), "g:order")).nodes.map((n: any) => n.key)).toEqual(["t:order", "t:line", "t:lineTax"]);
    expect(await reg.commands.toggleDepth(ctxOf(host), {})).toEqual([{ type: "toast", message: EN["message.depth2"], tone: "info" }]);
    expect((await reg.trees.tables.children(ctxOf(host), "g:order")).nodes.map((n: any) => n.key)).toEqual(["g:order_line", "t:order", "t:line"]);
    expect(await reg.trees.tables.path(ctxOf(host), "t:lineTax")).toEqual(["g:order", "g:order_line", "t:lineTax"]);
    await reg.commands.toggleDepth(ctxOf(host), {});
    expect(await reg.trees.tables.path(ctxOf(host), "t:lineTax")).toEqual(["g:order", "t:lineTax"]);
    expect(host.actions.call.mock.calls.length).toBe(calls); // tree and commands fetch nothing
    expect(manifest.contributes.trees[0].toolbar).toEqual(["toggleDepth", "refresh"]);
    const overview = await reg.pages.overview.render(ctxOf(host));
    expect(overview.view.find((n: any) => n.id === "summary").text).toBe("6 tables read, 1 missing in the database");
  });

  it("without a data source the snapshot has the mapping and marks nothing missing", async () => {
    const { host } = fakeHost();
    host.params.get = vi.fn(async () => ({ found: false, value: "" }));
    expect((await refreshed(host)).output.text).toBe("6 tables read; no data source to compare with");
    const out = await registry(plugin).trees.tables.children(ctxOf(host), "");
    expect(out.nodes.some((n: any) => n.icon === "triangle-alert")).toBe(false);
  });

  it("asks the data source for the rows themselves; a data file instead of rows marks nothing missing (e2e ⑤)", async () => {
    const { host } = fakeHost();
    await refreshed(host);
    expect(host.actions.call.mock.calls[1][1]).toEqual({ sql: expect.stringContaining("information_schema.tables"), inline: true, maxRows: 10000 });
    const call = host.actions.call;
    // a data source without inline results answers with a file handle in its own folder, which this plugin cannot read
    host.actions.call = vi.fn(async (id: string, input: any, o: any) => (id.endsWith(":query") ? { output: { type: "table", file: "tmp/q-1.csv", header: true } } : call(id, input, o)));
    const res = await refreshed(host);
    expect(res.output.text).toBe("6 tables read; no data source to compare with");
    const reg = registry(plugin);
    expect((await reg.trees.tables.children(ctxOf(host), "")).nodes.some((n: any) => n.icon === "triangle-alert")).toBe(false);
    const page = await reg.pages.overview.render(ctxOf(host));
    expect(page.view.find((n: any) => n.id === "error").text).toContain(EN["error.noRows"]);
  });

  it("a database that cannot be read marks nothing missing and says why on the overview", async () => {
    const { host } = fakeHost();
    const call = host.actions.call;
    host.actions.call = vi.fn(async (id: string, input: any, o: any) => (id.endsWith(":query") ? Promise.reject(new Error("connection refused")) : call(id, input, o)));
    await refreshed(host);
    const page = await registry(plugin).pages.overview.render(ctxOf(host));
    expect(page.view.find((n: any) => n.id === "error").text).toContain("connection refused");
  });

  it("a large snapshot is stored in chunks under the 256 KB value limit (review #11)", async () => {
    const { host, store } = fakeHost();
    const ctx = ctxOf(host);
    const big = "é\"".repeat(150000); // escapes make it bigger in JSON
    await putChunked(ctx, "snapshot", big);
    expect(await getChunked(ctx, "snapshot")).toBe(big);
    expect(store.has("snapshot.2")).toBe(true);
    await putChunked(ctx, "snapshot", "small");
    expect(await getChunked(ctx, "snapshot")).toBe("small");
    expect(store.has("snapshot.1")).toBe(false);
    store.set("snapshot.0", "torn");
    expect(await getChunked(ctx, "snapshot")).toBeNull();
    expect(await snapshot(ctx)).toBeNull();
    await expect(putChunked(ctx, "snapshot", "x".repeat(100000 * 41))).rejects.toThrow("too large");
  });
});

describe("table: page and actions (H4, H5)", () => {
  it("shows description, source, columns to tick and the version inputs", async () => {
    const { host } = fakeHost();
    await refreshed(host);
    const out = await registry(plugin).pages.table.render(nodeCtx(host, "t:line"));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.title).toBe("order_line");
    expect(out.view.find((n: any) => n.id === "description").text).toBe("Order lines, one row per version");
    expect(out.view.find((n: any) => n.id === "facts").text).toBe("Mapping: /work/mapping.yaml · entity line → shop.order_line\nTime-versioned · key line_id · from valid_from · to valid_to · deleted is_deleted");
    const cols = out.view.find((n: any) => n.id === "columns");
    expect(cols.fields.map((f: any) => [f.name, f.kind, f.param, f.hint])).toEqual([
      ["col.id", "boolean", true, "line_id"],
      ["col.qty", "boolean", true, "pieces"],
      ["col.from", "boolean", true, "valid_from"],
    ]);
    expect(out.view.find((n: any) => n.id === "inputs").fields.map((f: any) => f.name)).toEqual(["limit", "key", "at", "from", "to"]);
  });

  it("a missing or plain table says so", async () => {
    const { host } = fakeHost();
    const reg = registry(plugin);
    await refreshed(host);
    const ghost = await reg.pages.table.render(nodeCtx(host, "t:ghost"));
    expect(ghost.view.find((n: any) => n.id === "missing")).toMatchObject({ tone: "danger", text: "shop.ghost is in the mapping but not in the database" });
    const plain = await reg.pages.table.render(nodeCtx(host, "t:customer"));
    expect(plain.view.find((n: any) => n.id === "plain")).toBeTruthy();
    expect(plain.view.find((n: any) => n.id === "inputs").fields.map((f: any) => f.name)).toEqual(["limit"]);
    await expect(reg.pages.table.render(nodeCtx(host, "t:nope"))).rejects.toThrow("nope is not in the mapping");
  });

  it("fetch rows uses the ticked columns; each version action sends its SQL and keeps it for the run", async () => {
    const { host, store } = fakeHost();
    const reg = registry(plugin);
    const res = await reg.actions.rows(nodeCtx(host, "t:line", { runId: "r1", params: { "col.qty": "true", "col.id": "false", limit: "7" } }), {});
    expect(checkActionResult(res)).toEqual([]);
    const last = () => host.actions.call.mock.calls[host.actions.call.mock.calls.length - 1];
    expect(last()).toEqual(["org.onedesk.datasource:query", { sql: "SELECT qty FROM shop.order_line LIMIT 7" }, { resource: "s1" }]);
    expect(await sentOf(ctxOf(host), "r1")).toBe("SELECT qty FROM shop.order_line LIMIT 7");
    expect([...store.keys()].filter((k) => k.startsWith("sent"))).toEqual(["sent"]);
    const tab = await reg.pages.table.renderResultTab(nodeCtx(host, "t:line", { run: { id: "r1" } }), "sent");
    expect(tab[0].text).toBe("SELECT qty FROM shop.order_line LIMIT 7");

    const p = { key: "L-1", at: "2026-01-02T03:04", from: "2026-01-01T00:00", to: "2026-02-01T00:00" };
    const expected: Record<string, string> = {
      current: currentSql(ORDERS, [], undefined),
      history: historySql(ORDERS, [], "L-1"),
      at: atSql(ORDERS, [], p.at, undefined),
      changes: changesSql(ORDERS, [], p.from, p.to, undefined),
      deleted: deletedSql(ORDERS, [], undefined),
    };
    for (const a of Object.keys(expected)) {
      await reg.actions[a](nodeCtx(host, "t:line", { runId: `run-${a}`, params: p }), {});
      expect(last()[1].sql, a).toBe(expected[a]);
    }
  });

  it("explains missing inputs and refuses version queries on plain tables", async () => {
    const { host } = fakeHost();
    const reg = registry(plugin);
    await expect(reg.actions.history(nodeCtx(host, "t:line", { runId: "x" }), {})).rejects.toThrow("Enter the record key (line_id)");
    await expect(reg.actions.at(nodeCtx(host, "t:line", { runId: "x", params: { at: "soon" } }), {})).rejects.toThrow("Enter a valid time");
    await expect(reg.actions.changes(nodeCtx(host, "t:line", { runId: "x", params: { from: "2026-01-01" } }), {})).rejects.toThrow("valid start and end");
    await expect(reg.actions.current(nodeCtx(host, "t:customer", { runId: "x" }), {})).rejects.toThrow("not time-versioned");
    await expect(reg.actions.deleted(nodeCtx(host, "t:pricing", { runId: "x" }), {})).rejects.toThrow("no deleted flag");
    host.params.get = vi.fn(async () => ({ found: false, value: "" }));
    await expect(reg.actions.rows(nodeCtx(host, "t:line", { runId: "x" }), {})).rejects.toThrow("No data source");
  });

  it("an action without a stored snapshot takes one in its run; outside a run it is refused like the real kernel", async () => {
    const { host } = fakeHost();
    const reg = registry(plugin);
    await reg.actions.rows(nodeCtx(host, "t:line", { runId: "r5" }), {});
    expect(await snapshot(ctxOf(host))).toMatchObject({ mapping: { path: "/work/mapping.yaml" } });
    await expect(reg.actions.rows(nodeCtx(host, "t:line"), {})).rejects.toMatchObject({ code: "denied", params: { reason: "notInRun" } });
  });

  it("sent statements share one key, newest 30; a failed write does not fail the run (review #2)", async () => {
    const { host, store } = fakeHost();
    for (let i = 0; i < 1100; i++) await rememberSent(ctxOf(host), `run${i}`, `SELECT ${i}`);
    expect([...store.keys()]).toEqual(["sent"]);
    expect(await sentOf(ctxOf(host), "run1099")).toBe("SELECT 1099");
    expect(await sentOf(ctxOf(host), "run1069")).toBeNull();
    await refreshed(host);
    host.storage.set = vi.fn(async () => Promise.reject(hostError("invalid", { reason: "tooManyKeys" })));
    await expect(registry(plugin).actions.rows(nodeCtx(host, "t:line", { runId: "r6" }), {})).resolves.toBeTruthy();
  });

  it("on a data source's page it reads that database's tables, whatever the environment says (review #21)", async () => {
    const { host } = fakeHost();
    host.params.get = vi.fn(async () => ({ found: false, value: "" }));
    const res = await registry(plugin).actions.tablesHere(ctxOf(host, { runId: "t1", resource: { id: "s9", name: "Other" } }), {});
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.text).toBe("6 tables read, 1 missing in the database");
    expect(host.actions.call.mock.calls[1][2]).toEqual({ resource: "s9" });
    expect(await snapshot(ctxOf(host))).toMatchObject({ existing: expect.any(Array) });
  });
  it("may read data sources: an action on the data source kind and a dependency on its plugin (kernel foreign_kinds, review #21)", () => {
    // mirrors crates/kernel/src/manifest.rs foreign_kinds + deps.rs export_allows
    const foreign = manifest.contributes.actions.flatMap((a: any) => a.kinds ?? []).filter((k: string) => k.includes(":") && !k.startsWith(`${manifest.id}:`));
    expect(foreign).toContain("org.onedesk.datasource:source");
    expect(manifest.depends.map((d: any) => d.id)).toContain("org.onedesk.datasource");
  });

  it("registers what the manifest declares", () => {
    const reg = registry(plugin);
    expect(Object.keys(reg.actions).sort()).toEqual(manifest.contributes.actions.map((a: any) => a.id).sort());
    expect(Object.keys(reg.commands).sort()).toEqual(manifest.contributes.commands.map((c: any) => c.id).sort());
    expect(Object.keys(reg.pages).sort()).toEqual(["overview", "table"]);
    expect(manifest.contributes.pages[0].actions.map((a: any) => a.action)).toEqual(["rows", "current", "history", "at", "changes", "deleted", "refresh"]);
  });
});

describe("table: for AI clients (round 19)", () => {
  const tools = manifest.contributes.aiTools;
  const actionOf = (id: string) => manifest.contributes.actions.find((a: any) => a.id === id);

  it("declares list_tables and the free query; the free query is the only one behind the policy", () => {
    expect(tools.map((x: any) => [x.name, x.freeQuery])).toEqual([["list_tables", false], ["run_sql", true]]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      expect(tool.inputSchema.type).toBe("object");
      const a = actionOf(tool.action);
      expect(a.kinds).toBeUndefined(); // an aiTools action is not bound to a resource
      expect(a.confirm).toBeNull();
      expect(a.ai).toMatchObject({ readOnly: true });
      expect(EN[tool.description]).toBeTruthy();
      expect(EN[a.ai.description]).toBeTruthy();
    }
    expect(tools[1].inputSchema.required).toEqual(["sql"]);
  });

  it("lists the mapped tables with their columns, filtered by a text", async () => {
    const { host } = fakeHost();
    const res = await registry(plugin).actions.aiListTables(ctxOf(host, { runId: "a1", ai: { client: "c" } }), {});
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.type).toBe("table");
    expect(res.output.rows.length).toBe(res.output.total);
    expect(res.output.rows.some((r: string[]) => r[1] === "shop.order_line" && r[2] === "id" && r[3] === "line_id")).toBe(true);
    expect(host.actions.call).toHaveBeenCalledTimes(1); // only the mapping: no data source is touched
    const some = await registry(plugin).actions.aiListTables(ctxOf(host, { runId: "a2" }), { filter: "price" });
    expect(new Set(some.output.rows.map((r: string[]) => r[0]))).toEqual(new Set(["pricing"]));
    expect(tableRows({ entities: {} }, "")).toEqual([]);
  });

  it("the free query accepts one SELECT or WITH and nothing else", () => {
    expect(freeQueryProblem("SELECT 1")).toBeNull();
    expect(freeQueryProblem("  (select 1) union (select 2);")).toBeNull();
    expect(freeQueryProblem("-- hi\nWITH a AS (SELECT 1) SELECT * FROM a")).toBeNull();
    expect(freeQueryProblem("SELECT ';' , $$ ; $$, \"a;b\" FROM t -- ; x")).toBeNull();
    expect(freeQueryProblem("")).toBe("empty");
    expect(freeQueryProblem("SELECT 1; SELECT 2")).toBe("severalStatements");
    expect(freeQueryProblem("SELECT 1; DROP TABLE t")).toBe("severalStatements");
    expect(freeQueryProblem("DELETE FROM t")).toBe("notSelect");
    expect(freeQueryProblem("/* x */ UPDATE t SET a = 1")).toBe("notSelect");
    expect(freeQueryProblem("EXPLAIN SELECT 1")).toBe("notSelect");
    expect(freeQueryProblem("COPY t TO PROGRAM 'x'")).toBe("notSelect");
    expect(freeQueryProblem("SELECT usename FROM pg_catalog.pg_user LIMIT 2")).toBe("systemSchema");
    expect(freeQueryProblem("select * from information_schema.tables")).toBe("systemSchema");
    expect(freeQueryProblem("SELECT * FROM pg_user")).toBe("systemSchema");
    expect(freeQueryProblem('SELECT * FROM "pg_catalog"."pg_class"')).toBe("systemSchema");
    expect(freeQueryProblem("SELECT 'pg_user' FROM orders")).toBeNull();
    expect(freeQueryProblem("SELECT 1\n\\! ls")).toBe("backslash");
    expect(freeQueryProblem("SELECT 1 " + "x".repeat(20001))).toBe("tooLong");
  });

  it("run_sql sends one statement to the data source with a timeout and a row limit; refused text never reaches it", async () => {
    const { host } = fakeHost();
    const res = await registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "q1" }), { sql: "SELECT 1", limit: 5 });
    expect(checkActionResult(res)).toEqual([]);
    expect(host.actions.call).toHaveBeenCalledWith("org.onedesk.datasource:query", { sql: "SELECT 1", inline: true, maxRows: 5, timeoutMs: 15000 }, { resource: "s1" });
    await registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "q2" }), { sql: "SELECT 2", limit: 99999 });
    expect(host.actions.call.mock.calls.at(-1)[1].maxRows).toBe(2000);
    await registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "q3" }), { sql: "SELECT 3" });
    expect(host.actions.call.mock.calls.at(-1)[1].maxRows).toBe(200);
    const before = host.actions.call.mock.calls.length;
    for (const sql of ["DROP TABLE t", "SELECT 1; SELECT 2", "SELECT 1\n\\q", ""]) {
      await expect(registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "q4" }), { sql })).rejects.toThrow();
    }
    expect(host.actions.call.mock.calls.length).toBe(before);
  });

  it("run_sql shows the data source's own refusal and needs a data source", async () => {
    const { host } = fakeHost();
    host.actions.call = vi.fn(async () => ({ error: "statement timeout" }));
    await expect(registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "q5" }), { sql: "SELECT 1" })).rejects.toThrow("statement timeout");
    const none = fakeHost();
    none.host.params.get = vi.fn(async () => ({ found: false, value: "" }));
    await expect(registry(plugin).actions.aiRunSql(ctxOf(none.host, { runId: "q6" }), { sql: "SELECT 1" })).rejects.toThrow(/No data source/);
  });

  it("has the new texts in every language", () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith("ai.") || k.startsWith("action.ai"));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect(ZH[k], k).toBeTruthy();
      expect(JA[k], k).toBeTruthy();
    }
  });
});

describe("table: free query forbidden functions (D450)", () => {
  const bad = (sql: string, name?: string) => {
    expect(freeQueryProblem(sql), sql).toBe("forbiddenFunction");
    if (name) expect(forbiddenName(sql), sql).toBe(name);
  };
  it("refuses server-acting, file-reading and text-running functions, however they are spelled", () => {
    bad("SELECT pg_terminate_backend(1)", "pg_terminate_backend");
    bad("SELECT PG_TERMINATE_BACKEND(1)", "PG_TERMINATE_BACKEND");
    bad('SELECT "pg_terminate_backend"(1)', "pg_terminate_backend");
    bad('SELECT pg_catalog."Pg_Cancel_Backend"(1)');
    bad("SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_stat_activity", "pg_terminate_backend");
    bad('SELECT "pg_catalog"."pg_terminate_backend"(1)');
    bad("select  pg_cancel_backend /* x */ (1)");
    bad("SELECT pg_cancel_backend\n(1)");
    bad("SELECT dblink('host=x', 'select 1')");
    bad("SELECT * FROM dblink_exec('x','y') AS t(a text)");
    bad("SELECT pg_read_file('/etc/passwd')");
    bad("SELECT pg_read_binary_file('/etc/passwd')");
    bad("SELECT lo_" + "import ( '/etc/passwd' )");
    bad("SELECT lo_export(1, '/tmp/x')");
    bad("SELECT * FROM pg_ls_dir('/')");
    bad("SELECT * FROM pg_ls_logdir()");
    bad("SELECT pg_sleep(100)");
    bad("SELECT pg_advisory_lock(1)");
    bad("SELECT set_config('x','y',false)");
    bad("SELECT query_to_xml('select pg_terminate_backend(1)', true, true, '')");
    bad("SELECT database_to_xml(true, true, '')");
    bad("WITH a AS (SELECT pg_terminate_backend(1)) SELECT * FROM a");
    bad("SELECT (SELECT pg_read_file('x'))");
    bad("SELECT 1 FROM t WHERE x = (SELECT lo_export(1, 'f'))");
    bad("(SELECT 1) UNION (SELECT pg_sleep(1)::int)");
    bad("SELECT 1 /* a */ FROM /* b */ pg_catalog . pg_ls_dir ('x')");
  });
  it("refuses COPY anywhere and names spelled with a Unicode escape", () => {
    expect(freeQueryProblem("COPY (SELECT 1) TO PROGRAM 'x'")).toBe("notSelect");
    bad("WITH a AS (SELECT 1) COPY a TO '/tmp/x'");
    expect(freeQueryProblem('SELECT U&"pg_terminate_b\\0061ckend"(1)')).toBe("unicodeEscape");
    expect(freeQueryProblem('SELECT u&"x" FROM t')).toBe("unicodeEscape");
  });
  it("lets ordinary queries through, including names only inside strings and comments", () => {
    expect(freeQueryProblem("SELECT 'pg_terminate_backend', \"copied\", \"lo\", a.lower_name, 'x lo_import' FROM t")).toBeNull();
    expect(freeQueryProblem("SELECT 1 -- pg_sleep(1)\n, 2 /* pg_read_file */")).toBeNull();
    expect(freeQueryProblem("SELECT $$ pg_sleep(1) $$, E'pg_ls_dir\\'' FROM t")).toBeNull();
    expect(freeQueryProblem("SELECT count(*), now(), coalesce(a, b), pg_typeof(a), current_setting('x') FROM shop.orders")).toBeNull();
    expect(freeQueryProblem("SELECT lower(a), copy_count, load_x FROM t")).toBeNull();
  });
  it("the plugin refuses with the name in its text, in each language, and never reaches the data source", async () => {
    const { host } = fakeHost();
    await expect(registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "f1" }), { sql: "SELECT pg_catalog.pg_terminate_backend(1)" })).rejects.toThrow("“pg_terminate_backend” is not allowed");
    await expect(registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "f2", locale: "zh-CN" }), { sql: "SELECT pg_sleep(1)" })).rejects.toThrow("“pg_sleep”不允许");
    await expect(registry(plugin).actions.aiRunSql(ctxOf(host, { runId: "f3", locale: "ja-JP" }), { sql: "SELECT lo_export(1, 'x')" })).rejects.toThrow("「lo_export」は自由クエリでは使えません");
    expect(host.actions.call).not.toHaveBeenCalled();
    for (const l of [EN, ZH, JA]) expect(l["ai.tool.runSql"]).toMatch(/read-only database role|只读的数据库角色|読み取り専用のデータベースロール/);
  });
});
