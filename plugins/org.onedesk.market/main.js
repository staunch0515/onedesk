// Plugin market (local): scans plugin packages in authorized folders, lists their state and asks the
// framework to install one with host.plugins.requestInstall. It only reads display fields of manifests;
// permissions are listed by the framework's own confirmation dialog.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export const MAX_PACKAGES = 200;
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
  let file;
  try {
    file = await ctx.host.files.readText(`${dir.path}/manifest.json`);
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    return { found: true, pkg: { folder: dir.path, label: dir.name, unavailable: "reason.unreadable" } };
  }
  let m;
  try {
    m = JSON.parse(file.text);
  } catch (e) {
    return { found: true, pkg: { folder: dir.path, label: dir.name, unavailable: "reason.invalidJson" } };
  }
  if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.version !== "string" || !m.id || !m.version) {
    return { found: true, pkg: { folder: dir.path, label: dir.name, unavailable: "reason.missingFields" } };
  }
  return { found: true, pkg: { folder: dir.path, id: m.id, version: m.version, manifest: m } };
}

// Scans `<root>/*/manifest.json` and `<root>/*/*/manifest.json`; stops at MAX_PACKAGES.
export async function scan(ctx, roots) {
  const packages = [];
  let capped = false;
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
        const res = await readPackage(ctx, v);
        if (res.found && !add({ ...res.pkg, label: `${d.name}/${v.name}` })) break outer;
      }
    }
  }
  return { packages, capped };
}

// Display strings of a manifest: `name` / `description` are locale keys; the package's own locale files give the text.
async function describe(ctx, pkg) {
  const m = pkg.manifest;
  const out = { name: String(m.name || pkg.id), description: String(m.description || ""), icon: m.icon };
  const locales = (m.contributes && m.contributes.locales) || {};
  const rel = locales[ctx.locale] || locales["en-US"];
  if (typeof rel !== "string" || rel.startsWith("/") || rel.split("/").includes("..")) return out;
  try {
    const file = await ctx.host.files.readText(`${pkg.folder}/${rel}`);
    const table = JSON.parse(file.text);
    if (typeof table[m.name] === "string") out.name = table[m.name];
    if (typeof table[m.description] === "string") out.description = table[m.description];
  } catch (e) {
    // keep the raw strings
  }
  return out;
}

function statusText(ctx, st) {
  if (st.kind === "installed") return tr(ctx, "status.installed", { version: st.version });
  if (st.kind === "update") return tr(ctx, "status.update", { version: st.version });
  return tr(ctx, "status.notInstalled");
}

async function load(ctx) {
  const roots = await ctx.host.files.roots();
  if (roots.length === 0) return { roots, packages: [], capped: false, rows: [] };
  const installed = await ctx.host.plugins.list();
  const { packages, capped } = await scan(ctx, roots);
  const rows = [];
  for (const pkg of packages) {
    if (pkg.unavailable) {
      rows.push({ pkg, name: pkg.label, description: tr(ctx, pkg.unavailable), version: "", status: tr(ctx, "status.unavailable"), installable: false });
      continue;
    }
    const info = await describe(ctx, pkg);
    const st = statusOf(pkg, installed);
    rows.push({ pkg, name: info.name, description: info.description, version: pkg.version, status: statusText(ctx, st), installable: st.kind !== "installed" });
  }
  return { roots, packages, capped, rows };
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
            values: { pick: "" },
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
        if (state.capped) view.push({ type: "text", id: "capped", text: tr(ctx, "capped", { max: MAX_PACKAGES }), tone: "muted" });
        const options = state.rows.filter((r) => r.installable).map((r) => ({ value: r.pkg.folder, label: `${r.name} ${r.version}` }));
        view.push({
          type: "form",
          id: "pick",
          layout: "strip",
          fields: [{ name: "pick", label: ctx.t("field.pick"), kind: "enum", bind: "pick", options, placeholder: ctx.t("field.pick.placeholder") }],
        });
        const draft = ctx.draft && typeof ctx.draft.pick === "string" ? ctx.draft.pick : "";
        return { ...head, view, values: { pick: options.some((o) => o.value === draft) ? draft : "" } };
      },

      async onEvent(ctx, event) {
        if (event === "refresh") return { message: tr(ctx, "message.refreshed") };
        if (event !== "install") throw new Error(`unknown event ${event}`);
        const folder = ctx.draft && typeof ctx.draft.pick === "string" ? ctx.draft.pick : "";
        if (!folder) return { message: tr(ctx, "message.nothing") };
        let res;
        try {
          res = await ctx.host.plugins.requestInstall({ folder });
        } catch (err) {
          if (err && err.code === "conflict") return { message: tr(ctx, "message.pending") };
          throw err;
        }
        switch (res.outcome) {
          case "installed":
            return { changes: { pick: "" }, message: tr(ctx, "message.installed", { name: res.id || "", version: res.version || "" }) };
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
