// Round 13: first-version (bf8f6b0^) bodies -> current bodies, per built-in plugin, plus the fixture database.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import link from "../org.onedesk.link/main.js";
// @ts-ignore
import note from "../org.onedesk.note/main.js";
// @ts-ignore
import prompt from "../org.onedesk.prompt/main.js";
// @ts-ignore
import http from "../org.onedesk.http/main.js";
// @ts-ignore
import collection from "../org.onedesk.collection/main.js";
// @ts-ignore
import { buildLegacyV1, EXPECTED, COLLECTIONS } from "../../e2e/fixtures/legacy-v1/build.mjs";
import { registry } from "./view-check";

type Plugin = { activate(host: unknown): void };
const upgradeOf = (plugin: Plugin, kind: string) => {
  const h = registry(plugin).kinds[kind];
  expect(typeof h?.upgrade, `${kind} declares upgrade`).toBe("function");
  return (body: unknown, legacyKind = kind) => h.upgrade({ resource: { id: "r1", name: "n" }, locale: "en-US" }, { body, legacyKind }).body as Record<string, unknown>;
};
const manifest = (dir: string) => JSON.parse(readFileSync(new URL(`../${dir}/manifest.json`, import.meta.url), "utf8"));

describe("manifests claim the first-version short kinds", () => {
  it.each([
    ["org.onedesk.link", ["link"]],
    ["org.onedesk.note", ["note"]],
    ["org.onedesk.prompt", ["prompt"]],
    ["org.onedesk.http", [{ name: "http-request", kind: "request" }]],
    ["org.onedesk.collection", ["collection"]],
  ])("%s", (dir, legacy) => {
    expect(manifest(dir).legacyKinds).toEqual(legacy);
  });
});

describe("link upgrade", () => {
  const up = upgradeOf(link, "link");
  it("keeps url and profile", () => expect(up({ url: "https://a.b/", profile: "Work" })).toEqual({ url: "https://a.b/", profile: "Work" }));
  it("trims, fills the missing profile, keeps unknown keys", () => expect(up({ url: " https://a.b/ ", extra: 1 })).toEqual({ url: "https://a.b/", profile: "", extra: 1 }));
  it.each([[null], [undefined], ["text"], [[1]], [42]])("bad body %j becomes empty fields", (bad) => expect(up(bad)).toEqual({ url: "", profile: "" }));
  it("non-text fields do not throw", () => expect(up({ url: { x: 1 }, profile: 7 })).toEqual({ url: "", profile: "7" }));
});

describe("note upgrade", () => {
  const up = upgradeOf(note, "note");
  it("content becomes text", () => expect(up({ content: "# Hi\n\nthere" })).toEqual({ text: "# Hi\n\nthere" }));
  it("an existing text wins and content is dropped", () => expect(up({ content: "old", text: "new" })).toEqual({ text: "new" }));
  it("keeps unknown keys", () => expect(up({ content: "a", pinned: true })).toEqual({ text: "a", pinned: true }));
  it.each([[null], [undefined], ["x"], [[]], [{}], [{ content: { a: 1 } }]])("bad body %j becomes empty text", (bad) => expect(up(bad)).toEqual({ text: "" }));
});

describe("prompt upgrade", () => {
  const up = upgradeOf(prompt, "prompt");
  it("template becomes text, spaces inside braces are removed, parameters stay", () => {
    const parameters = [{ name: "name", default: "World" }];
    expect(up({ template: "Hi {{ name }} and {{topic}} {{  a_1 }}", parameters })).toEqual({ text: "Hi {{name}} and {{topic}} {{a_1}}", parameters });
  });
  it("leaves other braces alone", () => expect(up({ template: "{{secret:x}} {{ }} {a}" })).toEqual({ text: "{{secret:x}} {{ }} {a}" }));
  it("an existing text wins", () => expect(up({ template: "old", text: "new" })).toEqual({ text: "new" }));
  it.each([[null], [undefined], [3], [[]], [{ template: 5 }]])("bad body %j does not throw", (bad) => expect(typeof up(bad).text).toBe("string"));
});

describe("http-request upgrade (lands in the plugin's kind `request`)", () => {
  const up = upgradeOf(http, "request");
  it("keeps method, url, headers, body and adds query and token", () =>
    expect(up({ method: "POST", url: "http://x/y", headers: "A: b", body: "{}" }, "http-request")).toEqual({ method: "POST", url: "http://x/y", query: "", headers: "A: b", body: "{}", token: "" }));
  it("upper-cases the method; unknown or missing becomes GET", () => {
    expect(up({ method: "patch", url: "u" }).method).toBe("PATCH");
    expect(up({ method: "FETCH", url: "u" }).method).toBe("GET");
    expect(up({ url: "u" }).method).toBe("GET");
  });
  it("keeps unknown keys; bad body becomes an empty GET", () => {
    expect(up({ url: "u", note: 1 }).note).toBe(1);
    expect(up("x")).toEqual({ method: "GET", url: "", query: "", headers: "", body: "", token: "" });
    expect(up({ headers: ["a"], body: null })).toMatchObject({ headers: "", body: "" });
  });
});

