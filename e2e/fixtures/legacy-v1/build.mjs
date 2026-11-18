// Builds a first-version (milestone 1) onedesk.db for the round-13 upgrade tests.
//
//   node e2e/fixtures/legacy-v1/build.mjs <output.db> [--http-base http://127.0.0.1:PORT]
//
// The structure is `0001_init.sql` next to this file (a verbatim copy of
// `git show bf8f6b0^:src-tauri/migrations/0001_init.sql`) plus the `schema_version` table the first version's
// migration runner created (one row, version 1). The data is fixed, so tests can compare against `EXPECTED`.
// Uses node:sqlite (Node 22, no dependency). Refuses to overwrite an existing file and any path inside
// ~/Library/Application Support/onedesk*.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The fixed resources. `body` is what the first version's plugins stored (see docs/handoff/round13-tests-done.md). */
export function resources(httpBase = "http://127.0.0.1:9") {
  const r = (id, kind, name, group_name, tags, description, body, n) => ({
    id,
    kind,
    name,
    group_name,
    tags,
    description,
    body,
    created_at: `2025-03-0${n}T08:00:00.000Z`,
    updated_at: `2025-04-0${n}T09:30:00.000Z`,
  });
  return [
    r("res-link-home", "link", "Example home", "", ["web", "docs"], "Landing page", { url: "https://example.com/", profile: "Work" }, 1),
    r("res-link-tools", "link", "Rust docs", "Work/Tools", ["web"], "", { url: "https://doc.rust-lang.org/", profile: "" }, 2),
    r("res-note-meeting", "note", "Meeting notes", "Work", ["notes"], "Weekly sync", { content: "# Weekly sync\n\n- ship round 13\n- review upgrade" }, 3),
    r("res-note-deep", "note", "Deep note", "Work/Tools/Deep", [], "", { content: "Deep **body**" }, 4),
    r(
      "res-prompt-greet",
      "prompt",
      "Greeting",
      "Prompts/Writing",
      ["writing", "web"],
      "Greets someone",
      {
        template: "Hello {{ name }}, write about {{topic}}.",
        parameters: [{ name: "name", label: "Name", default: "World" }, { name: "topic", required: true }],
      },
      5,
    ),
    r("res-http-echo", "http-request", "Echo", "API", ["api"], "POST an echo", { method: "POST", url: `${httpBase}/echo`, headers: "Content-Type: application/json\nX-Fixture: legacy", body: '{"hello":"world"}' }, 6),
    r("res-http-health", "http-request", "Health", "API", ["api", "web"], "", { method: "GET", url: `${httpBase}/health`, headers: "", body: "" }, 7),
    // A short kind no built-in plugin claims: must survive and show as "no plugin handles this type".
    r("res-sql-orphan", "sql-query", "Orphan query", "Work", [], "", { sql: "select 1", connection: "main" }, 8),
  ];
}

export const COLLECTIONS = [
  { id: "col-tag-web", name: "Everything web", rule_type: "tag", rule_value: "web", created_at: "2025-03-09T08:00:00.000Z" },
  { id: "col-kind-note", name: "All notes", rule_type: "kind", rule_value: "note", created_at: "2025-03-10T08:00:00.000Z" },
];

export const PLUGIN_STORAGE = [
  ["org.onedesk.http", "response:res-http-echo", '{"status":200,"body":"old"}'],
  ["org.onedesk.note", "lastOpened", '"res-note-meeting"'],
];

export const SECRET_NAMES = ["api-token", "github-pat"];

/** `language` is "zh-CN" so a fresh workspace upgrade shows the shell in Chinese. */
export const APP_SETTINGS = [
  ["language", "zh-CN"],
  ["theme", "dark"],
  ["windowBounds", '{"w":1200,"h":800}'],
];

export const PLUGINS = [
  ["org.onedesk.link", 1],
  ["org.onedesk.sample", 0],
];

/** What an upgrade must produce (counts and the group tree), for assertions in the e2e and kernel tests. */
export const EXPECTED = {
  resources: 8,
  collections: 2,
  groups: ["API", "Prompts", "Prompts/Writing", "Work", "Work/Tools", "Work/Tools/Deep"],
  pluginStorage: PLUGIN_STORAGE.length,
  secretNames: SECRET_NAMES,
  language: "zh-CN",
  theme: "dark",
  disabledPlugins: ["org.onedesk.sample"],
};

export function buildLegacyV1(path, { httpBase } = {}) {
  const target = resolve(path);
  if (target.startsWith(resolve(homedir(), "Library/Application Support/onedesk"))) throw new Error("refusing to write into the real data directory");
  if (existsSync(target)) throw new Error(`${target} already exists`);
  const db = new DatabaseSync(target);
  try {
    db.exec(readFileSync(`${HERE}0001_init.sql`, "utf8"));
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (1);");
    const insRes = db.prepare(
      "INSERT INTO resources (id, kind, name, group_name, tags, description, body, visibility, ai_visible, version, created_at, updated_at, origin, search_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const x of resources(httpBase)) {
      const body = JSON.stringify(x.body);
      const search = [x.name, x.description, ...x.tags, body].join(" ").toLowerCase();
      insRes.run(x.id, x.kind, x.name, x.group_name, JSON.stringify(x.tags), x.description, body, "private", 0, 3, x.created_at, x.updated_at, "original", search);
    }
    const insCol = db.prepare("INSERT INTO collections (id, name, rule_type, rule_value, created_at) VALUES (?,?,?,?,?)");
    for (const c of COLLECTIONS) insCol.run(c.id, c.name, c.rule_type, c.rule_value, c.created_at);
    const insPlugin = db.prepare("INSERT INTO plugins (id, enabled, uninstalled, settings, installed_at) VALUES (?,?,0,'{}','2025-03-01T00:00:00.000Z')");
    for (const [id, enabled] of PLUGINS) insPlugin.run(id, enabled);
    const insStore = db.prepare("INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?,?,?)");
    for (const [p, k, v] of PLUGIN_STORAGE) insStore.run(p, k, v);
    const insSecret = db.prepare("INSERT INTO secret_names (name, created_at) VALUES (?,'2025-03-01T00:00:00.000Z')");
    for (const n of SECRET_NAMES) insSecret.run(n);
    const insSetting = db.prepare("INSERT INTO app_settings (key, value) VALUES (?,?)");
    for (const [k, v] of APP_SETTINGS) insSetting.run(k, v);
  } finally {
    db.close();
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args[0];
  if (!out) {
    console.error("usage: node build.mjs <output.db> [--http-base URL]");
    process.exit(2);
  }
  const i = args.indexOf("--http-base");
  console.log(buildLegacyV1(out, { httpBase: i >= 0 ? args[i + 1] : undefined }));
}
