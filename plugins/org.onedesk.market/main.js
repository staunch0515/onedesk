// Plugin market (local): scans plugin packages in authorized folders, lists their state and asks the
// framework to install one with host.plugins.requestInstall. It only reads display fields of manifests;
// permissions are listed by the framework's own confirmation dialog.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export const MAX_PACKAGES = 200;
export const MAX_PROBES = 400;
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 300;
const PAGE_SIZE = 200;
const MAX_LIST_PAGES = 20;

/* ---------------------------------------------------------------- helpers */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// Numeric semver comparison of the x.y.z part; a pre-release sorts below its release. Returns -1, 0 or 1.
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v).split("+")[0].split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// How a package stands against `host.plugins.list()` entries ({ id, name, versions, active }).
export function statusOf(pkg, installed) {
  const entry = installed.find((p) => p.id === pkg.id);
  if (!entry || !entry.versions || entry.versions.length === 0) return { kind: "notInstalled" };
  if (entry.versions.includes(pkg.version)) return { kind: "installed", version: pkg.version };
  const newest = entry.versions.reduce((m, v) => (compareVersions(v, m) > 0 ? v : m), entry.versions[0]);
  if (compareVersions(pkg.version, newest) > 0) return { kind: "update", version: entry.active || newest };
  return { kind: "installed", version: entry.active || newest };
}

function isNotFound(err) {
  return !!err && err.code === "notFound";
}

// Untrusted text from a manifest or a folder name: only strings, no control or bidi-control characters, cut to `max`
// characters (code points). Anything else counts as missing ("").
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function clean(value, max) {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(UNSAFE, "").trim()).slice(0, max).join("");
}

async function listDirs(ctx, path) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const page = await ctx.host.files.list(path, { offset, limit: PAGE_SIZE });
    for (const e of page.entries) if (e.dir && !e.hidden && !e.name.startsWith(".")) out.push(e);
    if (page.next === undefined || page.next === null) break;
    offset = page.next;
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// Reads `<dir>/manifest.json`. Returns { found: false } only when the file does not exist; other problems
// make the package "unavailable" with a reason.
async function readPackage(ctx, dir) {
  const label = clean(dir.name, MAX_NAME);
  let file;
  try {
    file = await ctx.host.files.readText(`${dir.path}/manifest.json`);
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    return { found: true, pkg: { folder: dir.path, label, unavailable: "reason.unreadable" } };
  }
  let m;
  try {
    m = JSON.parse(file.text);
  } catch (e) {
    return { found: true, pkg: { folder: dir.path, label, unavailable: "reason.invalidJson" } };
  }
  if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.version !== "string" || !m.id || !m.version) {
    return { found: true, pkg: { folder: dir.path, label, unavailable: "reason.missingFields" } };
  }
  return { found: true, pkg: { folder: dir.path, label, id: m.id, version: m.version, manifest: m } };
}

// Scans `<root>/*/manifest.json` and `<root>/*/*/manifest.json`. At most MAX_PACKAGES packages and MAX_PROBES
// directories looked at (all roots together); `truncated` says a limit was hit.
export async function scan(ctx, roots) {
  const packages = [];
  let probes = 0;
  let truncated = false;
  let capped = false;
  const probe = () => {
    if (probes >= MAX_PROBES) {
      truncated = true;
      return false;
    }
    probes++;
    return true;
  };
  const add = (pkg) => {
    if (packages.length >= MAX_PACKAGES) {
      capped = true;
      return false;
    }
    packages.push(pkg);
    return true;
  };
  outer: for (const root of roots) {
    let dirs;
    try {
      dirs = await listDirs(ctx, root.path);
    } catch (err) {
      continue;
    }
    for (const d of dirs) {
      if (!probe()) break outer;
      const direct = await readPackage(ctx, d);
      if (direct.found) {
        if (!add(direct.pkg)) break outer;
        continue;
      }
      let inner;
      try {
        inner = await listDirs(ctx, d.path);
      } catch (err) {
        continue;
      }
      for (const v of inner) {
        if (!probe()) break outer;
        const res = await readPackage(ctx, v);
        if (res.found && !add({ ...res.pkg, label: clean(`${d.name}/${v.name}`, MAX_NAME) })) break outer;
      }
    }
  }
  return { packages, truncated, capped };
}

