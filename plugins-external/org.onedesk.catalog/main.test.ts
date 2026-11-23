import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { formatIndex, indexChildren, INDEX_FILE, parseIndex, TREE_PAGE, rememberSent, sentOf, asOfExpr, checks, expand, groupsOf, normalizeMapping, paramDeclLines, paramNames, parseEntry, parseMapping, parseYaml, placeholders, quoteIdent, renderSql, splitHeader, sync, treeChildren, treePath, versionedSubquery } from "./main.js";
import { checkActionResult, checkView, hostError, onlyKeys, RENDER_KEYS, TREE_NODE_KEYS } from "../../plugins/_testing/view-check";

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
// `links`: folder links (link path → real path), resolved by `files.stat` like the kernel does.
function fakeHost(files: Record<string, string>, over: Host = {}, links: Record<string, string> = {}) {
  const store = new Map<string, string>();
  const own = new Map<string, string>();
  const resources: any[] = [];
  let next = 1;
  const real = (p: string): string => {
    for (const [l, to] of Object.entries(links)) if (p === l || p.startsWith(`${l}/`)) return real(to + p.slice(l.length));
    return p;
  };
  const host: Host = {
    files: {
      roots: vi.fn(async () => [{ path: "/work", name: "work" }]),
      stat: vi.fn(async (p: string) => ({ path: real(p), name: p.split("/").pop(), dir: true })),
      list: vi.fn(async (dir: string) => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        const realPrefix = `${real(dir)}/`;
        const names = new Map<string, boolean>();
        for (const p of Object.keys(files)) {
          if (!p.startsWith(realPrefix)) continue;
          const rest = p.slice(realPrefix.length).split("/");
          names.set(rest[0]!, rest.length > 1 || names.get(rest[0]!) === true);
        }
        for (const l of Object.keys(links)) if (l.startsWith(realPrefix) && !l.slice(realPrefix.length).includes("/")) names.set(l.slice(realPrefix.length), true);
        return { entries: [...names].map(([name, isDir]) => ({ name, path: prefix + name, dir: isDir, hidden: false })) };
      }),
      // relative paths are the plugin's own folder (round16-protocol.md §2.1)
      writeText: vi.fn(async (p: string, text: string) => {
        if (p.startsWith("/")) throw Object.assign(new Error("denied"), { code: "denied" });
        own.set(p, text);
        return { basis: "b" };
      }),
      readText: vi.fn(async (p: string) => {
        if (!p.startsWith("/")) {
          if (!own.has(p)) throw Object.assign(new Error("notFound"), { code: "notFound" });
          return { text: own.get(p), basis: "b" };
        }
        const r = real(p);
        if (!(r in files)) throw Object.assign(new Error("notFound"), { code: "notFound" });
        return { text: files[r], basis: "b" };
      }),
    },
    settings: { get: vi.fn(async () => "") },
    storage: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        // the kernel's limits (host.rs): 256 KB a value, 1000 keys
        if (JSON.stringify(v).length > 256 * 1024) throw Object.assign(new Error("invalid"), { code: "invalid", params: { reason: "tooLarge" } });
        if (!store.has(k) && store.size >= 1000) throw Object.assign(new Error("invalid"), { code: "invalid", params: { reason: "tooManyKeys" } });
        store.set(k, v);
      }),
      remove: vi.fn(async (k: string) => void store.delete(k)),
    },
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })), config: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    resources: {
      list: vi.fn(async (o: any) => (o.kind === "org.onedesk.datasource:source" ? [{ id: "s1", name: "Prod" }] : resources.filter((r) => !r.deleted))),
      get: vi.fn(async (id: string) => resources.find((r) => r.id === id && !r.deleted) ?? null),
      // Models resources.upsertByKey (round16-protocol.md §2.2): new key → create (name defaults to the last path
      // segment); known key → write only the fields given (body keys merged); a deleted or missing one comes
      // back (restored); othersMissing marks the rest.
      upsertByKey: vi.fn(async (kind: string, items: any[], opts: any) => {
        const keys = new Set(items.map((i: any) => i.key));
        const c = { created: 0, updated: 0, unchanged: 0, restored: 0, missing: 0, ids: {} as Record<string, string> };
        for (const it of items) {
          const r = resources.find((x) => x.externalKey === it.key);
          if (!r) {
            const id = `r${next++}`;
            resources.push({ id, kind: `org.onedesk.catalog:${kind}`, externalKey: it.key, name: it.name ?? it.key.split("/").pop(), description: it.description ?? "", body: it.body ?? {}, tags: [], favorite: false, missing: false, deleted: false });
            c.created++;
            c.ids[it.key] = id;
            continue;
          }
          c.ids[it.key] = r.id;
          const before = JSON.stringify(r);
          if (it.name !== undefined) r.name = it.name;
          if (it.description !== undefined) r.description = it.description;
          if (it.body) r.body = { ...r.body, ...it.body };
          if (r.missing || r.deleted) (r.missing = false), (r.deleted = false), c.restored++;
          else if (JSON.stringify(r) !== before) c.updated++;
          else c.unchanged++;
        }
        if (opts && opts.othersMissing) for (const r of resources) if (!r.deleted && !keys.has(r.externalKey) && !r.missing) (r.missing = true), c.missing++;
        return c;
      }),
    },
    actions: { call: vi.fn(async () => ({ output: { type: "table", columns: [{ key: "c0", label: "n" }], rows: [["1"]], total: 1 }, summary: { message: "ok" } })) },
    ui: { copy: vi.fn(async () => undefined) },
    ...over,
  };
  return { host, resources, store, own };
}

