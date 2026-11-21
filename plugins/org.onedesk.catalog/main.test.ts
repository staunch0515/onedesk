import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { asOfExpr, checks, expand, groupsOf, normalizeMapping, paramDeclLines, paramNames, parseEntry, parseMapping, parseYaml, placeholders, quoteIdent, renderSql, splitHeader, sync, treeChildren, treePath, versionedSubquery } from "./main.js";
import { checkActionResult, checkView, onlyKeys, RENDER_KEYS, TREE_NODE_KEYS } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

type Host = Record<string, any>;

// What activate(host) registers, events included.
type Bag = Record<string, any>;
function registry(): { pages: Bag; trees: Bag; commands: Bag; actions: Bag; kinds: Bag; events: Bag } {
  const out = { pages: {} as Bag, trees: {} as Bag, commands: {} as Bag, actions: {} as Bag, kinds: {} as Bag, events: {} as Bag };
  const h = (bag: Bag) => ({ handle: (id: string, f: unknown) => (bag[id] = f) });
  plugin.activate({ pages: h(out.pages), trees: h(out.trees), commands: h(out.commands), actions: h(out.actions), kinds: h(out.kinds), events: { on: (n: string, f: unknown) => (out.events[n] = f) } });
  return out;
}

const MAPPING_YAML = `# shop mapping
entities:
  order:
    table: shop.orders
    description: Orders, one row per version
    columns:
      id: order_id
      total: { column: total_amount, description: with tax }
      created: created_at
      status: status
    versioned:
      key: [order_id]
      from: valid_from
      to: valid_to
      deleted: is_deleted
  customer: shop.customers
  Bad-Name: x
  noTable:
    columns: { a: b }
`;

const ORDERS_SQL = `/* ---
id: sales.orders.recent
title: Recent orders
description: Orders since a time
datasource: Prod
permissions: [read, mcp]
params:
  - name: since
    type: datetime
    required: true
    description: from when
  - name: status
    values: [paid, refunded]
--- */
SELECT o.{{order.id}}, o.{{order.total}}
FROM {{order}} o
WHERE o.{{order.created}} >= :since AND o.{{order.status}} = :status
`;

const TOP_SQL = `-- ---
-- id: sales.top
-- params: [n]
-- ---
SELECT * FROM {{customer}} LIMIT :n`;

// A fake file system under /work (granted), a mapping at its top, and a resource store keyed by external key.
function fakeHost(files: Record<string, string>, over: Host = {}) {
  const store = new Map<string, string>();
  const resources: any[] = [];
  let next = 1;
  const host: Host = {
    files: {
      roots: vi.fn(async () => [{ path: "/work", name: "work" }]),
      list: vi.fn(async (dir: string) => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        const names = new Map<string, boolean>();
        for (const p of Object.keys(files)) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length).split("/");
          names.set(rest[0]!, rest.length > 1 || names.get(rest[0]!) === true);
        }
        return { entries: [...names].map(([name, dir]) => ({ name, path: prefix + name, dir, hidden: false })) };
      }),
      readText: vi.fn(async (p: string) => {
        if (!(p in files)) throw Object.assign(new Error("notFound"), { code: "notFound" });
        return { text: files[p], basis: "b" };
      }),
    },
    settings: { get: vi.fn(async () => "") },
    storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)) },
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })), config: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    resources: {
      list: vi.fn(async (o: any) => (o.kind === "org.onedesk.datasource:source" ? [{ id: "s1", name: "Prod" }] : resources)),
      // Models resources.upsertByKey (round16-protocol.md §2.2): new key → create (name defaults to the last path
      // segment); known key → write only the fields given (body keys merged); othersMissing marks the rest.
      upsertByKey: vi.fn(async (kind: string, items: any[], opts: any) => {
        const keys = new Set(items.map((i: any) => i.key));
        const c = { created: 0, updated: 0, unchanged: 0, restored: 0, missing: 0 };
        for (const it of items) {
          const r = resources.find((x) => x.externalKey === it.key);
          if (!r) {
            resources.push({ id: `r${next++}`, kind: `org.onedesk.catalog:${kind}`, externalKey: it.key, name: it.name ?? it.key.split("/").pop(), description: it.description ?? "", body: it.body, tags: [], favorite: false, missing: false });
            c.created++;
            continue;
          }
          const before = JSON.stringify(r);
          if (it.name !== undefined) r.name = it.name;
          if (it.description !== undefined) r.description = it.description;
          if (it.body) r.body = { ...r.body, ...it.body };
          if (r.missing) (r.missing = false), c.restored++;
          else if (JSON.stringify(r) !== before) c.updated++;
          else c.unchanged++;
        }
        if (opts && opts.othersMissing) for (const r of resources) if (!keys.has(r.externalKey) && !r.missing) (r.missing = true), c.missing++;
        return c;
      }),
    },
    actions: { call: vi.fn(async () => ({ output: { type: "table", columns: [{ key: "c0", label: "n" }], rows: [["1"]], total: 1 }, summary: { message: "ok" } })) },
    ui: { copy: vi.fn(async () => undefined) },
    ...over,
  };
  return { host, resources, store };
}