// Display strings of a manifest: `name` / `description` are locale keys; the package's own locale files give the text.
// A key without a translation is never shown: the name falls back to the package id, the description stays empty.
async function describe(ctx, pkg) {
  const m = pkg.manifest;
  const out = { name: clean(pkg.id, MAX_NAME), description: "" };
  const locales = (m.contributes && m.contributes.locales) || {};
  const rel = locales[ctx.locale] || locales["en-US"];
  if (typeof rel !== "string" || rel.startsWith("/") || rel.split("/").includes("..")) return out;
  try {
    const file = await ctx.host.files.readText(`${pkg.folder}/${rel}`);
    const table = JSON.parse(file.text);
    const name = clean(table[m.name], MAX_NAME);
    const description = clean(table[m.description], MAX_DESCRIPTION);
    if (name) out.name = name;
    if (description) out.description = description;
  } catch (e) {
    // no translation: keep the fallbacks
  }
  return out;
}

function statusText(ctx, st) {
  if (st.kind === "installed") return tr(ctx, "status.installed", { version: st.version });
  if (st.kind === "update") return tr(ctx, "status.update", { version: st.version });
  return tr(ctx, "status.notInstalled");
}

// What the table needs of a scanned package, already cleaned (this is what is cached).
async function entryOf(ctx, pkg) {
  if (pkg.unavailable) return { folder: pkg.folder, name: pkg.label, description: "", unavailable: pkg.unavailable };
  const info = await describe(ctx, pkg);
  return { folder: pkg.folder, id: clean(pkg.id, MAX_NAME), version: clean(pkg.version, MAX_NAME), name: info.name, description: info.description };
}

const cacheKey = (ctx, root) => `scan:${ctx.locale}:${root.path}`;

// The scan of each authorized folder is cached in storage; `rescan` forces a new one. The probe limit is shared by
// all folders, so a rescan always goes over all of them together.
async function scanAll(ctx, roots) {
  const { packages, truncated, capped } = await scan(ctx, roots);
  const byRoot = new Map(roots.map((r) => [r.path, []]));
  for (const pkg of packages) {
    const root = roots.find((r) => pkg.folder === r.path || pkg.folder.startsWith(r.path.endsWith("/") ? r.path : `${r.path}/`));
    if (root) byRoot.get(root.path).push(await entryOf(ctx, pkg));
  }
  for (const r of roots) {
    const entries = byRoot.get(r.path);
    try {
      await ctx.host.storage.set(cacheKey(ctx, r), JSON.stringify({ entries, truncated, capped }));
    } catch (e) {
      // not cached: the next render scans again
    }
  }
  return { entries: roots.flatMap((r) => byRoot.get(r.path)), truncated, capped };
}

async function cached(ctx, roots) {
  const entries = [];
  let truncated = false;
  let capped = false;
  for (const r of roots) {
    let raw = null;
    try {
      raw = await ctx.host.storage.get(cacheKey(ctx, r));
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      if (!Array.isArray(v.entries)) return null;
      entries.push(...v.entries);
      truncated = truncated || !!v.truncated;
      capped = capped || !!v.capped;
    } catch (e) {
      return null;
    }
  }
  return { entries, truncated, capped };
}