// Like the kernel (D421): `actions.call` only inside a run, i.e. when the ctx has a runId.
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => {
  const inRun = typeof extra.runId === "string";
  const call = (...a: unknown[]) => (inRun ? host.actions.call(...a) : Promise.reject(hostError("denied", { reason: "notInRun" })));
  return { locale: "en-US", host: { ...host, actions: { ...host.actions, call } }, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra };
};
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

  it("builds the tree level by level; entries whose file is gone stay, marked (D422)", () => {
    const root = treeChildren(all, "");
    expect(root.map((n: any) => n.key)).toEqual(["g:sales", "r-misc"]);
    for (const n of root) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
    expect(treeChildren(all, "g:sales").map((n: any) => n.label)).toEqual(["orders", "Top"]);
    const orders = treeChildren(all, "g:sales.orders");
    expect(orders.map((n: any) => n.label)).toEqual(["Big", "Gone", "Recent"]);
    expect(orders[1]).toEqual({ key: "r-sales.orders.gone", label: "Gone", icon: "triangle-alert", expandable: false, target: "resource:r-sales.orders.gone", badge: "missing" });
    expect(treeChildren(all, "g:sales.orders", "失效")[1].badge).toBe("失效");
    expect(treeChildren([...all, res("x.y", "Deleted", { deleted: true })], "g:x")).toEqual([]);
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
    const deep = await registry().trees.catalog.children(ctxOf(host), "g:sales.orders");
    expect(deep.nodes.find((n: any) => n.label === "Gone").badge).toBe(EN["badge.missing"]);
  });
});