const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const FILES = { "/work/mapping.yaml": MAPPING_YAML, "/work/sales/orders.sql": ORDERS_SQL, "/work/top.sql": TOP_SQL };

describe("catalog: YAML", () => {
  it("reads maps, lists of maps, inline lists and maps, quotes, comments, booleans and block text", () => {
    const y = parseYaml(`a: 1
b: "x # not a comment"  # a comment
c: [p, 'q r', "s"]
d: { k: v, n: true }
e:
  - name: one
    type: text
  - two
f:
- x
g: |
  line 1
  line 2
h: null
`);
    expect(y).toEqual({ a: "1", b: "x # not a comment", c: ["p", "q r", "s"], d: { k: "v", n: true }, e: [{ name: "one", type: "text" }, "two"], f: ["x"], g: "line 1\nline 2", h: null });
  });

  it("says which line is wrong", () => {
    expect(() => parseYaml("a: 1\n  b: 2")).toThrow();
    try {
      parseYaml("a: 1\na: 2");
    } catch (e: any) {
      expect(e).toEqual({ yamlLine: 2, yamlReason: "duplicateKey" });
    }
    try {
      parseYaml("a: [1, 2");
    } catch (e: any) {
      expect(e.yamlReason).toBe("flow");
    }
    try {
      parseYaml("a:\n\tb: 1");
    } catch (e: any) {
      expect(e.yamlReason).toBe("tab");
    }
  });
});

