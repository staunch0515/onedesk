// Table plugin: the tables and columns of the catalog's mapping (read through the catalog's exported
// `mapping` action, so both read the same file). A provided tree groups tables by the prefix of their name
// (one or two levels, switched from the tree's toolbar); tables the database does not have are marked
// missing. A table's page shows its description, where it comes from and its columns to tick, fetches rows,
// and for time-versioned tables runs five version queries: current version, history of one record, state
// at a moment, changes in a period, deleted records. Queries run through the data source's read-only `query`.
// Sandbox rules: no console, timers or fetch; everything through ctx.host.

export const PLUGIN = "org.onedesk.table";
export const TREE = "tables";
export const DATASOURCE = "org.onedesk.datasource";
export const SOURCE_KIND = "org.onedesk.datasource:source";
export const CATALOG_MAPPING = "org.onedesk.catalog:mapping";
const DEPTH_KEY = "depth";
const SNAPSHOT_KEY = "snapshot";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100000;
const COL = "col.";

/* ---------------------------------------------------------------- text */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

/* ---------------------------------------------------------------- SQL pieces */

// PostgreSQL's reserved words: as names they need quotes.
const RESERVED = new Set(
  "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric system_user table then to trailing true union unique user using variadic when where window with".split(" "),
);

// A name as SQL: plain lower-case names stay as they are, others (and reserved words) are double-quoted
// (quotes doubled). `schema.table` is quoted part by part.
export function quoteIdent(name) {
  return String(name)
    .split(".")
    .map((p) => (/^[a-z_][a-z0-9_$]*$/.test(p) && !RESERVED.has(p) ? p : `"${p.replace(/"/g, '""')}"`))
    .join(".");
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  const v = String(value);
  if (v.includes("\0")) throw new Error("NUL");
  return `'${v.replace(/'/g, "''")}'`;
}

// A datetime form value (UTC without a zone) as a timestamptz expression.
export function timeLiteral(value) {
  const v = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d\d:\d\d)?$/.test(v)) return null;
  const zoned = /Z$|[+-]\d\d:\d\d$/.test(v) ? v : v.length === 10 ? `${v}T00:00:00Z` : v.length === 16 ? `${v}:00Z` : `${v}Z`;
  return `CAST(${sqlLiteral(zoned)} AS timestamptz)`;
}

// The select list: the chosen fields (all when none) as `column` or `column AS field`.
export function selectList(entity, chosen) {
  const fields = (chosen || []).filter((f) => entity.columns[f]);
  if (fields.length === 0) return "*";
  return fields
    .map((f) => {
      const c = entity.columns[f].column;
      return c === f ? quoteIdent(c) : `${quoteIdent(c)} AS ${quoteIdent(f)}`;
    })
    .join(", ");
}

