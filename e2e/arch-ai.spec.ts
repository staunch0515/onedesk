/** Round 19: the `ai` exception of scripts/check-arch.mjs is as narrow as documented (operator forms only; the plugin name stays banned). */
import { expect, test } from "@playwright/test";
// @ts-expect-error plain .mjs
import { stripAllowedAi } from "../scripts/check-arch-ai.mjs";

const hit = (line: string, file = "x.rs") => /(?<![A-Za-z0-9_])ai(?![A-Za-z0-9_])/i.test(stripAllowedAi(line, file));

test("operator forms are allowed in Rust", () => {
  for (const l of [
    "Actor::Ai { client: client.into() }",
    "    Ai { client: String },",
    'actor.strip_prefix("ai:")',
    'format!("ai:{c}")',
    'tab_id: "ai".into(),',
    'ctx["ai"] = json!({ "client": c });',
    "pub ai: Option<ActionAi>,",
    "let Some(ai) = &a.ai else { continue };",
    "if !ai.read_only {",
    'a == "--ai-client"',
    '"Find resources the user made visible to AI by words"',
    '"in the environment the user chose for AI, and return"',
    'bad(format!("{}: an AI action has no confirm", a.id))',
  ]) expect(hit(l), l).toBe(false);
  expect(hit("-- 0014: an AI client may see this resource", "m.sql")).toBe(false);
});

test("everything else still fails", () => {
  expect(hit('let id = "org.onedesk.ai";')).toBe(true);
  expect(hit("let p = org.onedesk.ai;")).toBe(true);
  expect(hit('"AI provider is down"')).toBe(true);
  expect(hit('"ai:x" // fine but', "x.ts")).toBe(true); // only .rs / .sql lines are touched
  expect(hit("// the AI plugin")).toBe(true);
  expect(hit('let k = "ai-chat";')).toBe(true);
  expect(hit('"ai"', "m.json")).toBe(true);
  // the literal exception is exact: nothing may follow the colon (a plugin id there must still fail)
  expect(hit('let a = "ai:org.onedesk.sql run";')).toBe(true);
  expect(hit('let a = "ai:anthropic";')).toBe(true);
  expect(hit('let a = "ai:{client} extra";')).toBe(true);
  expect(hit('let a = "ai:{x.y}";')).toBe(true);
  expect(hit('let a = "ai-x";')).toBe(true);
  // .sql: only whole-line comments are skipped, not text after `--` inside a statement
  expect(hit("SELECT 'x -- ai plugin' FROM t;", "m.sql")).toBe(true);
});