describe("catalog: query files (A5)", () => {
  it("finds the header in a block comment or in -- lines", () => {
    expect(splitHeader(ORDERS_SQL)!.body.startsWith("SELECT o.")).toBe(true);
    expect(splitHeader(TOP_SQL)!.yaml).toBe("id: sales.top\nparams: [n]");
    expect(splitHeader("SELECT 1")).toBeNull();
    expect(splitHeader("/* ---\nid: x\n")!.unclosed).toBe(true);
  });

  it("parses id, title, description, params, permissions, data source", () => {
    const r = parseEntry("/work/sales/orders.sql", ORDERS_SQL);
    expect(r.ok).toBe(true);
    expect(r.entry).toMatchObject({
      id: "sales.orders.recent",
      title: "Recent orders",
      description: "Orders since a time",
      datasource: "Prod",
      permissions: ["read", "mcp"],
      params: [
        { name: "since", type: "datetime", required: true, description: "from when", values: [], max: 0 },
        { name: "status", type: "enum", required: false, values: ["paid", "refunded"] },
      ],
      path: "/work/sales/orders.sql",
    });
    expect(parseEntry("/x", TOP_SQL).entry.params).toEqual([{ name: "n", type: "text", required: false, description: "", values: [], max: 0 }]);
    expect(parseEntry("/x", "-- ---\n-- id: a\n-- params: { n: number }\n-- ---\nSELECT :n").entry.params[0].type).toBe("number");
  });

  it("gives a reason for each file it cannot index", () => {
    const reason = (text: string) => parseEntry("/x.sql", text);
    expect(reason("SELECT 1")).toEqual({ ok: false, reason: "noHeader", detail: "" });
    expect(reason("/* ---\nid: a\nSELECT 1")).toMatchObject({ reason: "unclosedHeader" });
    expect(reason("/* ---\nid: a\n  bad: indent\n--- */\nSELECT 1")).toMatchObject({ reason: "badHeader", detail: "2: indent" });
    expect(reason("/* ---\ntitle: no id\n--- */\nSELECT 1")).toMatchObject({ reason: "noId" });
    expect(reason("/* ---\nid: a b\n--- */\nSELECT 1")).toMatchObject({ reason: "badId", detail: "a b" });
    expect(reason("/* ---\nid: a\nparams: [1x]\n--- */\nSELECT 1")).toMatchObject({ reason: "badParam", detail: "1x" });
    expect(reason("/* ---\nid: a\nparams: [n, n]\n--- */\nSELECT 1")).toMatchObject({ reason: "duplicateParam" });
    expect(reason("/* ---\nid: a\nparams: { n: blob }\n--- */\nSELECT 1")).toMatchObject({ reason: "badParamType", detail: "n: blob" });
    expect(reason("/* ---\nid: a\n--- */\n   \n")).toMatchObject({ reason: "noBody" });
  });
});