describe("collection upgrade", () => {
  const up = upgradeOf(collection, "collection");
  it("declares no new kind names for the short names it claims", () => expect(Object.keys(registry(collection).kinds)).toContain("collection"));
  it("tag rule becomes tags", () => expect(up({ ruleType: "tag", ruleValue: " web " })).toEqual({ kinds: "", tags: "web", text: "" }));
  it.each([
    ["note", "org.onedesk.note:note"],
    ["link", "org.onedesk.link:link"],
    ["prompt", "org.onedesk.prompt:prompt"],
    ["http-request", "org.onedesk.http:request"],
    ["collection", "org.onedesk.collection:collection"],
    ["sql-query", "sql-query"],
    ["a.b:c", "a.b:c"],
    ["note, link", "org.onedesk.note:note,org.onedesk.link:link"],
  ])("kind rule %s becomes kinds %s", (value, kinds) => expect(up({ ruleType: "kind", ruleValue: value })).toEqual({ kinds, tags: "", text: "" }));
  it.each([[null], [undefined], ["x"], [{}], [{ ruleType: "other", ruleValue: "a" }], [{ ruleType: "tag" }], [{ ruleType: "tag", ruleValue: 5 }]])("bad body %j becomes no conditions", (bad) =>
    expect(up(bad)).toEqual({ kinds: "", tags: "", text: "" }));
});

describe("fixture database", () => {
  const dir = mkdtempSync(join(tmpdir(), "onedesk-legacy-v1-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const path = buildLegacyV1(join(dir, "onedesk.db"), { httpBase: "http://127.0.0.1:5555" });
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT id, kind, group_name, body FROM resources ORDER BY id").all() as { id: string; kind: string; group_name: string; body: string }[];

  it("has the first-version structure and the expected counts", () => {
    expect(rows).toHaveLength(EXPECTED.resources);
    expect((db.prepare("SELECT COUNT(*) AS n FROM collections").get() as { n: number }).n).toBe(COLLECTIONS.length);
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM secret_names").get() as { n: number }).n).toBe(EXPECTED.secretNames.length);
    expect((db.prepare("SELECT value FROM app_settings WHERE key='language'").get() as { value: string }).value).toBe("zh-CN");
  });
  it("group_name covers the declared group tree", () => {
    const paths = new Set<string>();
    for (const r of rows) if (r.group_name) r.group_name.split("/").forEach((_, i, a) => paths.add(a.slice(0, i + 1).join("/")));
    expect([...paths].sort()).toEqual([...EXPECTED.groups].sort());
  });
  const byKind: Record<string, [Plugin, string]> = { link: [link, "link"], note: [note, "note"], prompt: [prompt, "prompt"], "http-request": [http, "request"] };
  it("every claimed first-version row upgrades to a body of strings only", () => {
    for (const r of rows) {
      const target = byKind[r.kind];
      if (!target) continue;
      const out = upgradeOf(target[0], target[1])(JSON.parse(r.body), r.kind);
      for (const key of ["url", "text", "method"]) if (key in out) expect(typeof out[key], `${r.id}.${key}`).toBe("string");
    }
  });
  it("the first-version http row and prompt row upgrade as documented", () => {
    const echo = rows.find((r) => r.id === "res-http-echo")!;
    expect(upgradeOf(http, "request")(JSON.parse(echo.body), "http-request")).toMatchObject({ method: "POST", url: "http://127.0.0.1:5555/echo", query: "", token: "" });
    const greet = rows.find((r) => r.id === "res-prompt-greet")!;
    expect(upgradeOf(prompt, "prompt")(JSON.parse(greet.body)).text).toBe("Hello {{name}}, write about {{topic}}.");
  });
  it("collections upgrade", () => {
    const upc = upgradeOf(collection, "collection");
    const cols = db.prepare("SELECT rule_type, rule_value FROM collections ORDER BY id" /* col-kind-note, col-tag-web */).all() as { rule_type: string; rule_value: string }[];
    expect(cols.map((c) => upc({ ruleType: c.rule_type, ruleValue: c.rule_value }))).toEqual([
      { kinds: "org.onedesk.note:note", tags: "", text: "" },
      { kinds: "", tags: "web", text: "" },
    ]);
  });
  it("refuses to overwrite and to write into the real data directory", () => {
    expect(() => buildLegacyV1(path)).toThrow(/already exists/);
    expect(() => buildLegacyV1(join(process.env.HOME ?? "/", "Library/Application Support/onedesk/x.db"))).toThrow(/real data/);
  });
});
