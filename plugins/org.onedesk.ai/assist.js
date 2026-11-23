// Writing help for the whole workbench (D462, docs/redesign/ai-assist.md): the shell's ✨ buttons start this
// action through the kernel (`assist.start`, interface `onedesk.assist/1`). Two steps, each one run:
//   prepare → what would be sent (the user reads it when the policy is `preview`), nothing leaves the machine;
//   send    → the request is built again from the same input (never taken from the caller) and sent.
// The answer is a proposal: the shell shows it and writes nothing until the user accepts.
// Contract (input and the JSON in the output text): ai-assist.md §9.

export const MODES = ["field", "fill"];
export const VALUE_MAX = 4000; // the field being written
export const OTHER_MAX = 500; // every other field, as context
export const FIELDS_MAX = 30;
export const INSTRUCTION_MAX = 2000;

const str = (v) => (v === null || v === undefined ? "" : String(v));

// The field's format for the helper: the plugin's `assist.format`, else from the field kind.
export function formatOf(f) {
  if (f.format) return str(f.format);
  if (f.kind === "code") return f.language ? `code:${f.language}` : "code";
  if (f.kind === "longtext") return "markdown";
  return "text";
}

// Only what the shell may send: plain fields, no secrets; values masked (emails, long numbers) and cut; a field
// whose name looks sensitive (password, token, email…) never sends its value.
export function cleanInput(input, deps) {
  const i = input || {};
  const mode = MODES.includes(i.mode) ? i.mode : "field";
  const instruction = deps.maskText(str(i.instruction).trim(), INSTRUCTION_MAX);
  const page = { title: deps.maskText(str(i.page && i.page.title), 200), kind: deps.maskText(str(i.page && i.page.kind), 100) };
  const raw = Array.isArray(i.fields) ? i.fields.slice(0, FIELDS_MAX) : [];
  const target = str(i.field);
  const fields = raw
    .filter((f) => f && typeof f.name === "string" && f.name && f.kind !== "secret")
    .map((f) => {
      const name = str(f.name);
      const label = deps.maskText(str(f.label) || name, 100);
      const sensitive = deps.isSensitiveColumn([name, label], []);
      const max = mode === "fill" || name === target ? VALUE_MAX : OTHER_MAX;
      return {
        name,
        label,
        format: formatOf(f),
        hint: deps.maskText(str(f.hint), 300),
        value: sensitive ? deps.MASK : deps.maskText(str(f.value), max),
        sensitive,
      };
    });
  return { mode, instruction, page, fields, field: target };
}

const fence = (format, text) => ["```" + (format.startsWith("code:") ? format.slice(5) : ""), text, "```"].join("\n");

// The words the model gets: a system text and one request (Markdown), in the user's language.
export function compose(ctx, c, tr) {
  const lines = [];
  const head = [c.page.kind, c.page.title].filter(Boolean).join(" · ");
  if (head) lines.push(`# ${head}`, "");
  lines.push(`## ${tr(ctx, "assist.request.instruction")}`, "", c.instruction || tr(ctx, "assist.request.noInstruction"), "");
  if (c.mode === "field") {
    const f = c.fields.find((x) => x.name === c.field);
    if (f) {
      lines.push(`## ${tr(ctx, "assist.request.field", { label: f.label, format: f.format })}`, "");
      if (f.hint) lines.push(f.hint, "");
      lines.push(f.value ? fence(f.format, f.value) : tr(ctx, "assist.request.empty"), "");
    }
    const others = c.fields.filter((x) => x.name !== c.field && x.value);
    if (others.length > 0) {
      lines.push(`## ${tr(ctx, "assist.request.context")}`, "");
      for (const o of others) lines.push(`- **${o.label}**: ${o.value.replace(/\r?\n/g, " ")}`);
      lines.push("");
    }
  } else {
    lines.push(`## ${tr(ctx, "assist.request.fields")}`, "");
    for (const f of c.fields) {
      lines.push(`### \`${f.name}\` — ${f.label} (${f.format})`);
      if (f.hint) lines.push(f.hint);
      lines.push(f.value ? fence(f.format, f.value) : tr(ctx, "assist.request.empty"), "");
    }
  }
  const system = tr(ctx, c.mode === "fill" ? "assist.system.fill" : "assist.system.field");
  return { system, request: lines.join("\n").trim() };
}

// A code block around the whole answer is taken off; the rest is kept as written.
export function unfence(text) {
  const t = str(text).trim();
  const m = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(t);
  return m ? m[1] : t;
}

// The fill answer: one JSON object; only the fields that were asked for, as strings.
export function parseFill(text, fields) {
  const t = unfence(text);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const f of fields) if (f.name in obj && obj[f.name] !== null && obj[f.name] !== undefined && !f.sensitive) out[f.name] = typeof obj[f.name] === "string" ? obj[f.name] : JSON.stringify(obj[f.name]);
  return out;
}

const answer = (data) => ({ output: { type: "text", text: JSON.stringify(data) }, data });
const failure = (code, message) => answer({ error: { code, message } });

// The action. `deps`: the AI plugin's own helpers (policy, connection, chat, audit, masking, words).
export async function assist(ctx, input, deps) {
  const step = input && input.step === "send" ? "send" : "prepare";
  const c = cleanInput(input, deps);
  if (c.mode === "field" && !c.fields.some((f) => f.name === c.field)) return failure("badField", deps.tr(ctx, "assist.error.badField"));
  if (c.mode === "fill" && c.fields.length === 0) return failure("noFields", deps.tr(ctx, "assist.error.noFields"));
  const policy = await deps.policyOf(ctx);
  if (policy === "off") return failure("policyOff", deps.tr(ctx, "error.policyOff"));
  let connection;
  try {
    connection = await deps.pickConnection(ctx);
  } catch (e) {
    return failure("noConnection", str(e && e.message ? e.message : e));
  }
  const { system, request } = compose(ctx, c, deps.tr);
  if (step === "prepare") {
    return answer({ step, policy, mode: c.mode, connection: connection.name, model: connection.model, tokens: deps.estimateTokens(`${system}\n${request}`), system, request });
  }
  let res;
  try {
    res = await deps.chat(ctx, connection, { system, messages: [{ role: "user", text: request }], format: c.mode === "fill" ? "json" : "text" });
  } catch (e) {
    return failure("chat", str(e && e.message ? e.message : e));
  }
  await deps.audit(ctx, { kind: "assist", mode: c.mode, connection: connection.id, model: res.model || "", chars: request.length, usage: res.usage || null });
  const base = { step, mode: c.mode, model: res.model || connection.model, usage: res.usage || null };
  if (c.mode === "fill") {
    const values = parseFill(res.text, c.fields);
    if (!values || Object.keys(values).length === 0) return failure("badAnswer", deps.tr(ctx, "assist.error.badAnswer"));
    return answer({ ...base, values });
  }
  return answer({ ...base, field: c.field, text: unfence(res.text) });
}