describe("catalog: placeholders and mapping (A6)", () => {
  const { mapping, problems } = parseMapping(MAPPING_YAML, "/work/mapping.yaml");

  it("reads the mapping and lists the entries it left out", () => {
    expect(Object.keys(mapping.entities).sort()).toEqual(["customer", "order"]);
    expect(mapping.entities.order.columns.total).toEqual({ column: "total_amount", description: "with tax" });
    expect(mapping.entities.order.versioned).toEqual({ key: ["order_id"], from: "valid_from", to: "valid_to", deleted: "is_deleted" });
    expect(problems).toEqual([
      { reason: "mappingName", detail: "Bad-Name" },
      { reason: "mappingTable", detail: "noTable" },
    ]);
    expect(parseMapping("{", "/m.json").problems[0].reason).toBe("mappingParse");
    expect(parseMapping('{"entities":{"a":{"table":"t"}}}', "/m.json").mapping.entities.a.table).toBe("t");
    expect(normalizeMapping([], "").problems[0].reason).toBe("mappingShape");
    expect(normalizeMapping({ entities: { e: { table: "t", versioned: { from: "f" } } } }, "").problems[0].reason).toBe("mappingVersioned");
  });

  it("finds placeholders and parameters outside strings and comments", () => {
    const sql = "SELECT {{a.b}}, '{{no}}', :p -- {{no2}} :q\nFROM {{a}} /* {{no3}} */ WHERE x::int = :p";
    expect(placeholders(sql)).toEqual(["a.b", "a"]);
    expect(paramNames(sql)).toEqual(["p"]);
    expect(placeholders("SELECT {{ bad-name }}, {{x.y.z}}")).toEqual([]);
  });

  it("replaces entities by tables and fields by columns, quoting when needed", () => {
    const m = normalizeMapping({ entities: { cust: { table: "Shop.Customers", columns: { name: "Full Name", id: "id" } } } }, "").mapping;
    expect(expand("SELECT c.{{cust.name}}, c.{{cust.id}} FROM {{cust}} c", m)).toEqual({ sql: 'SELECT c."Full Name", c.id FROM "Shop"."Customers" c', unmapped: [], versioned: false });
    expect(quoteIdent("shop.orders")).toBe("shop.orders");
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it("leaves unmapped placeholders as written and names them", () => {
    const r = expand("SELECT {{order.nope}}, {{ghost}} FROM {{customer}}", mapping);
    expect(r.unmapped).toEqual(["order.nope", "ghost"]);
    expect(r.sql).toBe("SELECT {{order.nope}}, {{ghost}} FROM shop.customers");
  });
});

describe("catalog: time-versioned entities (A7)", () => {
  const { mapping } = parseMapping(MAPPING_YAML, "/work/mapping.yaml");
  const T = "COALESCE(CAST(:as_of AS timestamptz), now())";

  it("is the latest version in force at :as_of, without deleted versions", () => {
    expect(asOfExpr()).toBe(T);
    expect(versionedSubquery("shop.orders", mapping.entities.order.versioned, T)).toBe(
      `(SELECT * FROM (SELECT DISTINCT ON (order_id) * FROM shop.orders WHERE valid_from <= ${T} AND (valid_to IS NULL OR valid_to > ${T}) ORDER BY order_id, valid_from DESC) AS od_v WHERE NOT od_v.is_deleted)`,
    );
    expect(versionedSubquery("t", { key: ["a", "b"], from: "f" }, "X")).toBe("(SELECT DISTINCT ON (a, b) * FROM t WHERE f <= X ORDER BY a, b, f DESC)");
  });

  it("keeps an alias that is written and adds one when there is none", () => {
    const withAlias = expand("SELECT * FROM {{order}} o", mapping);
    expect(withAlias.versioned).toBe(true);
    expect(withAlias.sql.endsWith(") o")).toBe(true);
    expect(expand("SELECT * FROM {{order}} WHERE 1=1", mapping).sql).toMatch(/\) AS "order" WHERE 1=1$/);
    expect(expand("SELECT * FROM {{order}}", mapping).sql).toMatch(/\) AS "order"$/);
    expect(expand("SELECT * FROM {{order}} AS x", mapping).sql).toMatch(/\) AS x$/);
  });

  it("renders :as_of as a literal; empty is NULL, which means now()", () => {
    const ex = expand("SELECT * FROM {{order}} o", mapping).sql;
    expect(renderSql(ex, { as_of: "2026-01-02T03:04" }, [{ name: "as_of", type: "datetime" }])).toContain("CAST('2026-01-02T03:04:00Z' AS timestamptz)");
    expect(renderSql(ex, { as_of: "" }, [])).toContain("COALESCE(CAST(NULL AS timestamptz), now())");
  });
});

describe("catalog: checks (A8)", () => {
  const { mapping } = parseMapping(MAPPING_YAML, "/work/mapping.yaml");
  const entry = (sql: string, params: string[]) => ({ sql, params: params.map((name) => ({ name, type: "text" })) });

  it("warns about undeclared and unused parameters and unmapped placeholders", () => {
    expect(checks(entry("SELECT :a, {{order.nope}} FROM {{ghost}}", ["b"]), mapping, "")).toEqual([
      { key: "warn.undeclared", vars: { name: "a" } },
      { key: "warn.unused", vars: { name: "b" } },
      { key: "warn.unmapped", vars: { name: "order.nope" } },
      { key: "warn.unmapped", vars: { name: "ghost" } },
    ]);
    expect(checks(entry("SELECT :a FROM {{customer}}", ["a"]), mapping, "")).toEqual([]);
  });

  it("a declared as_of is used by a versioned entity; placeholders without a mapping get one warning", () => {
    expect(checks(entry("SELECT * FROM {{order}}", ["as_of"]), mapping, "")).toEqual([]);
    expect(checks(entry("SELECT * FROM {{order}}", []), { entities: {} }, "No mapping file found")).toEqual([{ key: "warn.noMapping", vars: { reason: "No mapping file found" } }]);
  });
});

