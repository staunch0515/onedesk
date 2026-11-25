/** Test helper (not a plugin): mirrors the kernel's strict ViewNode validation. */
import type { ViewNode } from "../../src/workbench/protocol/generated";

const FIELD_KEYS = new Set(["name", "label", "kind", "bind", "param", "options", "presets", "fill", "language", "hint", "placeholder", "envValue", "envSource", "readOnly", "required", "maxLength", "kinds", "assist"]);
// D462: `assist` holds only these (FieldAssist in crates/protocol).
const ASSIST_KEYS = new Set(["off", "hint", "format"]);
const KINDS = new Set(["text", "longtext", "code", "number", "boolean", "date", "datetime", "enum", "secret", "time", "ref", "multi"]);
const NODE_KEYS: Record<string, string[]> = {
  form: ["type", "id", "layout", "label", "fields"],
  text: ["type", "id", "text", "mono", "language", "tone", "format", "lineTones", "appearance"],
  table: ["type", "id", "columns", "rows", "rowTargets", "rowKeys", "rowActions", "selectParam"],
  link: ["type", "id", "label", "target"],
  // D479
  conversation: ["type", "id", "turns", "input", "targetTab"],
};
const TURN_KEYS = new Set(["role", "text", "caption", "actions", "steps"]);
const INPUT_KEYS = new Set(["name", "send", "placeholder"]);

const isLabel = (l: unknown) =>
  typeof l === "string" || (typeof l === "object" && l !== null && Object.values(l).every((v) => typeof v === "string"));

/** Returns a list of problems; empty = valid. */
export function checkView(view: unknown): string[] {
  const errs: string[] = [];
  if (!Array.isArray(view)) return ["view is not an array"];
  for (const n of view as Record<string, unknown>[]) {
    const keys = NODE_KEYS[String(n.type)];
    if (!keys) {
      errs.push(`unknown node type ${String(n.type)}`);
      continue;
    }
    for (const k of Object.keys(n)) if (!keys.includes(k)) errs.push(`unknown node field ${k}`);
    if (typeof n.id !== "string") errs.push("node without id");
    if (n.type === "form") {
      if (n.layout !== "strip" && n.layout !== "stack") errs.push("bad layout");
      for (const f of (n.fields as Record<string, unknown>[]) ?? []) {
        for (const k of Object.keys(f)) if (!FIELD_KEYS.has(k)) errs.push(`unknown field key ${k}`);
        if (f.assist !== undefined) {
          if (typeof f.assist !== "object" || f.assist === null || Array.isArray(f.assist)) errs.push("assist must be an object");
          else for (const k of Object.keys(f.assist)) if (!ASSIST_KEYS.has(k)) errs.push(`unknown assist key ${k}`);
        }
        if (!KINDS.has(String(f.kind))) errs.push(`bad field kind ${String(f.kind)}`);
        if (typeof f.name !== "string" || !isLabel(f.label)) errs.push("field needs name and label");
      }
    }
    if (n.type === "conversation") {
      if (!Array.isArray(n.turns)) errs.push("conversation needs turns");
      for (const turn of (n.turns as Record<string, unknown>[]) ?? []) {
        for (const k of Object.keys(turn)) if (!TURN_KEYS.has(k)) errs.push(`unknown turn key ${k}`);
        if (turn.role !== "user" && turn.role !== "assistant") errs.push("bad turn role");
        if (typeof turn.text !== "string") errs.push("turn needs text");
        if (turn.actions !== undefined && (!Array.isArray(turn.actions) || turn.actions.length > 4)) errs.push("bad turn actions");
      }
      const input = n.input as Record<string, unknown> | undefined;
      if (input !== undefined) {
        for (const k of Object.keys(input)) if (!INPUT_KEYS.has(k)) errs.push(`unknown input key ${k}`);
        if (typeof input.name !== "string" || !input.name || String(input.name).startsWith("view.") || typeof input.send !== "string" || !input.send) errs.push("bad conversation input");
      }
    }
    if (n.type === "text" && typeof n.text !== "string") errs.push("text node needs a string");
    if (n.type === "text" && n.format !== undefined && !["plain", "markdown"].includes(String(n.format))) errs.push("bad format");
    if (n.type === "text" && n.tone !== undefined && !["default", "muted", "danger"].includes(String(n.tone))) errs.push("bad tone");
    if (n.type === "text" && n.appearance !== undefined && !["plain", "terminal"].includes(String(n.appearance))) errs.push("bad appearance");
    if (n.type === "text" && n.lineTones !== undefined && (!Array.isArray(n.lineTones) || n.lineTones.some((t) => t !== null && !["default", "muted", "success", "warning", "danger", "stderr"].includes(String(t))))) errs.push("bad lineTones");
  }
  return errs;
}