async function load(ctx, rescan) {
  const roots = await ctx.host.files.roots();
  if (roots.length === 0) return { roots, truncated: false, capped: false, rows: [] };
  const installed = await ctx.host.plugins.list();
  const found = (!rescan && (await cached(ctx, roots))) || (await scanAll(ctx, roots));
  const rows = found.entries.map((e) => {
    if (e.unavailable) return { folder: e.folder, name: e.name, description: tr(ctx, e.unavailable), version: "", status: tr(ctx, "status.unavailable"), installable: false };
    const st = statusOf(e, installed);
    return { folder: e.folder, name: e.name, description: e.description, version: e.version, status: statusText(ctx, st), installable: st.kind !== "installed" };
  });
  return { roots, truncated: found.truncated, rows, capped: found.capped };
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.trees.handle("market", {
      async children(ctx, parentKey) {
        if (parentKey) return { nodes: [] };
        return {
          nodes: [{ key: "local", label: tr(ctx, "node.market"), icon: "store", expandable: false, target: "node:org.onedesk.market:market/local" }],
        };
      },
      async path(ctx, key) {
        return [key];
      },
    });

    host.pages.handle("browse", {
      async render(ctx) {
        const head = { title: tr(ctx, "tree.market"), icon: "store" };
        const state = await load(ctx);
        if (state.roots.length === 0) {
          return {
            ...head,
            view: [
              { type: "text", id: "empty", text: tr(ctx, "empty.title") },
              { type: "text", id: "hint", text: tr(ctx, "empty.hint"), tone: "muted" },
            ],
          };
        }
        const view = [];
        if (state.rows.length === 0) {
          view.push({ type: "text", id: "none", text: tr(ctx, "none.found"), tone: "muted" });
        } else {
          view.push({
            type: "table",
            id: "packages",
            columns: [
              { key: "name", label: tr(ctx, "col.name") },
              { key: "version", label: tr(ctx, "col.version") },
              { key: "description", label: tr(ctx, "col.description") },
              { key: "status", label: tr(ctx, "col.status") },
            ],
            rows: state.rows.map((r) => [r.name, r.version, r.description, r.status]),
          });
        }
        if (state.truncated || state.capped) view.push({ type: "text", id: "capped", text: tr(ctx, state.truncated ? "truncated" : "capped", { max: state.truncated ? MAX_PROBES : MAX_PACKAGES }), tone: "muted" });
        const options = state.rows.filter((r) => r.installable).map((r) => ({ value: r.folder, label: `${r.name} ${r.version}` }));
        view.push({
          type: "form",
          id: "pick",
          layout: "strip",
          fields: [{ name: "pick", label: ctx.t("field.pick"), kind: "enum", param: true, options, placeholder: ctx.t("field.pick.placeholder") }],
        });
        return { ...head, view };
      },

      async onEvent(ctx, event) {
        if (event === "refresh") {
          await load(ctx, true);
          return { message: tr(ctx, "message.refreshed") };
        }
        if (event !== "install") throw new Error(`unknown event ${event}`);
        // The pick is a page parameter (never part of the draft): it comes in `ctx.params`.
        const folder = ctx.params && typeof ctx.params.pick === "string" ? ctx.params.pick : "";
        if (!folder) return { message: tr(ctx, "message.nothing") };
        let res;
        try {
          res = await ctx.host.plugins.requestInstall({ folder });
        } catch (err) {
          if (err && err.code === "conflict") {
            const reason = err.params && err.params.reason;
            if (reason === "cooldown") return { message: tr(ctx, "message.cooldown", { seconds: (err.params && err.params.seconds) || "" }) };
            return { message: tr(ctx, "message.pending") };
          }
          throw err;
        }
        switch (res.outcome) {
          case "installed":
            return { params: { pick: "" }, message: tr(ctx, "message.installed", { name: res.id || "", version: res.version || "" }) };
          case "declined":
            return { message: tr(ctx, "message.declined") };
          case "expired":
            return { message: tr(ctx, "message.expired") };
          default:
            return { message: res.reason ? tr(ctx, "message.failed", { reason: res.reason }) : tr(ctx, "message.failedNoReason") };
        }
      },
    });
  },
};