describe("catalog: grouping (A9)", () => {
  it("groups by the first two segments of the id", () => {
    expect(groupsOf("sales.orders.recent")).toEqual(["sales", "sales.orders"]);
    expect(groupsOf("sales.orders.recent.deep")).toEqual(["sales", "sales.orders"]);
    expect(groupsOf("sales.top")).toEqual(["sales"]);
    expect(groupsOf("top")).toEqual([]);
  });

  const res = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id: `r-${id}`, name, body: { id }, ...extra });
  const all = [res("sales.orders.recent", "Recent"), res("sales.orders.big", "Big"), res("sales.top", "Top"), res("misc", "Misc"), res("sales.orders.gone", "Gone", { missing: true, state: "broken" })];

  it("builds the tree level by level; missing entries are left out", () => {
    const root = treeChildren(all, "");
    expect(root.map((n: any) => n.key)).toEqual(["g:sales", "r-misc"]);
    for (const n of root) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
    expect(treeChildren(all, "g:sales").map((n: any) => n.label)).toEqual(["orders", "Top"]);
    const orders = treeChildren(all, "g:sales.orders");
    expect(orders.map((n: any) => n.label)).toEqual(["Big", "Recent"]);
    expect(orders[0]).toEqual({ key: "r-sales.orders.big", label: "Big", icon: "file-search", expandable: false, target: "resource:r-sales.orders.big" });
  });

  it("gives the path of a node from the root", () => {
    expect(treePath(all, "r-sales.orders.recent")).toEqual(["g:sales", "g:sales.orders", "r-sales.orders.recent"]);
    expect(treePath(all, "g:sales.orders")).toEqual(["g:sales", "g:sales.orders"]);
    expect(treePath(all, "r-misc")).toEqual(["r-misc"]);
  });

  it("the tree handler reads the plugin's own resources", async () => {
    const { host } = fakeHost({});
    host.resources.list = vi.fn(async () => all);
    const out = await registry().trees.catalog.children(ctxOf(host), "");
    expect(host.resources.list).toHaveBeenCalledWith({ kind: "entry" });
    expect(out.nodes.length).toBe(2);
  });
});