function limitOf(limit) {
  const n = Number(limit);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

function versionedOf(entity) {
  if (!entity.versioned) throw Object.assign(new Error("notVersioned"), { reason: "notVersioned" });
  return entity.versioned;
}

const keyList = (v) => v.key.map(quoteIdent).join(", ");

// Latest version per key, among versions that started at or before `at` (and, with `to`, had not ended by then).
function latestAt(entity, at) {
  const v = versionedOf(entity);
  let where = `${quoteIdent(v.from)} <= ${at}`;
  if (v.to) where += ` AND (${quoteIdent(v.to)} IS NULL OR ${quoteIdent(v.to)} > ${at})`;
  return `SELECT DISTINCT ON (${keyList(v)}) * FROM ${quoteIdent(entity.table)} WHERE ${where} ORDER BY ${keyList(v)}, ${quoteIdent(v.from)} DESC`;
}

const notDeleted = (v) => (v.deleted ? ` WHERE NOT od_v.${quoteIdent(v.deleted)}` : "");

export function rowsSql(entity, chosen, limit) {
  return `SELECT ${selectList(entity, chosen)} FROM ${quoteIdent(entity.table)} LIMIT ${limitOf(limit)}`;
}

// 1. Current version of every record.
export function currentSql(entity, chosen, limit) {
  const v = versionedOf(entity);
  return `SELECT ${selectList(entity, chosen)} FROM (${latestAt(entity, "now()")}) AS od_v${notDeleted(v)} LIMIT ${limitOf(limit)}`;
}

// 2. Every version of one record, oldest first. `keyValues`: one value per key column, comma-separated.
export function historySql(entity, chosen, keyValues) {
  const v = versionedOf(entity);
  const values = String(keyValues === undefined || keyValues === null ? "" : keyValues)
    .split(",")
    .map((s) => s.trim());
  if (values.length !== v.key.length || values.some((s) => s === "")) throw Object.assign(new Error("key"), { reason: "key" });
  const where = v.key.map((k, i) => `${quoteIdent(k)} = ${sqlLiteral(values[i])}`).join(" AND ");
  return `SELECT ${selectList(entity, chosen)} FROM ${quoteIdent(entity.table)} WHERE ${where} ORDER BY ${quoteIdent(v.from)}`;
}

// 3. The state of every record at a moment.
export function atSql(entity, chosen, at, limit) {
  const v = versionedOf(entity);
  const t = timeLiteral(at);
  if (!t) throw Object.assign(new Error("at"), { reason: "at" });
  return `SELECT ${selectList(entity, chosen)} FROM (${latestAt(entity, t)}) AS od_v${notDeleted(v)} LIMIT ${limitOf(limit)}`;
}

// 4. Versions that started in [from, to), in order.
export function changesSql(entity, chosen, from, to, limit) {
  const v = versionedOf(entity);
  const a = timeLiteral(from);
  const b = timeLiteral(to);
  if (!a || !b) throw Object.assign(new Error("period"), { reason: "period" });
  const f = quoteIdent(v.from);
  return `SELECT ${selectList(entity, chosen)} FROM ${quoteIdent(entity.table)} WHERE ${f} >= ${a} AND ${f} < ${b} ORDER BY ${f}, ${keyList(v)} LIMIT ${limitOf(limit)}`;
}

// 5. Records whose latest version is a deletion (the `deleted` flag), or — without one — has ended.
export function deletedSql(entity, chosen, limit) {
  const v = versionedOf(entity);
  const latest = `SELECT DISTINCT ON (${keyList(v)}) * FROM ${quoteIdent(entity.table)} ORDER BY ${keyList(v)}, ${quoteIdent(v.from)} DESC`;
  let cond;
  if (v.deleted) cond = `od_v.${quoteIdent(v.deleted)}`;
  else if (v.to) cond = `od_v.${quoteIdent(v.to)} IS NOT NULL AND od_v.${quoteIdent(v.to)} <= now()`;
  else throw Object.assign(new Error("noDeleted"), { reason: "noDeleted" });
  return `SELECT ${selectList(entity, chosen)} FROM (${latest}) AS od_v WHERE ${cond} LIMIT ${limitOf(limit)}`;
}

// Which tables the database has: every `schema.table`, and `table` alone for the public schema. Names keep
// their case: a query names a table exactly as the mapping writes it (quoteIdent quotes anything that is not
// plain lower case), so `Orders` exists only if the database has `Orders`, not `orders`.
export const EXISTING_SQL =
  "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2";

export function existingSet(rows) {
  const out = new Set();
  for (const r of rows || []) {
    const [schema, name] = [String(r[0]), String(r[1])];
    out.add(`${schema}.${name}`);
    if (schema === "public") out.add(name);
  }
  return out;
}

export function isMissing(entity, existing) {
  if (!existing) return false;
  const t = String(entity.table);
  return !existing.has(t) && !(t.indexOf(".") < 0 && existing.has(`public.${t}`));
}

/* ---------------------------------------------------------------- tree (H1–H3) */

// Name of a table without its schema.
export function baseName(table) {
  const parts = String(table).split(".");
  return parts[parts.length - 1];
}

// Prefix groups of a table name: "order_line_tax" → ["order", "order_line"] (two levels) or ["order"] (one).
export function prefixesOf(table, depth) {
  const parts = baseName(table).split("_").filter(Boolean);
  const out = [];
  for (let i = 1; i <= Math.min(depth, parts.length - 1); i++) out.push(parts.slice(0, i).join("_"));
  return out;
}

const G = "g:";
const T = "t:";
const C = "c:";

export const nodeTarget = (key) => `node:${PLUGIN}:${TREE}/${encodeURIComponent(key)}`;

// Nodes under `parentKey` ("" = root). `snapshot` = { mapping, existing: string[] | null }.
export function treeChildren(snapshot, parentKey, depth, missingBadge) {
  const entities = (snapshot.mapping && snapshot.mapping.entities) || {};
  const existing = snapshot.existing ? new Set(snapshot.existing) : null;
  if (parentKey.startsWith(T)) {
    const name = parentKey.slice(T.length);
    const e = entities[name];
    if (!e) return [];
    return Object.keys(e.columns).map((f) => {
      const c = e.columns[f];
      const n = { key: `${C}${name}.${f}`, label: f, icon: "columns-3", expandable: false, target: nodeTarget(parentKey) };
      if (c.column !== f) n.badge = c.column;
      return n;
    });
  }
  const parent = parentKey.startsWith(G) ? parentKey.slice(G.length) : "";
  const groups = new Set();
  const tables = [];
  for (const name of Object.keys(entities)) {
    const e = entities[name];
    const ps = prefixesOf(e.table, depth);
    const at = ps.length ? ps[ps.length - 1] : "";
    if (at === parent) tables.push(name);
    const idx = parent ? ps.indexOf(parent) : -1;
    const child = parent ? (idx >= 0 ? ps[idx + 1] : undefined) : ps[0];
    if (child) groups.add(child);
  }
  const g = [...groups].sort().map((k) => ({ key: G + k, label: `${k}_*`, icon: "folder", expandable: true }));
  const t = tables
    .sort((a, b) => (baseName(entities[a].table) < baseName(entities[b].table) ? -1 : 1))
    .map((name) => {
      const e = entities[name];
      const n = { key: T + name, label: baseName(e.table), icon: e.versioned ? "history" : "table", expandable: Object.keys(e.columns).length > 0, target: nodeTarget(T + name) };
      if (name !== baseName(e.table)) n.badge = name;
      if (isMissing(e, existing)) {
        // Provided nodes cannot carry a state yet (the kernel sets `ok`; round16-plugins-done.md): the warning
        // icon and a badge say "missing" until they can.
        n.icon = "triangle-alert";
        n.badge = missingBadge || "missing";
      }
      return n;
    });
  return [...g, ...t];
}

export function treePath(snapshot, key, depth) {
  const entities = (snapshot.mapping && snapshot.mapping.entities) || {};
  if (key.startsWith(G)) {
    const k = key.slice(G.length);
    return prefixesOf(`${k}_x`, depth).map((p) => G + p).filter((p) => p.length <= key.length);
  }
  const name = key.startsWith(C) ? key.slice(C.length).split(".")[0] : key.slice(T.length);
  const e = entities[name];
  if (!e) return [key];
  const chain = [...prefixesOf(e.table, depth).map((p) => G + p), T + name];
  return key.startsWith(C) ? [...chain, key] : chain;
}

/* ---------------------------------------------------------------- storage */

// D421: `actions.call` works only inside a run. The "refresh" action reads the mapping and the database's
// tables there and stores them; the tree and the page only read what was stored.
const CHUNK = 100000; // characters per storage value: stays under 256 KB even if every character is escaped
const MAX_CHUNKS = 40;

// Writes `text` as `key` (a small header) plus `key.0`, `key.1`, …; removes chunks left from a longer value.
export async function putChunked(ctx, key, text) {
  const n = Math.max(1, Math.ceil(text.length / CHUNK));
  if (n > MAX_CHUNKS) throw new Error(tr(ctx, "error.snapshotTooLarge"));
  const old = await readHeader(ctx, key);
  for (let i = 0; i < n; i++) await ctx.host.storage.set(`${key}.${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
  for (let i = n; i < (old ? old.chunks : 0); i++) await ctx.host.storage.remove(`${key}.${i}`);
  await ctx.host.storage.set(key, JSON.stringify({ chunks: n, length: text.length }));
}

async function readHeader(ctx, key) {
  const raw = await ctx.host.storage.get(key);
  if (!raw) return null;
  try {
    const h = JSON.parse(raw);
    return h && Number.isInteger(h.chunks) ? h : null;
  } catch (e) {
    return null;
  }
}

export async function getChunked(ctx, key) {
  const h = await readHeader(ctx, key);
  if (!h) return null;
  let text = "";
  for (let i = 0; i < h.chunks; i++) {
    const part = await ctx.host.storage.get(`${key}.${i}`);
    if (typeof part !== "string") return null;
    text += part;
  }
  return text.length === h.length ? text : null;
}

// The statements runs sent, newest first, in one key: at most SENT_RUNS of them and SENT_MAX characters each
// (review #2: one key per run would fill the plugin's 1000 keys). Writing it never fails the run.
const SENT_KEY = "sent";
const SENT_RUNS = 30;
const SENT_MAX = 6000;

export async function rememberSent(ctx, runId, sql) {
  try {
    let list = [];
    const raw = await ctx.host.storage.get(SENT_KEY);
    if (raw) list = JSON.parse(raw);
    if (!Array.isArray(list)) list = [];
    const text = sql.length > SENT_MAX ? `${sql.slice(0, SENT_MAX)}\n-- …` : sql;
    list = [{ run: runId || "-", sql: text }, ...list.filter((x) => x && x.run !== runId)].slice(0, SENT_RUNS);
    await ctx.host.storage.set(SENT_KEY, JSON.stringify(list));
  } catch (e) {
    /* only a convenience: the run goes on */
  }
}

export async function sentOf(ctx, runId) {
  try {
    const list = JSON.parse((await ctx.host.storage.get(SENT_KEY)) || "[]");
    const hit = Array.isArray(list) ? list.find((x) => x && x.run === runId) : null;
    return hit ? hit.sql : null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------- host (inside runs) */

export async function readMapping(ctx) {
  const res = await ctx.host.actions.call(CATALOG_MAPPING, {});
  if (!res || !res.output || res.output.type !== "text") throw new Error(tr(ctx, "error.mapping"));
  const m = JSON.parse(res.output.text);
  return { path: m.path || "", entities: m.entities || {}, problem: m.problem || "" };
}

async function sourceList(ctx) {
  try {
    const all = (await ctx.host.resources.list({ kind: SOURCE_KIND })) || [];
    return Array.isArray(all) ? all : all.items || [];
  } catch (e) {
    return [];
  }
}

// The environment's `datasource`, else the workspace's `datasource.default`; "" when there is none.
export async function sourceId(ctx) {
  let wanted = "";
  const env = await ctx.host.params.get("datasource");
  if (env && env.found && String(env.value).trim()) wanted = String(env.value).trim();
  if (!wanted) {
    const def = await ctx.host.params.config("datasource.default");
    if (def && def.found && String(def.value).trim()) wanted = String(def.value).trim();
  }
  if (!wanted) return "";
  const list = await sourceList(ctx);
  const hit = list.find((r) => r.id === wanted) || list.find((r) => r.name === wanted);
  return hit ? hit.id : "";
}

async function query(ctx, sql, source) {
  const res = await ctx.host.actions.call(`${DATASOURCE}:query`, { sql }, { resource: source });
  if (res && typeof res.error === "string") throw new Error(res.error);
  if (!res || !res.output || res.output.type !== "table") throw new Error(tr(ctx, "error.noResult"));
  return res;
}

// In a run: the mapping plus which of its tables the database has (`existing` null when no data source is set
// or it cannot be reached), stored for the tree and the page.
// `sourceGiven`: a data source chosen by the user (the action on a data source's page), else the environment's.
export async function refreshSnapshot(ctx, sourceGiven) {
  const mapping = await readMapping(ctx);
  let existing = null;
  let error = "";
  const source = sourceGiven || (await sourceId(ctx));
  if (source) {
    try {
      const all = existingSet((await query(ctx, EXISTING_SQL, source)).output.rows);
      // only what the tree needs: the mapping's tables the database has
      existing = Object.keys(mapping.entities)
        .map((n) => mapping.entities[n].table)
        .filter((t) => !isMissing({ table: t }, all));
    } catch (e) {
      error = String((e && e.message) || e);
    }
  }
  const snap = { at: Date.now(), mapping, existing, error };
  await putChunked(ctx, SNAPSHOT_KEY, JSON.stringify(snap));
  return snap;
}

// The stored snapshot, or null when there is none yet (outside runs nothing is fetched).
export async function snapshot(ctx) {
  const text = await getChunked(ctx, SNAPSHOT_KEY);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

export async function depthOf(ctx) {
  return (await ctx.host.storage.get(DEPTH_KEY)) === "2" ? 2 : 1;
}

function entityOfNode(ctx, snap) {
  const key = decodeURIComponent((ctx.node && ctx.node.key) || "");
  const name = key.startsWith(C) ? key.slice(C.length).split(".")[0] : key.slice(T.length);
  const e = snap.mapping.entities[name];
  if (!e) throw new Error(tr(ctx, "error.noTable", { name }));
  return { name, entity: e };
}

const OVERVIEW = `page:${PLUGIN}/overview`;

function notLoadedNode(ctx) {
  return { key: "none", label: tr(ctx, "tree.notLoaded"), icon: "refresh-cw", expandable: false, target: OVERVIEW };
}

function refreshedText(ctx, snap) {
  const names = Object.keys(snap.mapping.entities);
  if (!snap.existing) return tr(ctx, "message.refreshedNoSource", { count: names.length });
  const have = new Set(snap.existing);
  const missing = names.filter((n) => isMissing(snap.mapping.entities[n], have)).length;
  return tr(ctx, "message.refreshed", { count: names.length, missing });
}

function chosenOf(ctx, entity) {
  const p = ctx.params || {};
  return Object.keys(entity.columns).filter((f) => p[COL + f] === "true");
}

const pad = (n) => String(n).padStart(2, "0");
const formatDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function presets(ctx, now) {
  const day = (o) => `${formatDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + o)))}T00:00`;
  return [
    { value: `${formatDay(now)}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`, label: ctx.t("preset.now") },
    { value: day(0), label: ctx.t("preset.today") },
    { value: day(-1), label: ctx.t("preset.yesterday") },
    { value: day(-7), label: ctx.t("preset.week") },
  ];
}

const QUERIES = {
  current: (e, ch, p) => currentSql(e, ch, p.limit),
  history: (e, ch, p) => historySql(e, ch, p.key),
  at: (e, ch, p) => atSql(e, ch, p.at, p.limit),
  changes: (e, ch, p) => changesSql(e, ch, p.from, p.to, p.limit),
  deleted: (e, ch, p) => deletedSql(e, ch, p.limit),
  rows: (e, ch, p) => rowsSql(e, ch, p.limit),
};

// The SQL of one of the page's actions, or throws an Error with the reason's text.
export function sqlFor(ctx, action, entity, chosen, params) {
  try {
    return QUERIES[action](entity, chosen, params || {});
  } catch (e) {
    if (e && e.reason) throw new Error(tr(ctx, `error.${e.reason}`, { key: entity.versioned ? entity.versioned.key.join(", ") : "" }));
    throw e;
  }
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.trees.handle(TREE, {
      async children(ctx, parentKey) {
        const snap = await snapshot(ctx);
        if (!snap) return { nodes: (parentKey || "") === "" ? [notLoadedNode(ctx)] : [] };
        return { nodes: treeChildren(snap, parentKey || "", await depthOf(ctx), tr(ctx, "badge.missing")) };
      },
      async path(ctx, key) {
        const snap = await snapshot(ctx);
        return snap ? treePath(snap, key, await depthOf(ctx)) : [key];
      },
    });

    // X9: the toolbar switch between one and two levels of prefix groups.
    host.commands.handle("toggleDepth", async (ctx) => {
      const next = (await depthOf(ctx)) === 2 ? 1 : 2;
      await ctx.host.storage.set(DEPTH_KEY, String(next));
      return [{ type: "toast", message: tr(ctx, next === 2 ? "message.depth2" : "message.depth1"), tone: "info" }];
    });

    // A command cannot run anything (D421): it opens the page whose action refreshes.
    host.commands.handle("refresh", async () => [{ type: "open", target: OVERVIEW }]);

    host.actions.handle("refresh", async (ctx) => {
      ctx.progress(undefined, tr(ctx, "step.refreshing"));
      const snap = await refreshSnapshot(ctx);
      return { output: { type: "text", text: refreshedText(ctx, snap) }, summary: { message: refreshedText(ctx, snap) } };
    });

    // On a data source's page (review #21): read the tables of this database. Declaring an action on the data
    // source kind is also what lets this plugin list data sources (the kernel's `foreign_kinds`).
    host.actions.handle("tablesHere", async (ctx) => {
      const src = ctx.resource;
      if (!src || !src.id) throw new Error(tr(ctx, "error.noSource"));
      ctx.progress(undefined, tr(ctx, "step.refreshing"));
      const snap = await refreshSnapshot(ctx, src.id);
      return { output: { type: "text", text: refreshedText(ctx, snap) }, summary: { message: refreshedText(ctx, snap) } };
    });

    host.pages.handle("overview", {
      async render(ctx) {
        const snap = await snapshot(ctx);
        const view = [{ type: "text", id: "about", text: tr(ctx, "overview.about"), tone: "muted" }];
        if (!snap) view.push({ type: "text", id: "none", text: tr(ctx, "overview.none") });
        else {
          view.push({ type: "text", id: "summary", text: refreshedText(ctx, snap) });
          if (snap.error) view.push({ type: "text", id: "error", text: tr(ctx, "warn.sourceFailed", { error: snap.error }), tone: "danger" });
        }
        return { view, title: tr(ctx, "overview.title"), icon: "table" };
      },
    });

    host.pages.handle("table", {
      async render(ctx) {
        const snap = await snapshot(ctx);
        if (!snap) return { view: [{ type: "text", id: "none", text: tr(ctx, "overview.none") }], title: tr(ctx, "overview.title"), icon: "table" };
        const { name, entity } = entityOfNode(ctx, snap);
        const view = [];
        if (snap.mapping.problem) view.push({ type: "text", id: "mapping", text: tr(ctx, "warn.mapping"), tone: "danger" });
        if (isMissing(entity, snap.existing ? new Set(snap.existing) : null)) view.push({ type: "text", id: "missing", text: tr(ctx, "warn.missing", { table: entity.table }), tone: "danger" });
        if (entity.description) view.push({ type: "text", id: "description", text: entity.description });
        const facts = [tr(ctx, "info.source", { path: snap.mapping.path || "-", entity: name, table: entity.table })];
        if (entity.versioned) {
          const v = entity.versioned;
          facts.push(tr(ctx, "info.versioned", { key: v.key.join(", "), from: v.from, to: v.to || "-", deleted: v.deleted || "-" }));
        }
        view.push({ type: "text", id: "facts", text: facts.join("\n"), tone: "muted" });

        const cols = Object.keys(entity.columns).map((f) => {
          const c = entity.columns[f];
          const field = { name: COL + f, label: f, kind: "boolean", param: true };
          const hint = [c.column !== f ? c.column : "", c.description].filter(Boolean).join(" · ");
          if (hint) field.hint = hint;
          if (ctx.run) (field.envValue = (ctx.run.params && ctx.run.params[COL + f]) || ""), (field.readOnly = true);
          return field;
        });
        if (cols.length) view.push({ type: "form", id: "columns", layout: "strip", label: ctx.t("form.columns"), fields: cols });

        const now = new Date();
        const inputs = [{ name: "limit", label: ctx.t("field.limit"), kind: "number", param: true, placeholder: String(DEFAULT_LIMIT) }];
        if (entity.versioned) {
          inputs.push(
            { name: "key", label: ctx.t("field.key"), kind: "text", param: true, hint: tr(ctx, "field.key.hint", { key: entity.versioned.key.join(", ") }) },
            { name: "at", label: ctx.t("field.at"), kind: "datetime", param: true, presets: presets(ctx, now), hint: tr(ctx, "hint.utc") },
            { name: "from", label: ctx.t("field.from"), kind: "datetime", param: true, presets: presets(ctx, now), hint: tr(ctx, "hint.utc") },
            { name: "to", label: ctx.t("field.to"), kind: "datetime", param: true, presets: presets(ctx, now), hint: tr(ctx, "hint.utc") },
          );
        } else view.push({ type: "text", id: "plain", text: tr(ctx, "info.notVersioned"), tone: "muted" });
        if (ctx.run) for (const f of inputs) (f.envValue = (ctx.run.params && ctx.run.params[f.name]) || ""), (f.readOnly = true);
        view.push({ type: "form", id: "inputs", layout: "strip", fields: inputs });
        return { view, title: baseName(entity.table), icon: entity.versioned ? "history" : "table" };
      },

      async renderResultTab(ctx, tabId) {
        if (tabId !== "sent") throw new Error(`unknown result tab ${tabId}`);
        const raw = ctx.run ? await sentOf(ctx, ctx.run.id) : null;
        if (!raw) return [{ type: "text", id: "none", text: tr(ctx, "sent.none"), tone: "muted" }];
        return [{ type: "text", id: "sent", text: raw, mono: true, language: "sql" }];
      },
    });

    for (const action of Object.keys(QUERIES)) {
      host.actions.handle(action, async (ctx) => {
        // in a run: without a stored snapshot, take one now
        const snap = (await snapshot(ctx)) || (await refreshSnapshot(ctx));
        const { entity } = entityOfNode(ctx, snap);
        const sql = sqlFor(ctx, action, entity, chosenOf(ctx, entity), ctx.params || {});
        await rememberSent(ctx, ctx.runId, sql);
        const source = await sourceId(ctx);
        if (!source) throw new Error(tr(ctx, "error.noSource"));
        ctx.progress(undefined, tr(ctx, "step.running"));
        const res = await query(ctx, sql, source);
        return { output: res.output, summary: res.summary };
      });
    }
  },
};
