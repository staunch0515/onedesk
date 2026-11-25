// The roles a page plays in a book (docs/redesign/book.md §3, §5, §13.1). The book knows a page only by its role: its
// own kinds from this table, other plugins' kinds from what they say through the interface `onedesk.book/1` (`roles`),
// anything else is body text. Nothing here decides how a role behaves: that is in the role's own file.

export const PLUGIN = "org.onedesk.book";
export const IFACE = "onedesk.book/1";
export const GROUP = "core:group";

/** `<plugin>:<kind>` of one of this plugin's kinds. */
export const full = (kind) => `${PLUGIN}:${kind}`;

/** [plugin, short kind] of a full kind name. */
export function split(kind) {
  const s = String(kind || "");
  const i = s.lastIndexOf(":");
  return i < 0 ? ["", s] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * This plugin's kinds: what role each plays, in which part of the book (`none`: not read — the cover is what the book
 * shows, the contents is the reading itself), at most one in a book, whether what is below it is read too, and how it
 * is numbered (`level`: by depth; `letter`: A, B, C; `none`).
 */
export const OWN_ROLES = {
  book: { role: "book", part: "body", single: false, container: true, numbering: "level" },
  cover: { role: "cover", part: "none", single: true, container: false, numbering: "none" },
  toc: { role: "toc", part: "none", single: true, container: false, numbering: "none" },
  preface: { role: "preface", part: "front", single: false, container: false, numbering: "none" },
  afterword: { role: "afterword", part: "back", single: false, container: false, numbering: "none" },
  page: { role: "body", part: "body", single: false, container: false, numbering: "level" },
  appendix: { role: "appendix", part: "back", single: false, container: true, numbering: "letter" },
  // D487 §15
  references: { role: "references", part: "back", single: true, container: false, numbering: "none" },
  reference: { role: "reference", part: "none", single: false, container: false, numbering: "none" },
  index: { role: "index", part: "back", single: true, container: false, numbering: "none" },
  figures: { role: "figures", part: "front", single: true, container: false, numbering: "none" },
};

/** A group (篇, 章) and any resource that says nothing: body, numbered by depth, what is below it read too. */
export const GROUP_ROLE = { role: "group", part: "body", single: false, container: true, numbering: "level" };
export const BODY_ROLE = { role: "body", part: "body", single: false, container: true, numbering: "level" };

/** The order of the parts: not read, front, body, back. */
export const PART_RANK = { none: 0, front: 1, body: 2, back: 3 };

const PARTS = new Set(Object.keys(PART_RANK));
const NUMBERINGS = new Set(["level", "letter", "none"]);

/** The interface's `roles` answer for this plugin. */
export function rolesData() {
  return { kinds: Object.entries(OWN_ROLES).map(([kind, r]) => ({ kind, ...r })) };
}

/** A role another plugin declared, with anything unknown made safe (an unknown part is body; one role is body text). */
export function normalize(r) {
  return {
    role: typeof r.role === "string" && r.role ? r.role : "body",
    part: PARTS.has(r.part) ? r.part : "body",
    single: r.single === true,
    container: r.container !== false,
    numbering: NUMBERINGS.has(r.numbering) ? r.numbering : "level",
    // It said so itself: it can be asked what a page holds (`outline`).
    declared: true,
  };
}

/**
 * A role lookup for one piece of work (one page drawn, one placement): other plugins are asked once each, and only
 * those that implement the interface.
 */
export function roleFinder(ctx) {
  const tables = new Map();
  let implementers = null;
  return async (kind) => {
    const [plugin, short] = split(kind);
    if (plugin === PLUGIN) return OWN_ROLES[short] || BODY_ROLE;
    if (kind === GROUP) return GROUP_ROLE;
    if (!tables.has(plugin)) {
      if (implementers === null) {
        try {
          implementers = (await ctx.host.interfaces.list(IFACE)).map((i) => i.plugin);
        } catch {
          implementers = [];
        }
      }
      let table = [];
      if (implementers.includes(plugin)) {
        try {
          const r = await ctx.host.interfaces.call(IFACE, "roles", {}, { plugin });
          if (r && r.data && Array.isArray(r.data.kinds)) table = r.data.kinds;
        } catch {
          table = [];
        }
      }
      tables.set(plugin, table);
    }
    const row = tables.get(plugin).find((x) => x && (x.kind === short || x.kind === kind));
    return row ? normalize(row) : BODY_ROLE;
  };
}

/** Every node below `id`, in tree order (the kernel's subtree, page after page; at most 20 000). */
export async function allNodes(ctx, id) {
  const out = [];
  let offset = 0;
  for (;;) {
    const r = await ctx.host.resources.tree(id, { offset, limit: 2000 });
    out.push(...r.nodes);
    if (r.next === null || r.next === undefined || out.length >= 20000) break;
    offset = r.next;
  }
  return out;
}

/** The children of each node, in tree order. */
export function childrenMap(nodes) {
  const map = new Map();
  for (const n of nodes) {
    if (!map.has(n.parent)) map.set(n.parent, []);
    map.get(n.parent).push(n);
  }
  return map;
}
