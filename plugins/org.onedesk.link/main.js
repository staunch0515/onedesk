// Link plugin: one kind ("link"), one page ("editor"), one action ("open", the default).
// The action hands the address to the host, which opens it in the system browser. Sandbox rules: everything goes through ctx.host.
// A link is a template (D466): `{{name}}` in the address is filled from the tab's environment, so one link opens
// the staging or the production site depending on the environment chosen.

import { filled, holeNames, holeStrip } from "./template.js";

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

const ALLOWED = /^(https?:\/\/[^\s/?#]+|mailto:\S+)/i;
const MAX_URL = 2048;

// The address with surrounding blanks removed, or null when it may not be opened.
export function cleanUrl(raw) {
  const url = String(raw || "").trim();
  if (!url || url.length > MAX_URL || /\s/.test(url)) return null;
  return ALLOWED.test(url) ? url : null;
}

// What to show after "opened": the host of a web address, the address part of a mail address.
export function hostOf(url) {
  const m = /^(?:https?:\/\/)([^/?#]+)/i.exec(url);
  if (m) return m[1].replace(/^[^@]*@/, "");
  return url.replace(/^mailto:/i, "").split("?")[0];
}

function pick(ctx, key) {
  if (ctx.run && ctx.run.input && typeof ctx.run.input[`body.${key}`] === "string") return ctx.run.input[`body.${key}`];
  if (ctx.draft && typeof ctx.draft[`body.${key}`] === "string") return ctx.draft[`body.${key}`];
  const b = ctx.resource && ctx.resource.body;
  return b && typeof b[key] === "string" ? b[key] : "";
}

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const ro = ctx.run ? { readOnly: true } : {};
        const url = pick(ctx, "url");
        const view = [];
        const names = holeNames(url);
        const strip = await holeStrip(ctx, names);
        if (strip) view.push(strip);
        view.push({
          type: "form",
          id: "main",
          layout: "stack",
          fields: [
            { name: "url", label: ctx.t("field.url"), kind: "text", bind: "body.url", placeholder: ctx.t("field.url.placeholder"), ...ro },
          ],
        });
        // With placeholders: the address that "Open" would open with the current environment.
        if (names.length > 0) view.push({ type: "text", id: "resolved", text: tr(ctx, "field.resolved", { url: await filled(ctx, url) }) });
        return { view };
      },
    });

    host.actions.handle("open", async (ctx, input) => {
      const raw = input && typeof input["body.url"] === "string" ? input["body.url"] : pick(ctx, "url");
      if (!String(raw || "").trim()) throw new Error(tr(ctx, "error.noUrl"));
      const resolved = await filled(ctx, raw);
      // A placeholder the environment does not fill would be opened as written: say which one instead.
      const missing = holeNames(resolved);
      if (missing.length > 0) throw new Error(tr(ctx, "error.unfilled", { names: missing.join(", ") }));
      const url = cleanUrl(resolved);
      if (!url) throw new Error(tr(ctx, "error.badUrl"));
      await ctx.host.ui.openExternal(url);
      const host_ = hostOf(url);
      const id = ctx.resource && ctx.resource.id;
      return {
        output: id ? { type: "link", label: tr(ctx, "output.label", { host: host_ }), target: `resource:${id}` } : { type: "none" },
        summary: { message: tr(ctx, "summary.opened", { host: host_ }) },
      };
    });
  },
};