describe("catalog: sync (A1, A3, A4, A5)", () => {
  it("indexes every .sql file under the granted folders, one batch keyed by path, and reports skipped files", async () => {
    const files = { ...FILES, "/work/broken.sql": "SELECT 1", "/work/notes.txt": "x", "/work/.hidden/x.sql": TOP_SQL, "/work/dup.sql": TOP_SQL };
    const { host, resources, store } = fakeHost(files);
    const report = await sync(ctxOf(host));
    expect(host.resources.upsertByKey).toHaveBeenCalledTimes(1);
    const [kind, items, opts] = host.resources.upsertByKey.mock.calls[0];
    expect([kind, opts]).toEqual(["entry", { othersMissing: true }]);
    expect(items.map((i: any) => i.key)).toEqual(["/work/dup.sql", "/work/sales/orders.sql"]);
    expect(items[1]).toMatchObject({ name: "Recent orders", description: "Orders since a time", body: { id: "sales.orders.recent", path: "/work/sales/orders.sql" } });
    expect(resources.length).toBe(2);
    expect(report).toMatchObject({ files: 4, indexed: 2, created: 2, missing: 0 });
    expect(report.skipped).toEqual([
      { path: "/work/broken.sql", reason: "noHeader", detail: "" },
      { path: "/work/top.sql", reason: "duplicateId", detail: "sales.top · /work/dup.sql" },
    ]);
    expect(JSON.parse(store.get("lastReport")!).indexed).toBe(2);
  });

  it("a second sync writes only description and body: tags, favorites and the name stay", async () => {
    const files: Record<string, string> = { ...FILES };
    const { host, resources } = fakeHost(files);
    await sync(ctxOf(host));
    const r = resources.find((x) => x.externalKey === "/work/top.sql");
    r.tags = ["mine"];
    r.favorite = true;
    r.name = "Renamed by me";
    files["/work/top.sql"] = TOP_SQL.replace("-- params: [n]", "-- description: changed\n-- params: [n]");
    const report = await sync(ctxOf(host));
    expect(report).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    // an entry already indexed is sent without a name
    expect(host.resources.upsertByKey.mock.calls[1][1].every((i: any) => !("name" in i))).toBe(true);
    expect(r).toMatchObject({ tags: ["mine"], favorite: true, name: "Renamed by me", description: "changed", id: r.id });
  });

  it("a deleted file is marked missing, keeps its id, and comes back when the file does", async () => {
    const files: Record<string, string> = { ...FILES };
    const { host, resources } = fakeHost(files);
    await sync(ctxOf(host));
    const id = resources.find((x) => x.externalKey === "/work/top.sql").id;
    delete files["/work/top.sql"];
    expect((await sync(ctxOf(host))).missing).toBe(1);
    expect(resources.find((x) => x.id === id).missing).toBe(true);
    expect(treeChildren(resources, "g:sales").map((n: any) => n.key)).toEqual(["g:sales.orders"]);
    files["/work/top.sql"] = TOP_SQL;
    expect((await sync(ctxOf(host))).restored).toBe(1);
    expect(resources.find((x) => x.id === id).missing).toBe(false);
    expect(resources.length).toBe(2);
  });

  it("re-indexes when the workspace opens (activation), from the toolbar command and as an action", async () => {
    expect(manifest.activation).toEqual(["workspace.opened"]);
    expect(manifest.contributes.events).toBeUndefined(); // activation alone registers it (round16-protocol.md §1)
    const reg = registry();
    const { host } = fakeHost(FILES);
    await reg.events["workspace.opened"](ctxOf(host));
    expect(host.resources.upsertByKey).toHaveBeenCalledTimes(1);
    const effects = await reg.commands.reindex(ctxOf(host), {});
    expect(effects).toEqual([{ type: "toast", message: "2 queries indexed, 0 skipped, 0 missing", tone: "success" }]);
    const res = await reg.actions.reindex(ctxOf(host));
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.columns.map((c: any) => c.key)).toEqual(["path", "reason"]);
    expect(await reg.commands.openIndex(ctxOf(host), {})).toEqual([{ type: "open", target: "page:org.onedesk.catalog/index" }]);
  });

  it("the index page lists skipped files with their reason", async () => {
    const { host } = fakeHost({ ...FILES, "/work/bad.sql": "/* ---\nid: a b\n--- */\nSELECT 1" });
    const reg = registry();
    expect((await reg.pages.index.render(ctxOf(host))).view.map((n: any) => n.id)).toEqual(["about", "none"]);
    await sync(ctxOf(host));
    const out = await reg.pages.index.render(ctxOf(host));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    const table = out.view.find((n: any) => n.id === "skipped");
    expect(table.rows).toEqual([["/work/bad.sql", `${EN["reason.badId"]} (a b)`]]);
  });
});

