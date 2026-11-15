import { textForm, baseName } from "./util.js";

// Calls ctx.host.<cap>.<op>(...args) and reports the result as a `copy` effect (test probe).
async function probe(ctx, context) {
  const a = (context && context.args) || {};
  const [cap, op] = String(a.method).split(".");
  try {
    const r = await ctx.host[cap][op](...(a.args || []));
    return [{ type: "copy", text: JSON.stringify({ ok: r === undefined ? null : r }) }];
  } catch (e) {
    return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {} }) }];
  }
}

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        return { view: [ textForm(ctx.t, "body.text"), { type: "form", id: "meta", layout: "strip",
          fields: [{ name: "name", label: "Name", kind: "text", bind: "name" }] } ] };
      },
    });
    host.pages.handle("file", {
      async render(ctx) {
        const path = ctx.node.key;
        const st = await ctx.host.files.stat(path);
        if (st.dir) {
          return { view: [{ type: "text", id: "dir", text: path }], title: baseName(path), icon: "folder", readOnly: true };
        }
        const { text, basis } = await ctx.host.files.readText(path);
        return { view: [textForm(ctx.t, "text")], values: { text }, basis, title: baseName(path), icon: "file-text",
                 breadcrumb: [{ label: baseName(path), key: path }] };
      },
      async save(ctx, changes, basis) {
        const r = await ctx.host.files.writeText(ctx.node.key, String(changes.text), { basis });
        return { basis: r.basis };
      },
    });
    host.trees.handle("disk", {
      async children(ctx, parentKey, offset) {
        if (!parentKey) {
          const roots = await ctx.host.files.roots();
          return { nodes: roots.map((r) => ({ key: r.path, label: r.name, icon: "folder", expandable: true })) };
        }
        const page = await ctx.host.files.list(parentKey, { offset, limit: 200 });
        const nodes = page.entries.filter((e) => !e.hidden).map((e) => ({
          key: e.path, label: e.name, icon: e.dir ? "folder" : "file-text", expandable: e.dir,
        }));
        return page.next == null ? { nodes } : { nodes, next: page.next };
      },
      async path(ctx, key) {
        const roots = await ctx.host.files.roots();
        const root = roots.map((r) => r.path).find((r) => key === r || key.startsWith(r + "/"));
        if (!root) return [key];
        const out = [root];
        let cur = root;
        for (const part of key.slice(root.length).split("/").filter(Boolean)) {
          cur = cur + "/" + part;
          out.push(cur);
        }
        return out;
      },
    });
    host.commands.handle("probe", probe);
  },
};