export function asViewNodes(view: unknown): ViewNode[] {
  const errs = checkView(view);
  if (errs.length) throw new Error(errs.join("; "));
  return view as ViewNode[];
}

/** A host error as the sandbox throws it: an Error with `code` and `params`. */
export function hostError(code: string, params: Record<string, string> = {}): Error {
  return Object.assign(new Error(code), { code, params });
}

/** Records what the plugin registers with `activate(host)`. */
export function registry(plugin: { activate(host: unknown): void }) {
  const pages: Record<string, any> = {};
  const trees: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const actions: Record<string, any> = {};
  const kinds: Record<string, any> = {};
  plugin.activate({
    kinds: { handle: (id: string, h: unknown) => (kinds[id] = h) },
    actions: { handle: (id: string, h: unknown) => (actions[id] = h) },
    pages: { handle: (id: string, h: unknown) => (pages[id] = h) },
    trees: { handle: (id: string, h: unknown) => (trees[id] = h) },
    commands: { handle: (id: string, h: unknown) => (commands[id] = h) },
  });
  return { pages, trees, commands, actions, kinds };
}

/** `ctx.t`: returns a localized Label like the kernel does. */
export const t = (key: string) => ({ "en-US": key, "zh-CN": `zh:${key}` });

/** Fails when `obj` has a key outside `allowed` (the kernel validates plugin returns with deny_unknown_fields). */
export function onlyKeys(obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `unexpected key ${k}`);
}

/** Mirrors `RenderOut` / `PluginCrumb` / `SaveOut` / tree page validation in crates/kernel. */
export const RENDER_KEYS = ["view", "values", "basis", "title", "icon", "breadcrumb", "readOnly"];
export const CRUMB_KEYS = ["label", "key"];
export const SAVE_KEYS = ["basis"];
export const TREE_PAGE_KEYS = ["nodes", "next"];
export const TREE_NODE_KEYS = ["key", "label", "icon", "expandable", "target", "badge", "menu", "draggable", "accepts"];

/** Mirrors the action result validation in crates/kernel (round 3): output is a RunOutput without `truncated`. */
export const ACTION_RESULT_KEYS = ["output", "summary", "data"]; // round 18 (D441): `data` goes to a caller of interfaces.call, a run ignores it
export const SUMMARY_KEYS = ["rows", "message"];
export const OUTPUT_KEYS: Record<string, string[]> = { table: ["type", "columns", "rows", "total", "file", "header", "appearance", "toneColumn", "lineColumn"], text: ["type", "text", "format", "file", "lineTones", "appearance"], link: ["type", "label", "target", "params"], none: ["type"] };
export const EVENT_RESULT_KEYS = ["changes", "params", "message"];

export function checkActionResult(res: Record<string, any>): string[] {
  const errs = onlyKeys(res, ACTION_RESULT_KEYS);
  const out = res.output ?? {};
  const keys = OUTPUT_KEYS[String(out.type)];
  if (!keys) return [...errs, `unknown output type ${String(out.type)}`];
  errs.push(...onlyKeys(out, keys));
  if (res.summary) errs.push(...onlyKeys(res.summary, SUMMARY_KEYS));
  if (out.type === "table") for (const c of out.columns ?? []) errs.push(...onlyKeys(c, ["key", "label", "numeric"]));
  return errs;
}