describe("catalog: entry page (A2, A7, A8)", () => {
  const entryCtx = async (host: Host, extra: Record<string, unknown> = {}) => {
    await sync(ctxOf(host));
    const all = await host.resources.list({ kind: "entry" });
    return ctxOf(host, { target: "resource:r1", resource: all.find((r: any) => r.body.id === "sales.orders.recent"), ...extra });
  };

  it("is read-only, binds nothing, shows the as-of field for a versioned entity and the header's params", async () => {
    const { host } = fakeHost(FILES);
    const out = await registry().pages.entry.render(await entryCtx(host));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.readOnly).toBe(true);
    for (const n of out.view) for (const f of n.fields || []) expect(f.bind).toBeUndefined();
    const params = out.view.find((n: any) => n.id === "params");
    expect(params.fields.map((f: any) => [f.name, f.kind])).toEqual([
      ["since", "datetime"],
      ["status", "enum"],
      ["as_of", "datetime"],
    ]);
    expect(out.view.filter((n: any) => n.tone === "danger")).toEqual([]);
    expect(out.values.sql).toContain("{{order}}");
  });

  it("shows warnings as a strip of danger-toned text", async () => {
    const files = { ...FILES, "/work/sales/orders.sql": ORDERS_SQL.replace("= :status", "= :state").replace("{{order.status}}", "{{order.nope}}") };
    const { host } = fakeHost(files);
    const out = await registry().pages.entry.render(await entryCtx(host));
    expect(out.view.filter((n: any) => n.tone === "danger").map((n: any) => n.text)).toEqual([
      "Parameter :state is used but not declared in the header",
      "Parameter status is declared but not used",
      "{{order.nope}} has no mapping",
    ]);
  });

  it("an entry whose file is gone still opens, with a warning", async () => {
    const { host } = fakeHost(FILES);
    const ctx: Record<string, any> = await entryCtx(host);
    const out = await registry().pages.entry.render({ ...ctx, resource: { ...ctx.resource, missing: true, state: "broken" } });
    expect(out.view[0]).toEqual({ type: "text", id: "missing", text: "The file /work/sales/orders.sql no longer exists; this entry is kept for its history", tone: "danger" });
  });

  it("warns once when the mapping is missing", async () => {
    const files: Record<string, string> = { ...FILES };
    delete files["/work/mapping.yaml"];
    const { host } = fakeHost(files);
    const out = await registry().pages.entry.render(await entryCtx(host));
    expect(out.view.filter((n: any) => n.tone === "danger").map((n: any) => n.text)).toEqual(["The query uses placeholders, but the mapping is not available: No mapping file found"]);
  });

  it("a mapping file named in the settings is used; an unreadable one is reported", async () => {
    const { host } = fakeHost({ ...FILES, "/work/other/m.json": JSON.stringify({ entities: { order: "x.orders", customer: "x.c" } }) });
    host.settings.get = vi.fn(async () => "/work/other/m.json");
    const reg = registry();
    const res = await reg.actions.mapping(ctxOf(host));
    expect(JSON.parse(res.output.text)).toMatchObject({ path: "/work/other/m.json", problem: "", entities: { order: { table: "x.orders" } } });
    host.settings.get = vi.fn(async () => "/work/none.yaml");
    expect(JSON.parse((await reg.actions.mapping(ctxOf(host))).output.text).problem).toBe("mappingUnreadable");
  });
});

