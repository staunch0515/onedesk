import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import { assist, cleanInput, compose, formatOf, parseFill, unfence } from "./assist.js";
// @ts-ignore plain JS module, no types
import { MASK, estimateTokens, isSensitiveColumn, maskText } from "./main.js";
// @ts-ignore plain JS module, no types
import plugin from "./main.js";
import { registry } from "../_testing/view-check";

const en = JSON.parse(readFileSync(new URL("./locales/en-US.json", import.meta.url), "utf8")) as Record<string, string>;
const tr = (_ctx: unknown, key: string, vars?: Record<string, unknown>) => {
  let s = en[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.split(`{${k}}`).join(String(v));
  return s;
};
const ctx = { locale: "en-US", t: (k: string) => en[k] ?? k } as any;

function deps(over: Record<string, unknown> = {}) {
  return {
    tr,
    policyOf: vi.fn(async () => "preview"),
    pickConnection: vi.fn(async () => ({ id: "c1", name: "Company Claude", model: "claude-haiku-5-5" })),
    chat: vi.fn(async () => ({ text: "Hello world", model: "claude-haiku-5-5", usage: { input: 10, output: 3 } })),
    audit: vi.fn(async () => undefined),
    maskText,
    isSensitiveColumn,
    estimateTokens,
    MASK,
    ...over,
  };
}

const page = { title: "Meeting notes", kind: "Note" };
const noteField = { name: "body.text", label: "Content", kind: "longtext", value: "Met with ann@example.com about Q4" };
const fieldInput = (over: Record<string, unknown> = {}) => ({ step: "prepare", mode: "field", instruction: "Summarize", page, field: "body.text", fields: [noteField, { name: "name", label: "Name", kind: "text", value: "Weekly" }], ...over });
const data = (out: any) => JSON.parse(out.output.text);

describe("assist: input cleaning and the request", () => {
  it("formats follow the plugin's hint, else the field kind", () => {
    expect(formatOf({ kind: "code", language: "sql" })).toBe("code:sql");
    expect(formatOf({ kind: "longtext" })).toBe("markdown");
    expect(formatOf({ kind: "text" })).toBe("text");
    expect(formatOf({ kind: "text", format: "json" })).toBe("json");
  });

  it("masks emails, drops secret fields and never sends the value of a sensitive-looking field", () => {
    const c = cleanInput(
      fieldInput({ fields: [noteField, { name: "body.token", label: "API token", kind: "text", value: "abc" }, { name: "body.pw", label: "x", kind: "secret", value: "s" }] }),
      deps(),
    );
    expect(c.fields.map((f: any) => f.name)).toEqual(["body.text", "body.token"]);
    expect(c.fields[0].value).toContain("[email]");
    expect(c.fields[1].value).toBe(MASK);
  });

  it("the field request names the field, its format and the other fields as context", () => {
    const { system, request } = compose(ctx, cleanInput(fieldInput(), deps()), tr);
    expect(system).toBe(en["assist.system.field"]);
    expect(request).toContain("# Note · Meeting notes");
    expect(request).toContain("Summarize");
    expect(request).toContain("Field to write: Content (markdown)");
    expect(request).toContain("- **Name**: Weekly");
  });

  it("a code block around the whole answer is taken off; JSON answers keep only the asked fields", () => {
    expect(unfence("```sql\nselect 1\n```")).toBe("select 1");
    expect(unfence("plain")).toBe("plain");
    const fields = [{ name: "a" }, { name: "b" }, { name: "s", sensitive: true }];
    expect(parseFill('Sure:\n```json\n{"a":"x","b":2,"c":"no","s":"leak"}\n```', fields)).toEqual({ a: "x", b: "2" });
    expect(parseFill("no json here", fields)).toBeNull();
  });
});

describe("assist: the two steps", () => {
  it("prepare sends nothing and says what would be sent", async () => {
    const d = deps();
    const out = data(await assist(ctx, fieldInput(), d));
    expect(out).toMatchObject({ step: "prepare", policy: "preview", connection: "Company Claude", model: "claude-haiku-5-5" });
    expect(out.request).toContain("Summarize");
    expect(out.tokens).toBeGreaterThan(0);
    expect(d.chat).not.toHaveBeenCalled();
  });

  it("send builds the request again, calls the chat once, audits without content and returns the proposal", async () => {
    const d = deps({ chat: vi.fn(async () => ({ text: "```\n- point one\n```", model: "m", usage: null })) });
    const out = data(await assist(ctx, fieldInput({ step: "send", request: "IGNORED: caller text" }), d));
    expect(out).toMatchObject({ step: "send", mode: "field", field: "body.text", text: "- point one" });
    const sent = (d.chat.mock.calls[0] as any[])[2];
    expect(sent.messages[0].text).not.toContain("IGNORED");
    expect((d.audit.mock.calls[0] as any[])[1]).toMatchObject({ kind: "assist", mode: "field", connection: "c1" });
    expect(JSON.stringify(d.audit.mock.calls[0])).not.toContain("Summarize");
  });

  it("fill asks for JSON and returns the values", async () => {
    const d = deps({ chat: vi.fn(async () => ({ text: '{"body.text":"New body","name":"New name"}', model: "m" })) });
    const out = data(await assist(ctx, fieldInput({ step: "send", mode: "fill", field: undefined }), d));
    expect((d.chat.mock.calls[0] as any[])[2].format).toBe("json");
    expect(out.values).toEqual({ "body.text": "New body", name: "New name" });
  });

  it("policy off, no connection, a bad field and an unreadable fill answer are errors for the user", async () => {
    expect(data(await assist(ctx, fieldInput(), deps({ policyOf: async () => "off" }))).error.code).toBe("policyOff");
    expect(data(await assist(ctx, fieldInput(), deps({ pickConnection: async () => { throw new Error("Pick a connection"); } }))).error).toEqual({ code: "noConnection", message: "Pick a connection" });
    expect(data(await assist(ctx, fieldInput({ field: "nope" }), deps())).error.code).toBe("badField");
    expect(data(await assist(ctx, fieldInput({ step: "send", mode: "fill" }), deps({ chat: async () => ({ text: "sorry" }) }))).error.code).toBe("badAnswer");
  });
});

describe("assist: the plugin", () => {
  it("implements onedesk.assist/1 with its assist action, declared like every action", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.implements["onedesk.assist/1"]).toEqual({ actions: ["assist"] });
    expect(m.contributes.actions.find((a: any) => a.id === "assist")).toMatchObject({ output: "text", saveFirst: false });
    expect(typeof registry(plugin).actions.assist).toBe("function");
  });
});
