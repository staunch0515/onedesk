// Files plugin: a provided tree of authorized folders and a text editor page.
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

const PAGE_SIZE = 200;

const LANGUAGES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", json: "json", md: "markdown", markdown: "markdown",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  css: "css", html: "html", htm: "html", xml: "xml", yaml: "yaml", yml: "yaml", toml: "toml",
  sql: "sql", sh: "shell", zsh: "shell", bash: "shell", rb: "ruby", swift: "swift", kt: "kotlin",
};

export function languageOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANGUAGES[name.slice(dot + 1).toLowerCase()];
}

export function baseName(path) {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1) || trimmed;
}

// Folders first, then by name (case-insensitive, then exact); hidden entries are dropped.
export function arrange(entries) {
  return entries
    .filter((e) => !e.hidden && !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      const la = a.name.toLowerCase();
      const lb = b.name.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

// The ancestors of `path` from its authorized root down, as absolute paths.
export function chain(path, roots) {
  const root = roots
    .map((r) => r.path)
    .filter((p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const out = [root];
  const rest = path.slice(root.length).split("/").filter(Boolean);
  let cur = root.endsWith("/") ? root.slice(0, -1) : root;
  for (const part of rest) {
    cur = `${cur}/${part}`;
    out.push(cur);
  }
  return out;
}


/* ---------------------------------------------------------------- round 17: paths, scope, operations */
// Host interface (docs/handoff/round17-protocol.md §3.1): files.mkdir, copy/move(from, to, { conflict }) with conflict
// fail | overwrite | skip | keepBoth, trash, remove, open, reveal, find, addRoot/replaceRoot/removeRoot.
// Everything below checks the scope itself first, so a path outside the authorized folders never reaches the host.

const DISK_FILE = "disk-file";
const DISK_FOLDER = "disk-folder";
const CONFLICTS = ["ask", "overwrite", "skip", "keepBoth"];
const MAX_VISIT = 20000;
const MAX_RESULTS = 500;
const MAX_DEPTH = 12;
const MAX_UPSERT = 5000;

export function tr2(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

function fail(ctx, key, vars) {
  return new Error(tr2(ctx, key, vars));
}

// Collapses "." and ".." and repeated slashes; null for a relative path or one that climbs above "/".
export function normalize(path) {
  const p = String(path || "");
  if (!p.startsWith("/") || p.includes("\0")) return null;
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function dirName(path) {
  const n = normalize(path) || path;
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

export function joinPath(dir, name) {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

export function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

// A name for one new item: no separators, not "." or "..", at most 255 UTF-8 bytes (approximated by characters).
export function validName(name) {
  const n = String(name || "");
  return n.trim() !== "" && n === n.trim() && !n.includes("/") && !n.includes("\0") && n !== "." && n !== ".." && n.length <= 255;
}

// The authorized root that holds `path` (after normalizing), or null. Never matches by prefix alone: "/a/docs2" is not in "/a/docs".
export function rootOf(path, roots) {
  const n = normalize(path);
  if (n === null) return null;
  const hit = roots
    .map((r) => normalize(r.path) || r.path)
    .filter((r) => n === r || n.startsWith(r === "/" ? "/" : `${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  return hit === undefined ? null : hit;
}

async function exists(ctx, path) {
  try {
    await ctx.host.files.stat(path);
    return true;
  } catch (err) {
    if (err && err.code === "notFound") return false;
    throw err;
  }
}

// The path an action works on: a tree node, a disk-file resource, or an explicit input.
export function targetOf(ctx, input) {
  const i = input || {};
  const key = (ctx.node && ctx.node.key) || (typeof i.path === "string" && i.path) || (ctx.resource && ctx.resource.body && ctx.resource.body.path) || "";
  return String(key);
}

async function scoped(ctx, path) {
  const roots = await ctx.host.files.roots();
  const n = normalize(path);
  if (n === null || rootOf(n, roots) === null) throw fail(ctx, "error.outside");
  return { path: n, roots };
}

function param(ctx, name) {
  const v = ctx.params && ctx.params[name];
  return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
}

function conflictMode(ctx) {
  const c = param(ctx, "conflict");
  return CONFLICTS.includes(c) ? c : "ask";
}

// The folder a "new item" or "search" action works in: the node itself when it is a folder, else its parent.
async function folderOf(ctx, path) {
  const info = await ctx.host.files.stat(path);
  return info && info.dir ? path : dirName(path);
}

function done(ctx, key, vars) {
  const text = tr2(ctx, key, vars);
  return { output: { type: "text", text }, summary: { message: text } };
}

// Copy or move `from` into `destDir` as `name`. `mode` is what to do when the name is taken: overwrite, skip,
// keepBoth (the host names the new one "name 2.ext"); "ask" stops with a question (the shell's dialog asks it
// when it is the command that runs, see `conflictAsk`).
export async function transfer(ctx, op, from, destDir, name, mode) {
  const to = joinPath(destDir, name);
  if (to === from) throw fail(ctx, "error.sameFile");
  if (to.startsWith(`${from}/`)) throw fail(ctx, "error.intoItself");
  const conflict = CONFLICTS.includes(mode) && mode !== "ask" ? mode : "fail";
  try {
    const r = await ctx.host.files[op](from, to, { conflict });
    return { skipped: r && r.skipped === true, path: (r && r.path) || to };
  } catch (err) {
    throw explain(ctx, err, name);
  }
}

// Host error codes (round 17) to the user's words; other errors pass through.
export function explain(ctx, err, name) {
  const code = err && err.code;
  const reason = err && err.params && err.params.reason;
  if (code === "conflict") return Object.assign(fail(ctx, "conflict.exists", { name: name || "" }), { isConflict: true, conflictName: name || "" });
  if (code === "invalid" && reason === "intoItself") return fail(ctx, "error.intoItself");
  if (code === "invalid" && reason === "isRoot") return fail(ctx, "error.isRoot");
  if (code === "invalid" && reason === "trashUnavailable") return fail(ctx, "error.trashUnavailable");
  if (code === "notFound" && reason === "grant") return fail(ctx, "error.notGranted");
  return err;
}

async function walk(ctx, start, visit, { recursive = true } = {}) {
  let seen = 0;
  let truncated = false;
  const stack = [[start, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    let offset = 0;
    for (;;) {
      const page = await ctx.host.files.list(dir, { offset, limit: PAGE_SIZE });
      for (const e of arrange(page.entries)) {
        if (++seen > MAX_VISIT) return { truncated: true };
        const stop = await visit(e, dir);
        if (stop === "stop") return { truncated: true };
        if (e.dir && recursive && depth < MAX_DEPTH) stack.push([e.path, depth + 1]);
        else if (e.dir && recursive) truncated = true;
      }
      if (page.next === undefined || page.next === null) break;
      offset = page.next;
    }
  }
  return { truncated };
}

export function isoOf(ms) {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : "";
}

export function diskFileItem(e, parent) {
  const item = { key: e.path, name: e.name, body: { path: e.path, size: String(e.size ?? 0), modifiedAt: isoOf(e.modifiedAt), ext: extOf(e.name), folder: dirName(e.path) } };
  if (parent) item.parent = parent;
  return item;
}

// Registers a folder as disk-file resources: groups named after their folders, files under them. Existing files are
// updated, files that are gone from the scanned scope become "missing" (the host does that for what is left out of
// the batch); files of other folders, and deeper ones when `recursive` is off, are passed as key-only items so that
// they stay as they are.
export async function importFolder(ctx, root, recursive) {
  const files = [];
  const dirs = [[root, 0]];
  const scanned = await walk(
    ctx,
    root,
    (e) => {
      if (e.dir) dirs.push([e.path, 0]);
      else files.push(e);
    },
    { recursive },
  );
  // folder groups, parents before children
  const ids = {};
  const levels = [];
  for (const [p] of dirs) levels.push([p, p === root ? 0 : p.slice(root.length).split("/").length - 1]);
  levels.sort((a, b) => a[1] - b[1]);
  for (let depth = 0; depth <= MAX_DEPTH + 1; depth++) {
    const at = levels.filter((l) => l[1] === depth).map((l) => l[0]);
    if (at.length === 0) continue;
    const items = at.map((p) => {
      const item = { key: p, name: baseName(p), body: { path: p } };
      if (depth > 0 && ids[dirName(p)]) item.parent = ids[dirName(p)];
      return item;
    });
    const r = await ctx.host.resources.upsertByKey(DISK_FOLDER, items);
    Object.assign(ids, r.ids || {});
  }

  const batch = files.map((e) => diskFileItem(e, ids[dirName(e.path)]));
  const inBatch = new Set(batch.map((b) => b.key));
  const prefix = root === "/" ? "/" : `${root}/`;
  const known = (await ctx.host.resources.list({ kind: DISK_FILE })) || [];
  const list = Array.isArray(known) ? known : known.items || [];
  for (const r of list) {
    const key = r.externalKey;
    if (!key || inBatch.has(key) || r.missing) continue;
    const inScope = key.startsWith(prefix) && (recursive || !key.slice(prefix.length).includes("/"));
    if (inScope && !scanned.truncated) continue; // gone from the folder: left out, so it becomes "missing"
    batch.push({ key });
  }
  if (batch.length > MAX_UPSERT) throw fail(ctx, "error.tooMany", { max: MAX_UPSERT });
  const r = await ctx.host.resources.upsertByKey(DISK_FILE, batch, { othersMissing: true });
  return { ...r, files: files.length, truncated: scanned.truncated };
}

function reasonOf(err) {
  const code = err && err.code;
  if (code === "invalid") {
    const r = err.params && err.params.reason;
    if (r === "tooLarge") return "reason.tooLarge";
    if (r === "notText") return "reason.notText";
  }
  if (code === "denied") return "reason.denied";
  if (code === "notFound") return "reason.notFound";
  return "reason.failed";
}

const PLUGIN = "org.onedesk.files";
const nodeTarget = (tree, key) => `node:${PLUGIN}:${tree}/${encodeURIComponent(key)}`;
const ADD_KEY = "~add";

// The effect that makes the shell ask "overwrite, skip or keep both" and run `command` again with the answer.
export function conflictAsk(ctx, command, name) {
  return {
    type: "confirm",
    message: tr2(ctx, "conflict.exists", { name }),
    command,
    choices: [{ id: "overwrite", danger: true }, { id: "skip" }, { id: "keepBoth" }],
    choiceArg: "conflict",
  };
}

function opsForm(ctx, { withConflict }) {
  const f = (name, kind, extra) => ({ name, label: ctx.t(`field.${name}`), kind, param: true, ...(extra || {}) });
  const fields = [f("newName", "text", { placeholder: ctx.t("field.newName.placeholder") }), f("destination", "text", { placeholder: ctx.t("field.destination.placeholder") })];
  if (withConflict) fields.push(f("conflict", "enum", { options: CONFLICTS.map((c) => ({ value: c, label: ctx.t(`conflict.${c}`) })) }));
  fields.push(f("query", "text", { placeholder: ctx.t("field.query.placeholder") }), f("recursive", "boolean"));
  return { type: "form", id: "ops", layout: "strip", fields };
}

export default {
  activate(host) {
    host.trees.handle("files", {
      async children(ctx, parentKey, offset) {
        if (!parentKey) {
          const roots = await ctx.host.files.roots();
          return {
            nodes: roots.map((r) => ({
              key: r.path,
              label: r.name,
              icon: "folder",
              expandable: true,
              target: nodeTarget("files", r.path),
            })),
          };
        }
        const start = offset || 0;
        const page = await ctx.host.files.list(parentKey, { offset: start, limit: PAGE_SIZE });
        const nodes = arrange(page.entries).map((e) =>
          e.dir
            ? { key: e.path, label: e.name, icon: "folder", expandable: true, target: nodeTarget("files", e.path) }
            : { key: e.path, label: e.name, icon: "file-text", expandable: false, target: nodeTarget("files", e.path) },
        );
        return page.next === undefined || page.next === null ? { nodes } : { nodes, next: page.next };
      },

      async path(ctx, key) {
        const roots = await ctx.host.files.roots();
        return chain(key, roots) || [key];
      },
    });

    // The authorized folders as a list: add (a node), look at, rename, remove, import.
    host.trees.handle("folders", {
      async children(ctx, parentKey) {
        if (parentKey) return { nodes: [] };
        const roots = await ctx.host.files.roots();
        return {
          nodes: [
            { key: ADD_KEY, label: ctx.t("folders.add"), icon: "folder-plus", expandable: false, target: nodeTarget("folders", ADD_KEY) },
            ...roots.map((r) => ({ key: r.path, label: r.name, icon: "folder", expandable: false, target: nodeTarget("folders", r.path) })),
          ],
        };
      },
      async path(ctx, key) {
        return [key];
      },
    });

    host.pages.handle("folders", {
      async render(ctx) {
        const key = ctx.node.key;
        if (key === ADD_KEY) {
          return {
            title: tr2(ctx, "folders.add"),
            icon: "folder-plus",
            readOnly: true,
            view: [{ type: "text", id: "note", text: tr2(ctx, "folders.addNote"), tone: "muted" }],
            values: {},
          };
        }
        const roots = await ctx.host.files.roots();
        const root = roots.find((r) => r.path === key);
        if (!root) return { title: baseName(key), icon: "folder", readOnly: true, view: [{ type: "text", id: "gone", text: tr2(ctx, "reason.notFound"), tone: "muted" }], values: {} };
        const f = (name, kind, extra) => ({ name, label: ctx.t(`field.${name}`), kind, param: true, ...(extra || {}) });
        return {
          title: root.name,
          icon: "folder",
          readOnly: true,
          view: [
            { type: "text", id: "path", text: key, mono: true },
            { type: "form", id: "ops", layout: "strip", fields: [f("recursive", "boolean")] },
            { type: "text", id: "note", text: tr2(ctx, "folders.note"), tone: "muted" },
          ],
          values: {},
        };
      },
    });

    host.pages.handle("text", {
      async render(ctx) {
        const path = ctx.node.key;
        const name = baseName(path);
        const roots = await ctx.host.files.roots();
        const crumbs = (chain(path, roots) || [path]).map((p) => ({
          label: baseName(p),
          key: p,
        }));
        const head = { title: name, icon: "file-text", breadcrumb: crumbs };
        let info = null;
        try {
          info = await ctx.host.files.stat(path);
        } catch (err) {
          info = null;
        }
        if (info && info.dir) {
          return {
            ...head,
            icon: "folder",
            readOnly: true,
            view: [opsForm(ctx, { withConflict: true }), { type: "text", id: "dir", text: tr2(ctx, "folder.note"), tone: "muted" }],
            values: {},
          };
        }
        try {
          const file = await ctx.host.files.readText(path);
          const text = ctx.draft && typeof ctx.draft.content === "string" ? ctx.draft.content : file.text;
          const field = {
            name: "content",
            label: ctx.t("field.content"),
            kind: "code",
            bind: "content",
            fill: true,
          };
          const language = languageOf(name);
          if (language) field.language = language;
          return {
            ...head,
            view: [opsForm(ctx, { withConflict: true }), { type: "form", id: "content", layout: "stack", fields: [field] }],
            values: { content: file.text },
            basis: file.basis,
          };
        } catch (err) {
          return {
            ...head,
            readOnly: true,
            view: [opsForm(ctx, { withConflict: true }), { type: "text", id: "reason", text: tr(ctx, reasonOf(err)), tone: "muted" }],
            values: {},
          };
        }
      },

      async save(ctx, changes, basis) {
        const path = ctx.node.key;
        const res = await ctx.host.files.writeText(path, String(changes.content ?? ""), basis ? { basis } : undefined);
        return { basis: res.basis };
      },
    });

    // The page of a disk-file resource: what was recorded, read only; the actions work on its path.
    host.pages.handle("disk-file", {
      async render(ctx) {
        const b = (ctx.resource && ctx.resource.body) || {};
        const row = (label, value) => [ctx.t(label), String(value ?? "")];
        return {
          readOnly: true,
          view: [
            {
              type: "table",
              id: "info",
              columns: [
                { key: "k", label: ctx.t("info.name") },
                { key: "v", label: ctx.t("info.value") },
              ],
              rows: [row("info.path", b.path), row("info.size", b.size), row("info.modified", b.modifiedAt), row("info.ext", b.ext), row("info.folder", b.folder)],
            },
          ],
          values: {},
        };
      },
    });

    /* ------------------------------------------------------------ actions */

    host.actions.handle("grantAdd", async (ctx) => {
      // The shell opens its folder chooser; what the user picks becomes a grant.
      await ctx.host.files.addRoot();
      return done(ctx, "grant.choose");
    });

    // "Change": the chosen folder takes the place of this one in the list.
    host.actions.handle("grantReplace", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      try {
        await ctx.host.files.replaceRoot(path);
      } catch (err) {
        throw explain(ctx, err, "");
      }
      return done(ctx, "grant.choose");
    });

    // Removing the authorization changes nothing else: no resource and no file is touched.
    host.actions.handle("grantRemove", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      try {
        await ctx.host.files.removeRoot(path);
      } catch (err) {
        throw explain(ctx, err, "");
      }
      return done(ctx, "grant.removed", { path });
    });

    host.actions.handle("import", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      const dir = await folderOf(ctx, path);
      ctx.progress(undefined, tr2(ctx, "step.importing"));
      const r = await importFolder(ctx, dir, param(ctx, "recursive") === "true");
      return done(ctx, "import.done", { created: r.created, updated: r.updated, restored: r.restored, missing: r.missing, files: r.files });
    });

    host.actions.handle("mkdir", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      const name = param(ctx, "newName");
      if (!validName(name)) throw fail(ctx, "error.badName");
      const target = joinPath(await folderOf(ctx, path), name);
      await scoped(ctx, target);
      if (await exists(ctx, target)) throw fail(ctx, "error.exists", { name });
      try {
        await ctx.host.files.mkdir(target);
      } catch (err) {
        throw explain(ctx, err, name);
      }
      return done(ctx, "done.mkdir", { path: target });
    });

    host.actions.handle("touch", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      const name = param(ctx, "newName");
      if (!validName(name)) throw fail(ctx, "error.badName");
      const target = joinPath(await folderOf(ctx, path), name);
      await scoped(ctx, target);
      if (await exists(ctx, target)) throw fail(ctx, "error.exists", { name });
      await ctx.host.files.writeText(target, "");
      return done(ctx, "done.touch", { path: target });
    });

    host.actions.handle("rename", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      const name = param(ctx, "newName");
      if (!validName(name)) throw fail(ctx, "error.badName");
      const r = await transfer(ctx, "move", path, dirName(path), name, conflictMode(ctx));
      return r.skipped ? done(ctx, "done.skipped", { path: r.path }) : done(ctx, "done.renamed", { path: r.path });
    });

    for (const op of ["move", "copy"]) {
      host.actions.handle(op, async (ctx) => {
        const { path } = await scoped(ctx, targetOf(ctx));
        const dest = normalize(param(ctx, "destination"));
        if (dest === null) throw fail(ctx, "error.noDestination");
        await scoped(ctx, dest);
        const info = await ctx.host.files.stat(dest);
        if (!info || !info.dir) throw fail(ctx, "error.destNotFolder");
        const r = await transfer(ctx, op, path, dest, baseName(path), conflictMode(ctx));
        if (r.skipped) return done(ctx, "done.skipped", { path: r.path });
        return done(ctx, op === "move" ? "done.moved" : "done.copied", { path: r.path });
      });
    }

    // The default delete: to the Trash, recoverable.
    host.actions.handle("trash", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      try {
        await ctx.host.files.trash(path);
      } catch (err) {
        throw explain(ctx, err, "");
      }
      return done(ctx, "done.trashed", { path });
    });

    // Permanent: the manifest asks the user to confirm before this runs.
    host.actions.handle("delete", async (ctx) => {
      const { path, roots } = await scoped(ctx, targetOf(ctx));
      if (roots.some((r) => normalize(r.path) === path)) throw fail(ctx, "error.isRoot");
      try {
        await ctx.host.files.remove(path);
      } catch (err) {
        throw explain(ctx, err, "");
      }
      return done(ctx, "done.deleted", { path });
    });

    host.actions.handle("open", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      await ctx.host.files.open(path);
      return done(ctx, "done.opened", { path });
    });

    host.actions.handle("reveal", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      await ctx.host.files.reveal(path);
      return done(ctx, "done.revealed", { path });
    });

    // By file name: every word must be part of it (case does not matter); under the folder the page shows.
    host.actions.handle("search", async (ctx) => {
      const { path } = await scoped(ctx, targetOf(ctx));
      const words = param(ctx, "query").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) throw fail(ctx, "error.noQuery");
      const dir = await folderOf(ctx, path);
      const found = await ctx.host.files.find(dir, words.join(" "), { limit: MAX_RESULTS });
      const rows = (found.entries || []).map((e) => [e.name, e.path, e.dir ? "" : String(e.size ?? 0), isoOf(e.modifiedAt)]);
      const res = { truncated: found.capped === true || (found.next !== undefined && found.next !== null) };
      const message = tr2(ctx, res.truncated ? "search.partial" : "search.found", { count: rows.length });
      return {
        output: {
          type: "table",
          columns: [
            { key: "name", label: tr2(ctx, "col.name") },
            { key: "path", label: tr2(ctx, "col.path") },
            { key: "size", label: tr2(ctx, "col.size"), numeric: true },
            { key: "modified", label: tr2(ctx, "col.modified") },
          ],
          rows,
          total: rows.length,
        },
        summary: { rows: rows.length, message },
      };
    });

    // Commands (the shell's conflict dialog reruns a command with the chosen `args.conflict`): the same operations
    // on the node, with `args.destination` / `args.newName`. A taken name asks "overwrite, skip or keep both".
    for (const op of ["move", "copy", "rename"]) {
      host.commands.handle(op, async (ctx, context) => {
        const args = (context && context.args) || {};
        const path = String((context && context.nodeKey) || "");
        const cctx = { ...ctx, node: { key: path }, params: { conflict: args.conflict, newName: args.newName, destination: args.destination } };
        try {
          const { path: from } = await scoped(cctx, path);
          let destDir;
          let name;
          if (op === "rename") {
            name = String(args.newName || "");
            if (!validName(name)) throw fail(ctx, "error.badName");
            destDir = dirName(from);
          } else {
            destDir = normalize(String(args.destination || ""));
            if (destDir === null) throw fail(ctx, "error.noDestination");
            await scoped(cctx, destDir);
            name = baseName(from);
          }
          const r = await transfer(ctx, op === "copy" ? "copy" : "move", from, destDir, name, args.conflict || "ask");
          return [{ type: "toast", message: tr2(ctx, r.skipped ? "done.skipped" : op === "copy" ? "done.copied" : op === "move" ? "done.moved" : "done.renamed", { path: r.path }), tone: "success" }];
        } catch (err) {
          if (err && err.isConflict) return [conflictAsk(ctx, `${PLUGIN}:${op}`, err.conflictName)];
          return [{ type: "toast", message: String((err && err.message) || err), tone: "danger" }];
        }
      });
    }
  },
};

// `text` nodes carry a plain string, so take the label's current-locale form.
function tr(ctx, key) {
  const label = ctx.t(key);
  if (typeof label === "string") return label;
  return label[ctx.locale] || label["en-US"] || key;
}