describe("catalog: run and save as SQL (A6, A7, A10)", () => {
  async function entry(host: Host, id: string) {
    await sync(ctxOf(host));
    return (await host.resources.list({ kind: "entry" })).find((r: any) => r.body.id === id);
  }

  it("runs the expanded query with values as literals on the header's data source", async () => {
    const { host, store } = fakeHost(FILES);
    const resource = await entry(host, "sales.orders.recent");
    const res = await registry().actions.run(ctxOf(host, { resource, runId: "run1", params: { since: "2026-01-01T00:00", status: "paid", as_of: "2026-02-01T00:00" } }), {});
    expect(checkActionResult(res)).toEqual([]);
    const [action, input, opts] = host.actions.call.mock.calls[0];
    expect(action).toBe("org.onedesk.datasource:query");
    expect(opts).toEqual({ resource: "s1" });
    expect(input.sql).toContain("SELECT o.order_id, o.total_amount");
    expect(input.sql).toContain("o.created_at >= '2026-01-01T00:00:00Z' AND o.status = 'paid'");
    expect(input.sql).toContain("CAST('2026-02-01T00:00:00Z' AS timestamptz)");
    expect(store.get("lastSent:run1")).toBe(input.sql);
  });

  it("checks values against the header and refuses unmapped placeholders", async () => {
    const { host } = fakeHost(FILES);
    const resource = await entry(host, "sales.orders.recent");
    await expect(registry().actions.run(ctxOf(host, { resource, params: { status: "paid" } }), {})).rejects.toThrow("since is required");
    await expect(registry().actions.run(ctxOf(host, { resource, params: { since: "2026-01-01T00:00", status: "nope" } }), {})).rejects.toThrow("one of the listed");
    const bad = { ...resource, body: { ...resource.body, sql: "SELECT * FROM {{ghost}}" } };
    await expect(registry().actions.run(ctxOf(host, { resource: bad }), {})).rejects.toThrow("No mapping for: ghost");
  });

  it("without a header data source it takes the environment's", async () => {
    const { host } = fakeHost(FILES);
    host.params.get = vi.fn(async (n: string) => (n === "datasource" ? { found: true, value: "Prod", sourceName: "dev" } : { found: false, value: "" }));
    const resource = await entry(host, "sales.top");
    await registry().actions.run(ctxOf(host, { resource, params: { n: "5" } }), {});
    expect(host.actions.call.mock.calls[0][1].sql).toBe("SELECT * FROM shop.customers LIMIT '5'");
  });

  it("saves as SQL through the SQL plugin's create, with declarations and the values typed", async () => {
    const { host } = fakeHost(FILES);
    host.actions.call = vi.fn(async () => ({ output: { type: "link", label: "Recent orders", target: "resource:q9" } }));
    const resource = await entry(host, "sales.orders.recent");
    const res = await registry().actions.saveAsSql(ctxOf(host, { resource, params: { since: "2026-01-01T00:00", status: "", as_of: "2026-02-01T00:00" } }), {});
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.target).toBe("resource:q9");
    const [action, input] = host.actions.call.mock.calls[0];
    expect(action).toBe("org.onedesk.sql:create");
    expect(input).toMatchObject({ name: "Recent orders", description: "Orders since a time", source: "s1", params: { since: "2026-01-01T00:00", as_of: "2026-02-01T00:00" } });
    expect(input.sql.split("\n").slice(0, 3)).toEqual(["-- @param since type=datetime required -- from when", "-- @param status values=paid|refunded", "-- @param as_of type=datetime"]);
    expect(input.sql).toContain("FROM (SELECT * FROM (SELECT DISTINCT ON (order_id)");
    expect(input.sql).not.toContain("{{");
  });

  it("declaration lines follow the SQL plugin's syntax", () => {
    expect(paramDeclLines([{ name: "n", type: "number", required: false, values: [], max: 3, description: "how\nmany" }])).toBe("-- @param n type=number max=3 -- how many");
  });

  it("copy puts the expanded SQL on the clipboard; the sent tab shows it before a run", async () => {
    const { host } = fakeHost(FILES);
    const resource = await entry(host, "sales.top");
    const reg = registry();
    expect(await reg.pages.entry.onEvent(ctxOf(host, { resource }), "copy")).toEqual({ message: "SQL copied" });
    expect(host.ui.copy).toHaveBeenCalledWith("SELECT * FROM shop.customers LIMIT :n");
    const tab = await reg.pages.entry.renderResultTab(ctxOf(host, { resource }), "sent");
    expect(checkView(tab)).toEqual([]);
    expect(tab[1].text).toBe("SELECT * FROM shop.customers LIMIT :n");
  });
});

describe("catalog: manifest", () => {
  it("registers what the manifest declares", () => {
    const reg = registry();
    expect(Object.keys(reg.pages).sort()).toEqual(manifest.contributes.pages.map((p: any) => p.id).sort());
    expect(Object.keys(reg.actions).sort()).toEqual(manifest.contributes.actions.map((a: any) => a.id).sort());
    expect(Object.keys(reg.commands).sort()).toEqual(manifest.contributes.commands.map((c: any) => c.id).sort());
    expect(Object.keys(reg.trees)).toEqual(["catalog"]);
    expect(manifest.exports.actions).toEqual(["mapping"]);
    expect(manifest.contributes.trees[0].toolbar).toContain("reindex");
  });
});
