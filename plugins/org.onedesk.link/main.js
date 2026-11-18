// Link plugin: one kind ("link"), one page ("editor"), one action ("open", the default).
// The action hands the address to the host, which opens it in the system browser. Sandbox rules: everything goes through ctx.host.

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

// A first-version body field as text: strings as they are, numbers and booleans as written, anything else empty.
function legacyText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function legacyRest(body, used) {
  const rest = {};
  for (const k of Object.keys(body)) if (!used.includes(k)) rest[k] = body[k];
  return rest;
}

// First-version body { url, profile }: same field names. Bad values become empty text; other keys are kept.
export function upgradeBody(body) {
  const old = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return { ...legacyRest(old, ["url", "profile"]), url: legacyText(old.url).trim(), profile: legacyText(old.profile).trim() };
}

export default {
  activate(host) {
    host.kinds.handle("link", {
      upgrade(ctx, args) {
        return { body: upgradeBody(args && args.body) };
      },
    });
    host.pages.handle("editor", {
      async render(ctx) {
        const ro = ctx.run ? { readOnly: true } : {};
        return {
          view: [
            {
              type: "form",
              id: "main",
              layout: "stack",
              fields: [
                { name: "url", label: ctx.t("field.url"), kind: "text", bind: "body.url", placeholder: ctx.t("field.url.placeholder"), ...ro },
                { name: "profile", label: ctx.t("field.profile"), kind: "text", bind: "body.profile", hint: ctx.t("field.profile.hint"), ...ro },
              ],
            },
          ],
        };
      },
    });

    host.actions.handle("open", async (ctx, input) => {
      const raw = input && typeof input["body.url"] === "string" ? input["body.url"] : pick(ctx, "url");
      if (!String(raw || "").trim()) throw new Error(tr(ctx, "error.noUrl"));
      const url = cleanUrl(raw);
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
