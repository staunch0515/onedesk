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
            })),
          };
        }
        const start = offset || 0;
        const page = await ctx.host.files.list(parentKey, { offset: start, limit: PAGE_SIZE });
        const nodes = arrange(page.entries).map((e) =>
          e.dir
            ? { key: e.path, label: e.name, icon: "folder", expandable: true }
            : { key: e.path, label: e.name, icon: "file-text", expandable: false, target: `node:org.onedesk.files:files/${encodeURIComponent(e.path)}` },
        );
        return page.next === undefined || page.next === null ? { nodes } : { nodes, next: page.next };
      },

      async path(ctx, key) {
        const roots = await ctx.host.files.roots();
        return chain(key, roots) || [key];
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
            view: [{ type: "form", id: "content", layout: "stack", fields: [field] }],
            values: { content: file.text },
            basis: file.basis,
          };
        } catch (err) {
          return {
            ...head,
            readOnly: true,
            view: [{ type: "text", id: "reason", text: tr(ctx, reasonOf(err)), tone: "muted" }],
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
  },
};

// `text` nodes carry a plain string, so take the label's current-locale form.
function tr(ctx, key) {
  const label = ctx.t(key);
  if (typeof label === "string") return label;
  return label[ctx.locale] || label["en-US"] || key;
}
