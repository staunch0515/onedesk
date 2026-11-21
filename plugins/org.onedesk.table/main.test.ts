import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { atSql, changesSql, currentSql, deletedSql, existingSet, historySql, isMissing, prefixesOf, rowsSql, selectList, timeLiteral, treeChildren, treePath } from "./main.js";
import { checkActionResult, checkView, onlyKeys, registry, RENDER_KEYS, TREE_NODE_KEYS } from "../_testing/view-check";

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
    storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)) },
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
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
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
    for (const n of root) expect(onlyKeys(n, [...TREE_NODE_KEYS, "state", "stateReason"])).toEqual([]);
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
    const ghost = treeChildren(snap, "", 1, "why").find((n: any) => n.key === "t:ghost");
    expect(ghost).toMatchObject({ state: "missing", stateReason: "why" });
    expect(treeChildren(snap, "", 1).filter((n: any) => n.state).map((n: any) => n.key)).toEqual(["t:ghost"]);
    expect(treeChildren({ mapping: MAPPING, existing: null }, "", 1).some((n: any) => n.state)).toBe(false);
    expect(isMissing({ table: "price_list" }, existingSet(DB_TABLES))).toBe(false);
    expect(isMissing({ table: "public.customer" }, existingSet(DB_TABLES))).toBe(false);
    expect(isMissing({ table: "SHOP.Order_Head" }, existingSet(DB_TABLES))).toBe(false);
  });

  it("paths from the root", () => {
    expect(treePath(snap, "t:lineTax", 2)).toEqual(["g:order", "g:order_line", "t:lineTax"]);
    expect(treePath(snap, "c:line.qty", 1)).toEqual(["g:order", "t:line", "c:line.qty"]);
    expect(treePath(snap, "g:order_line", 2)).toEqual(["g:order", "g:order_line"]);
  });

  it("the handler reads the catalog's mapping and the database's tables, and the toolbar switches the depth (X9)", async () => {
    const { host } = fakeHost();
    const reg = registry(plugin);
    const one = await reg.trees.tables.children(ctxOf(host), "");
    expect(host.actions.call.mock.calls[0]).toEqual(["org.onedesk.catalog:mapping", {}]);
    expect(host.actions.call.mock.calls[1][2]).toEqual({ resource: "s1" });
    expect(one.nodes.find((n: any) => n.key === "t:ghost").stateReason).toEqual(t("state.missing"));
    expect((await reg.trees.tables.children(ctxOf(host), "g:order")).nodes.map((n: any) => n.key)).toEqual(["t:order", "t:line", "t:lineTax"]);
    expect(await reg.commands.toggleDepth(ctxOf(host), {})).toEqual([{ type: "toast", message: EN["message.depth2"], tone: "info" }]);
    expect((await reg.trees.tables.children(ctxOf(host), "g:order")).nodes.map((n: any) => n.key)).toEqual(["g:order_line", "t:order", "t:line"]);
    expect(await reg.trees.tables.path(ctxOf(host), "t:lineTax")).toEqual(["g:order", "g:order_line", "t:lineTax"]);
    await reg.commands.toggleDepth(ctxOf(host), {});
    expect(await reg.trees.tables.path(ctxOf(host), "t:lineTax")).toEqual(["g:order", "t:lineTax"]);
    expect(manifest.contributes.trees[0].toolbar).toEqual(["toggleDepth", "refresh"]);
  });

  it("without a data source the tree still shows the mapping", async () => {
    const { host } = fakeHost();
    host.params.get = vi.fn(async () => ({ found: false, value: "" }));
    const reg = registry(plugin);
    const out = await reg.trees.tables.children(ctxOf(host), "");
    expect(out.nodes.some((n: any) => n.state)).toBe(false);
    expect(await reg.commands.refresh(ctxOf(host), {})).toEqual([{ type: "toast", message: "6 tables read; no data source to compare with", tone: "info" }]);
  });
});

describe("table: page and actions (H4, H5)", () => {
  it("shows description, source, columns to tick and the version inputs", async () => {
    const { host } = fakeHost();
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
    await reg.trees.tables.children(ctxOf(host), "");
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
    expect(store.get("sent:r1")).toBe("SELECT qty FROM shop.order_line LIMIT 7");
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
      await reg.actions[a](nodeCtx(host, "t:line", { params: p }), {});
      expect(last()[1].sql, a).toBe(expected[a]);
    }
  });

  it("explains missing inputs and refuses version queries on plain tables", async () => {
    const { host } = fakeHost();
    const reg = registry(plugin);
    await expect(reg.actions.history(nodeCtx(host, "t:line"), {})).rejects.toThrow("Enter the record key (line_id)");
    await expect(reg.actions.at(nodeCtx(host, "t:line", { params: { at: "soon" } }), {})).rejects.toThrow("Enter a valid time");
    await expect(reg.actions.changes(nodeCtx(host, "t:line", { params: { from: "2026-01-01" } }), {})).rejects.toThrow("valid start and end");
    await expect(reg.actions.current(nodeCtx(host, "t:customer"), {})).rejects.toThrow("not time-versioned");
    await expect(reg.actions.deleted(nodeCtx(host, "t:pricing"), {})).rejects.toThrow("no deleted flag");
    host.params.get = vi.fn(async () => ({ found: false, value: "" }));
    await expect(reg.actions.rows(nodeCtx(host, "t:line"), {})).rejects.toThrow("No data source");
  });

  it("registers what the manifest declares", () => {
    const reg = registry(plugin);
    expect(Object.keys(reg.actions).sort()).toEqual(manifest.contributes.actions.map((a: any) => a.id).sort());
    expect(Object.keys(reg.commands).sort()).toEqual(manifest.contributes.commands.map((c: any) => c.id).sort());
    expect(Object.keys(reg.pages)).toEqual(["table"]);
    expect(manifest.contributes.pages[0].actions.map((a: any) => a.action)).toEqual(["rows", "current", "history", "at", "changes", "deleted"]);
  });
});