describe("catalog: sync (A1, A3, A4, A5)", () => {
  it("indexes every .sql file under the granted folders, one batch keyed by path, and reports skipped files", async () => {
    const files = { ...FILES, "/work/broken.sql": "SELECT 1", "/work/notes.txt": "x", "/work/.hidden/x.sql": TOP_SQL, "/work/dup.sql": TOP_SQL };
    const { host, resources, store } = fakeHost(files);
    const report = await sync(ctxOf(host));
    // one batch (e2e ⑥: no second batch renaming new entries); new files carry their header's name
    expect(host.resources.upsertByKey).toHaveBeenCalledTimes(1);
    const [kind, items, opts] = host.resources.upsertByKey.mock.calls[0];
    expect([kind, opts]).toEqual(["entry", { othersMissing: true }]);
    expect(items.map((i: any) => i.key)).toEqual(["/work/dup.sql", "/work/sales/orders.sql"]);
    expect(items[1]).toMatchObject({ name: "Recent orders", description: "Orders since a time", body: { id: "sales.orders.recent", path: "/work/sales/orders.sql" } });
    expect(resources.map((r) => r.name)).toEqual(["sales.top", "Recent orders"]);
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
    expect(host.resources.upsertByKey).toHaveBeenCalledTimes(2);
    expect(host.resources.upsertByKey.mock.calls[1][1].every((i: any) => !("name" in i))).toBe(true); // known files: no name
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
    expect(treeChildren(resources, "g:sales").find((n: any) => n.key === id)).toMatchObject({ icon: "triangle-alert", badge: "missing" });
    files["/work/top.sql"] = TOP_SQL;
    expect((await sync(ctxOf(host))).restored).toBe(1);
    expect(resources.find((x) => x.id === id).missing).toBe(false);
    expect(resources.length).toBe(2);
  });

  it("a deleted entry that comes back keeps the name the user gave it (review #8)", async () => {
    const files: Record<string, string> = { ...FILES };
    const { host, resources } = fakeHost(files);
    await sync(ctxOf(host));
    const r = resources.find((x) => x.externalKey === "/work/top.sql");
    r.name = "Mine";
    r.deleted = true; // the user deleted it
    files["/work/new.sql"] = TOP_SQL.replace("sales.top", "sales.new");
    const report = await sync(ctxOf(host));
    expect(report).toMatchObject({ created: 1, restored: 1 });
    expect(r).toMatchObject({ deleted: false, name: "Mine" });
    expect(resources.find((x) => x.externalKey === "/work/new.sql").name).toBe("sales.new");
  });

  it("a folder link back up is walked once; a cut-short walk marks nothing missing and says so (review #6)", async () => {
    const files: Record<string, string> = { ...FILES };
    const { host, resources } = fakeHost(files, {}, { "/work/sales/loop": "/work" });
    const first = await sync(ctxOf(host));
    expect(first).toMatchObject({ files: 2, indexed: 2, truncated: false });
    expect(resources.map((r) => r.externalKey).sort()).toEqual(["/work/sales/orders.sql", "/work/top.sql"]);

    // more than 5000 files: stop there, index what was read, mark nothing missing
    const many: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) many[`/work/many/q${String(i).padStart(5, "0")}.sql`] = `-- ---\n-- id: many.q${i}\n-- ---\nSELECT ${i}`;
    Object.assign(files, many);
    delete files["/work/top.sql"];
    const cut = await sync(ctxOf(host));
    expect(cut.truncated).toBe(true);
    expect(cut.files).toBe(5000);
    expect(host.resources.upsertByKey.mock.calls[1][2]).toEqual({});
    expect(resources.find((r) => r.externalKey === "/work/top.sql").missing).toBe(false);
    expect(resources.find((r) => r.externalKey === "/work/sales/orders.sql").missing).toBe(false);
    expect(await registry().commands.reindex(ctxOf(host), {})).toEqual([{ type: "toast", message: expect.stringContaining("nothing was marked missing"), tone: "warning" }]);
  });

  it("keeps an index in its own folder: later syncs and the tree need no list of every entry (e2e ⑥)", async () => {
    const files: Record<string, string> = { ...FILES };
    const { host, resources, own } = fakeHost(files);
    await sync(ctxOf(host));
    expect(host.resources.list).toHaveBeenCalledTimes(1); // the first sync has no index yet
    const ids = Object.fromEntries(resources.map((r) => [r.externalKey, r.id]));
    expect(parseIndex(own.get(INDEX_FILE))).toEqual(
      new Map([
        ["/work/sales/orders.sql", { id: ids["/work/sales/orders.sql"], cid: "sales.orders.recent" }],
        ["/work/top.sql", { id: ids["/work/top.sql"], cid: "sales.top" }],
      ]),
    );
    host.resources.list.mockClear();
    delete files["/work/top.sql"];
    await sync(ctxOf(host));
    expect(host.resources.list).not.toHaveBeenCalled();
    expect(parseIndex(own.get(INDEX_FILE)).has("/work/top.sql")).toBe(true); // still listed, now missing

    const reg = registry();
    const root = await reg.trees.catalog.children(ctxOf(host), "", 0);
    expect(root.nodes.map((n: any) => n.key)).toEqual(["g:sales"]);
    const sales = await reg.trees.catalog.children(ctxOf(host), "g:sales", 0);
    expect(sales.nodes.map((n: any) => [n.key, n.label, n.badge])).toEqual([
      ["g:sales.orders", "orders", undefined],
      [ids["/work/top.sql"], "sales.top", EN["badge.missing"]],
    ]);
    expect(host.resources.list).not.toHaveBeenCalled();
    expect(await reg.trees.catalog.path(ctxOf(host), ids["/work/sales/orders.sql"])).toEqual(["g:sales", "g:sales.orders", ids["/work/sales/orders.sql"]]);
    resources.find((r) => r.id === ids["/work/top.sql"]).deleted = true; // the user deleted it: gone from the tree
    expect((await reg.trees.catalog.children(ctxOf(host), "g:sales", 0)).nodes.map((n: any) => n.key)).toEqual(["g:sales.orders"]);
  });

  it("a large group comes in pages, each entry read on its own", async () => {
    const index = new Map(Array.from({ length: 450 }, (_, i) => [`/w/q${i}.sql`, { id: `r${i}`, cid: `big.q${String(i).padStart(3, "0")}` }]));
    const host: Host = { resources: { get: vi.fn(async (id: string) => ({ id, name: `N${id}`, missing: id === "r3" })) } };
    const first = await indexChildren(ctxOf(host), index, "g:big", 0, "gone");
    expect(first.nodes.length).toBe(TREE_PAGE);
    expect(first.next).toBe(TREE_PAGE);
    expect(first.nodes[3]).toMatchObject({ key: "r3", icon: "triangle-alert", badge: "gone" });
    const last = await indexChildren(ctxOf(host), index, "g:big", 400, "gone");
    expect(last.nodes.length).toBe(50);
    expect(last.next).toBeUndefined();
    expect(host.resources.get).toHaveBeenCalledTimes(250);
    expect(formatIndex(parseIndex("/b\tr2\tb\n/a\tr1\ta\nbroken"))).toBe("/a\tr1\ta\n/b\tr2\tb");
  });

  it("the stored report stays small and a failed write does not fail the sync (review #5)", async () => {
    const files: Record<string, string> = { ...FILES };
    for (let i = 0; i < 600; i++) files[`/work/bad/b${String(i).padStart(3, "0")}.sql`] = `/* ---\nid: bad id ${"x".repeat(300)}\n--- */\nSELECT 1`;
    const { host, store } = fakeHost(files);
    const report = await sync(ctxOf(host));
    expect(report.skipped.length).toBe(600);
    const stored = JSON.parse(store.get("lastReport")!);
    expect(stored.skipped.length).toBe(300);
    expect(stored.skippedTotal).toBe(600);
    expect(stored.skipped[0].detail.length).toBe(200);
    expect(JSON.stringify(stored).length).toBeLessThan(256 * 1024);
    const page = await registry().pages.index.render(ctxOf(host));
    expect(page.view.find((n: any) => n.id === "more").text).toContain("300 more");
    expect(page.view.find((n: any) => n.id === "summary").text).toBe("2 queries indexed, 600 skipped, 0 missing");
    host.storage.set = vi.fn(async () => Promise.reject(hostError("invalid", { reason: "tooLarge" })));
    await expect(sync(ctxOf(host))).resolves.toMatchObject({ indexed: 2 });
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
    const res = await reg.actions.reindex(ctxOf(host, { runId: "run-x" }));
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
    // review #17: a relative path would read the plugin's own folder, so it is refused
    host.settings.get = vi.fn(async () => "mapping.yaml");
    const rel = JSON.parse((await reg.actions.mapping(ctxOf(host))).output.text);
    expect(rel.problem).toBe("mappingNotAbsolute");
    expect(host.files.readText).not.toHaveBeenCalledWith("mapping.yaml");
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
    expect(await sentOf(ctxOf(host), "run1")).toBe(input.sql);
    expect([...store.keys()].filter((k) => k.startsWith("lastSent"))).toEqual([]);
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
    await registry().actions.run(ctxOf(host, { resource, runId: "r2", params: { n: "5" } }), {});
    expect(host.actions.call.mock.calls[0][1].sql).toBe("SELECT * FROM shop.customers LIMIT '5'");
  });

  it("saves as SQL through the SQL plugin's create, with declarations and the values typed", async () => {
    const { host } = fakeHost(FILES);
    host.actions.call = vi.fn(async () => ({ output: { type: "link", label: "Recent orders", target: "resource:q9" } }));
    const resource = await entry(host, "sales.orders.recent");
    const res = await registry().actions.saveAsSql(ctxOf(host, { resource, runId: "r3", params: { since: "2026-01-01T00:00", status: "", as_of: "2026-02-01T00:00" } }), {});
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.target).toBe("resource:q9");
    const [action, input] = host.actions.call.mock.calls[0];
    expect(action).toBe("org.onedesk.sql:create");
    expect(input).toMatchObject({ name: "Recent orders", description: "Orders since a time", source: "s1", params: { since: "2026-01-01T00:00", as_of: "2026-02-01T00:00" } });
    expect(input.sql.split("\n").slice(0, 3)).toEqual(["-- @param since type=datetime required -- from when", "-- @param status values=paid|refunded", "-- @param as_of type=datetime"]);
    expect(input.sql).toContain("FROM (SELECT * FROM (SELECT DISTINCT ON (order_id)");
    expect(input.sql).not.toContain("{{");
  });

  it("outside a run the data source cannot be called, like the real kernel", async () => {
    const { host } = fakeHost(FILES);
    host.params.get = vi.fn(async (n: string) => (n === "datasource" ? { found: true, value: "Prod", sourceName: "dev" } : { found: false, value: "" }));
    const resource = await entry(host, "sales.top");
    await expect(registry().actions.run(ctxOf(host, { resource, params: { n: "5" } }), {})).rejects.toMatchObject({ code: "denied", params: { reason: "notInRun" } });
  });

  it("sent statements share one key: the newest 30, each cut at 6000 characters; a failed write does not fail the run (review #2)", async () => {
    const { host, store } = fakeHost(FILES);
    for (let i = 0; i < 1200; i++) await rememberSent(ctxOf(host), `run${i}`, `SELECT ${i}`);
    expect(store.size).toBe(1);
    expect(await sentOf(ctxOf(host), "run1199")).toBe("SELECT 1199");
    expect(await sentOf(ctxOf(host), "run1170")).toBe("SELECT 1170");
    expect(await sentOf(ctxOf(host), "run1169")).toBeNull();
    await rememberSent(ctxOf(host), "big", `SELECT '${"x".repeat(300000)}'`);
    expect((await sentOf(ctxOf(host), "big"))!.length).toBeLessThan(6100);
    host.params.get = vi.fn(async (n: string) => (n === "datasource" ? { found: true, value: "Prod", sourceName: "dev" } : { found: false, value: "" }));
    const resource = await entry(host, "sales.top");
    host.storage.set = vi.fn(async () => Promise.reject(hostError("invalid", { reason: "tooManyKeys" })));
    await expect(registry().actions.run(ctxOf(host, { resource, runId: "r9", params: { n: "1" } }), {})).resolves.toBeTruthy();
  });

  it("E and U& before a parameter make an escape string: backslashes are doubled too (review #9)", () => {
    expect(renderSql("SELECT E:v, U&:v, :v, e :v, LIKE:v", { v: "a\\' OR 1=1 --" }, [])).toBe(
      "SELECT E'a\\\\'' OR 1=1 --', U&'a\\\\'' OR 1=1 --', 'a\\'' OR 1=1 --', e 'a\\'' OR 1=1 --', LIKE'a\\'' OR 1=1 --'",
    );
    expect(renderSql("SELECT E:v", { v: "" }, [])).toBe("SELECT ENULL");
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

describe("catalog: on a data source's page", () => {
  it("lists the catalog queries whose header names this data source, by id or name", async () => {
    const files = { ...FILES, "/work/byid.sql": "-- ---\n-- id: x.byid\n-- datasource: s1\n-- ---\nSELECT 1" };
    const { host } = fakeHost(files);
    await sync(ctxOf(host));
    const res = await registry().actions.queriesHere(ctxOf(host, { runId: "q1", resource: { id: "s1", name: "Prod" } }), {});
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.rows).toEqual([
      ["sales.orders.recent", "Recent orders", "/work/sales/orders.sql"],
      ["x.byid", "x.byid", "/work/byid.sql"],
    ]);
    expect(res.summary.message).toBe("2 catalog queries use Prod");
    await expect(registry().actions.queriesHere(ctxOf(host, { runId: "q2" }), {})).rejects.toThrow("No data source");
  });
});

describe("catalog: manifest", () => {
  it("may read data sources: an action on the data source kind and a dependency on its plugin (kernel foreign_kinds, review #21)", () => {
    // mirrors crates/kernel/src/manifest.rs foreign_kinds + deps.rs export_allows
    const foreign = manifest.contributes.actions.flatMap((a: any) => a.kinds ?? []).filter((k: string) => k.includes(":") && !k.startsWith(`${manifest.id}:`));
    expect(foreign).toContain("org.onedesk.datasource:source");
    expect(manifest.depends.map((d: any) => d.id)).toContain("org.onedesk.datasource");
  });
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

describe("catalog: for AI clients (round 19)", () => {
  const act = (id: string) => manifest.contributes.actions.find((a: any) => a.id === id);
  const entryCtx = async (host: Host, extra: Record<string, unknown> = {}) => {
    await sync(ctxOf(host));
    const all = await host.resources.list({ kind: "entry" });
    return ctxOf(host, { resource: all.find((r: any) => r.body.id === "sales.orders.recent"), ...extra });
  };

  it("only `run` is AI-usable (read-only); saving or re-indexing is not", () => {
    for (const a of manifest.contributes.actions) {
      if (a.id === "run") expect(a.ai).toEqual({ readOnly: true, description: "ai.runDesc", describe: "aiParams" });
      else expect(a.ai, a.id).toBeUndefined();
    }
    expect(act("aiParams")).toMatchObject({ output: "none", confirm: null });
    expect(act("aiParams").kinds).toBeUndefined();
  });

  it("describes the header's parameters, and as_of for a versioned entity", async () => {
    const { host } = fakeHost(FILES);
    const res = await registry().actions.aiParams(await entryCtx(host), {});
    expect(res.output).toEqual({ type: "none" });
    const by = Object.fromEntries(res.data.params.map((p: any) => [p.name, p]));
    expect(Object.keys(by).sort()).toEqual(["as_of", "since", "status"]);
    expect(by.since.type).toBe("text");
    expect(by.since.description).toContain("YYYY-MM-DDTHH:MM");
    expect(by.status.type).toBe("enum");
    expect(by.status.options.length).toBeGreaterThan(0);
    expect(by.as_of.type).toBe("text");
  });

  it("still describes without a readable mapping (a pure call)", async () => {
    const { host } = fakeHost(FILES);
    const ctx: Record<string, any> = await entryCtx(host);
    host.files = { roots: async () => { throw hostError("denied", {}); }, readText: async () => { throw hostError("denied", {}); } };
    const res = await registry().actions.aiParams({ ...ctx, host: { ...ctx.host, files: host.files } }, {});
    expect(Array.isArray(res.data.params)).toBe(true);
  });

  it("has the new texts in every language", () => {
    for (const k of Object.keys(EN).filter((k) => k.startsWith("ai.") || k === "action.aiParams")) {
      expect(ZH[k], k).toBeTruthy();
      expect(JA[k], k).toBeTruthy();
    }
  });
});
