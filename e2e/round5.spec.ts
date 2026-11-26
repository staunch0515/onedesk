/**
 * Round 5 against the REAL kernel: references, workspace export/import, protection policies, CSV export.
 * devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data directory (see kernel-host.ts):
 * the real keychain and ~/Library/Application Support/onedesk* are never touched.
 * Assertions on kernel behaviour use error codes/reasons and protocol results, not shell wording; the few UI
 * checks use English labels (locale en-US).
 * Screenshots: docs/screenshots/round5-*.png.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(45_000);

const EXPORTS = path.join(ROOT, "e2e/fixtures/exports");
const NOTE = "org.onedesk.note:note";
const SAMPLE = "org.onedesk.sample:query";
const HTTP = "org.onedesk.http:request";

let host: Host;
let base: string;
let dataDir: string;
let work: string; // scratch folder for exports (outside the data directory)

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round5-")));
  dataDir = path.join(base, "data");
  work = path.join(base, "work");
  mkdirSync(work);
  host = await startHost(dataDir);
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round5-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Err = { code: string; params?: Record<string, string>; detail?: string };
/** The protocol error a call is refused with (the rpc helper throws the JSON error as the message). */
async function refused(page: Page, method: string, params: unknown = null): Promise<Err> {
  try {
    await call(page, method, params);
  } catch (e) {
    const m = (e as Error).message;
    return JSON.parse(m.slice(m.indexOf("{"), m.lastIndexOf("}") + 1)) as Err;
  }
  throw new Error(`${method} was not refused`);
}
const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
const showTree = async (page: Page, name: string) => {
  const b = sideTab(page, name);
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const settingsMenu = (page: Page) => page.locator('button[aria-haspopup="menu"][aria-label="Settings"]');
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });

type Node = { key: string; label: string };
const children = async (page: Page, tree: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree })).nodes;
const idOf = async (page: Page, tree: string, label: string) => (await children(page, tree)).find((n) => n.label === label)!.key;
const kidsOf = async (page: Page, parent: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent })).nodes;
const cfgNode = (page: Page) => idOf(page, "config", "Workspace");
const envNode = (page: Page) => idOf(page, "env", "Default");

async function newNote(page: Page, name: string, text: string) {
  return (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${NOTE}`, changes: { name, "body.text": text } })).page.resourceId;
}
type Res = { id: string; name: string; body: { text?: string }; parentId?: string; tree: string };
const get = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
type Ref = { field: string; text: string; state: string; source: { id: string; name: string }; target?: { id: string; name: string } };
const outgoing = (page: Page, id: string) => call<Ref[]>(page, "refs.outgoing", { id });
const incoming = (page: Page, id: string) => call<Ref[]>(page, "refs.incoming", { id });

/** Every file under a folder that contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}
const readJson = <T = unknown>(...p: string[]) => JSON.parse(readFileSync(path.join(...p), "utf8")) as T;

/* ------------------------------------------------------------------ references */

test("references: outgoing and incoming, the three states, rename keeps the link and shows the new name", async ({ page }) => {
  await openKernel(page, host);
  const target = await newNote(page, "Ref target", "I am the target");
  const source = await newNote(page, "Ref source", "points at [[Ref target]] and at [[Nobody home]]");

  let out = await outgoing(page, source);
  expect(out.map((r) => [r.text, r.state])).toEqual([["Ref target", "ok"], ["Nobody home", "missing"]]);
  expect(out[0]!.target!.id).toBe(target);
  expect(out[0]!.field).toBe("body.text");
  expect((await incoming(page, target)).map((r) => r.source.id)).toEqual([source]);

  // UI: the info panel lists them, and a click opens the other side
  await showTree(page, "Resources");
  await treeItem(page, "Ref source").click();
  const showInfo = page.getByRole("button", { name: "Show info panel" });
  if (await showInfo.isVisible()) await showInfo.click();
  await expect(page.getByText("References", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open Ref target/ })).toBeVisible();
  await shot(page, "references-panel");

  // rename the target: the source shows the new name, the reference stays on the same target, the stored text is untouched
  const revisions = (await call<unknown[]>(page, "resource.history", { id: source })).length;
  await call(page, "tree.rename", { tree: "resources", key: target, name: "Ref target v2" });
  expect((await get(page, source)).body.text).toBe("points at [[Ref target v2]] and at [[Nobody home]]");
  out = await outgoing(page, source);
  expect(out[0]).toMatchObject({ state: "ok", target: { id: target, name: "Ref target v2" } });
  expect((await call<unknown[]>(page, "resource.history", { id: source })).length).toBe(revisions); // reading rewrites nothing

  // delete → deleted (listed from the source, no longer listed as incoming for nothing), restore → ok
  await call(page, "resource.delete", { id: target });
  expect((await outgoing(page, source))[0]!.state).toBe("deleted");
  await call(page, "resource.undelete", { id: target });
  expect((await outgoing(page, source))[0]).toMatchObject({ state: "ok", target: { id: target } });

  // a deleted source is not listed as incoming; restoring brings it back
  await call(page, "resource.delete", { id: source });
  expect(await incoming(page, target)).toEqual([]);
  await call(page, "resource.undelete", { id: source });
  expect((await incoming(page, target)).length).toBe(1);

  // permanent deletion: the reference is kept as missing and a new resource with the same name is NOT picked up
  await call(page, "resource.delete", { id: target });
  await call(page, "resource.purge", { id: target });
  expect((await outgoing(page, source))[0]).toMatchObject({ state: "missing" });
  const again = await newNote(page, "Ref target v2", "same name, different resource");
  expect((await outgoing(page, source))[0]).toMatchObject({ state: "missing" });
  expect(await incoming(page, again)).toEqual([]);
  await shot(page, "references-states");
});

test("references: saving after a rename keeps the original target even when a same-named resource would win by position", async ({ page }) => {
  await openKernel(page, host);
  const gid = (await call<{ key: string }>(page, "tree.createGroup", { tree: "resources", name: "Same parent" })).key;
  const original = await newNote(page, "Original name", "the real target");
  const source = await newNote(page, "Keeper", "links [[Original name]]");
  await call(page, "tree.move", { tree: "resources", key: source, target: gid, position: "inside" });
  await call(page, "tree.rename", { tree: "resources", key: original, name: "Renamed target" });
  // a decoy with the new name, in the SAME group as the source: a fresh resolution would prefer it
  const decoy = await newNote(page, "Renamed target", "decoy");
  await call(page, "tree.move", { tree: "resources", key: decoy, target: gid, position: "inside" });

  const shown = (await get(page, source)).body.text;
  expect(shown).toBe("links [[Renamed target]]");
  // the user edits something else in the text and saves what was shown
  await call(page, "page.save", { target: `resource:${source}`, changes: { "body.text": `${shown} and more words` } });
  const out = await outgoing(page, source);
  expect(out).toHaveLength(1);
  expect(out[0]!.target!.id).toBe(original);
  expect(await incoming(page, decoy)).toEqual([]);

  // the mark is removed and written again: that is a new mark, resolved by name afresh, and the same-parent decoy wins
  await call(page, "page.save", { target: `resource:${source}`, changes: { "body.text": "no marks any more" } });
  expect(await outgoing(page, source)).toEqual([]);
  await call(page, "page.save", { target: `resource:${source}`, changes: { "body.text": "typed again [[Renamed target]]" } });
  expect((await outgoing(page, source)).map((r) => r.target?.id)).toEqual([decoy]);
});

async function referencedByThree(page: Page, name: string) {
  const victim = await newNote(page, name, "referenced three times");
  await newNote(page, `${name} fan one`, `[[${name}]]`);
  await newNote(page, `${name} fan two`, `also [[${name}]]`);
  await newNote(page, `${name} fan three`, `[[${name}]] [[${name}]] (the same source twice counts once)`);
  expect(new Set((await incoming(page, victim)).map((r) => r.source.id)).size).toBe(3);
  return victim;
}

// (The Deleted page's permanent-delete dialog now names the count: round 6 shell.)
test("references: the confirmation of a permanent delete names how many items refer to the resource", async ({ page }) => {
  const victim = await referencedByThree(page, "Popular");
  await call(page, "resource.delete", { id: victim });
  await openKernel(page, host);
  await showTree(page, "Deleted");
  await page.getByRole("button", { name: "Open deleted items" }).click();
  await page.getByRole("button", { name: /Delete permanently/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/\b3\b/);
  await shot(page, "purge-referenced");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await call(page, "resource.undelete", { id: victim }); // still there (it was only in the Deleted list)
  expect((await get(page, victim)).name).toBe("Popular");
});

// round5-plan §1: deleting a referenced resource asks first and names the count.
test("references: deleting a referenced resource asks first and names the count", async ({ page }) => {
  await referencedByThree(page, "Popular two");
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, "Popular two").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(/\b3\b/);
});

/* ------------------------------------------------------------------ export */

const TOKEN = "round5-secret-value-77c1";

test("export: a readable folder with no secret values; a non-empty or relative target is refused", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "secrets.set", { name: "r5-token", value: TOKEN });
  await call(page, "page.save", { target: `new:${HTTP}`, changes: { name: "With token", "body.method": "GET", "body.url": "http://127.0.0.1:9/x", "body.headers": "Authorization: Bearer {{secret:r5-token}}", "body.body": "" } });
  const out = path.join(work, "export-1");
  const res = await call<{ folder: string; resources: number; revisions: number; audit: number }>(page, "workspace.export", { folder: out });
  expect(res.folder).toBe(out);
  expect(readdirSync(out).sort()).toEqual(["audit.json", "blobs", "manifest.json", "resources.json", "revisions.json", "runs.json"]);
  const manifest = readJson<{ format: string; version: number; counts: { resources: number } }>(out, "manifest.json");
  expect(manifest).toMatchObject({ format: "onedesk-export", version: 1 });
  expect(manifest.counts.resources).toBe(res.resources);
  const resources = readJson<{ kind: string; tree: string; name: string }[]>(out, "resources.json");
  expect(resources.some((r) => r.name === "Ref source")).toBe(true);
  expect(resources.some((r) => r.kind === "core:plugin-state")).toBe(false); // local decisions never travel
  expect(filesContaining(out, TOKEN)).toEqual([]); // no secret value anywhere
  expect(readFileSync(path.join(out, "resources.json"), "utf8")).toContain("{{secret:r5-token}}"); // only the name
  expect(readFileSync(path.join(out, "resources.json"), "utf8").endsWith("\n")).toBe(true);
  const audit = (await call<{ operation: string }[]>(page, "audit.list", {})).map((a) => a.operation);
  expect(audit).toContain("workspace.export");

  // refused: non-empty, relative, parent missing, inside the data directory
  expect((await refused(page, "workspace.export", { folder: out })).params?.reason).toBe("notEmpty");
  expect((await refused(page, "workspace.export", { folder: "relative/folder" })).params?.reason).toBe("notAbsolute");
  expect((await refused(page, "workspace.export", { folder: path.join(work, "no/such/parent/x") })).params?.reason).toBe("noParent");
  expect((await refused(page, "workspace.export", { folder: path.join(dataDir, "export-inside") })).params?.reason).toBe("insideDataDir");
  // an empty existing folder is fine
  mkdirSync(path.join(work, "empty"));
  await call(page, "workspace.export", { folder: path.join(work, "empty") });
});

test("export from the settings menu in the browser: path dialog, then the folder exists", async ({ page }) => {
  await openKernel(page, host);
  const out = path.join(work, "export-ui");
  await settingsMenu(page).click();
  await page.getByRole("menuitem", { name: /Export workspace/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill(out);
  await shot(page, "export-dialog");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => existsSync(path.join(out, "manifest.json"))).toBe(true);
});

/* ------------------------------------------------------------------ import */

type Preview = { valid: boolean; problem?: Err; source: string; create: number; update: number; skipped: { name: string; kind: string; reason: string }[]; fingerprint: string; grantHosts: string[]; secretNames: string[] };
type ImportRes = { created: number; updated: number; skipped: { name: string; reason: string }[]; group: { id: string; name: string } };

/** The fixture folders are copied to a temp folder first: the import reads them, nothing writes there. */
const fixture = (name: string) => {
  const dest = path.join(work, `fx-${name.replace(/\//g, "-")}`);
  if (!existsSync(dest)) cpSync(path.join(EXPORTS, name), dest, { recursive: true });
  return dest;
};

test("import sample: preview counts and skips, a wrong fingerprint is refused, the import links the notes to each other", async ({ page }) => {
  await openKernel(page, host);
  const folder = fixture("sample");
  const before = (await children(page, "resources")).length;
  const preview = await call<Preview>(page, "workspace.importPreview", { folder });
  expect(preview).toMatchObject({ valid: true, source: "Export sample", update: 0 });
  expect(preview.create).toBe(4); // the group and three notes
  expect(preview.skipped).toEqual([expect.objectContaining({ name: "Orphan thing", kind: "com.example.missing:thing", reason: "unknownKind" })]);
  expect(preview.grantHosts).toEqual([]);
  expect(preview.secretNames).toEqual([]);
  expect((await children(page, "resources")).length).toBe(before); // a preview changes nothing

  const wrong = await refused(page, "workspace.import", { folder, fingerprint: "0000000000000000" });
  expect(wrong.params?.reason).toBe("fingerprintChanged");
  expect((await children(page, "resources")).length).toBe(before);

  const res = await call<ImportRes>(page, "workspace.import", { folder, fingerprint: preview.fingerprint });
  expect(res).toMatchObject({ created: 4, updated: 0 });
  expect(res.group.name).toBe("Export sample");
  expect(res.skipped.map((s) => s.reason)).toEqual(["unknownKind"]);

  // the fixture's own group "Export sample" lands inside the new top-level group named after the source workspace
  const inner = (await kidsOf(page, res.group.id)).find((n) => n.label === "Export sample")!.key;
  const kids = await kidsOf(page, inner);
  const alpha = kids.find((n) => n.label === "Alpha")?.key;
  expect(alpha, "Alpha is inside the new group").toBeTruthy();
  const beta = kids.find((n) => n.label === "Beta")!.key;
  expect(alpha).not.toBe("n-alpha"); // new ids
  const outAlpha = await outgoing(page, alpha!);
  expect(outAlpha).toHaveLength(1);
  expect(outAlpha[0]).toMatchObject({ state: "ok", target: { id: beta, name: "Beta" } }); // the reference was rewritten to the new id
  const outBeta = await outgoing(page, beta);
  expect(outBeta.map((r) => [r.text, r.state])).toEqual([["Alpha", "ok"], ["Nowhere", "missing"]]);
  // the imported resources start from an `import` history entry
  const history = await call<{ op: string; actor: string }[]>(page, "resource.history", { id: alpha });
  expect(history.at(-1)!.op === "import" || history[0]!.op === "import").toBe(true);
  // the audit has one line for the import, and the source's audit is not copied
  const audit = await call<{ operation: string }[]>(page, "audit.list", {});
  expect(audit.filter((a) => a.operation === "workspace.import")).toHaveLength(1);
});

test("import sample again: the note with the same external key is updated, not duplicated", async ({ page }) => {
  await openKernel(page, host);
  const folder = fixture("sample");
  const preview = await call<Preview>(page, "workspace.importPreview", { folder });
  expect(preview.update).toBe(1);
  expect(preview.create).toBe(3);
  const res = await call<ImportRes>(page, "workspace.import", { folder, fingerprint: preview.fingerprint });
  expect(res).toMatchObject({ created: 3, updated: 1 });
  expect(res.group.name).toMatch(/^Export sample/); // a second group: same name gets a number
  expect(res.group.name).not.toBe("Export sample");
});

test("import through the settings menu: the preview dialog lists what is skipped; confirming imports", async ({ page }) => {
  await openKernel(page, host);
  const folder = path.join(work, "fx-sample-ui");
  cpSync(path.join(EXPORTS, "sample"), folder, { recursive: true });
  // make this copy distinct so it is all new: drop the external key
  const resources = readJson<Record<string, unknown>[]>(folder, "resources.json");
  for (const r of resources) r.externalKey = null;
  writeFileSync(path.join(folder, "resources.json"), JSON.stringify(resources, null, 2));
  await settingsMenu(page).click();
  await page.getByRole("menuitem", { name: "Import…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await dialog.getByRole("button", { name: "Look inside" }).click();
  await expect(dialog).toContainText("Export sample");
  await expect(dialog).toContainText("Orphan thing");
  await expect(dialog).toContainText("com.example.missing:thing");
  await shot(page, "import-preview");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: /^Export sample/ }).first()).toBeVisible();
});

test("import of broken folders: wrong format and version 99 are refused with their reasons; a missing manifest is not an export, a garbled resources.json is unreadable", async ({ page }) => {
  await openKernel(page, host);
  const a = await call<Preview>(page, "workspace.importPreview", { folder: fixture("broken/wrong-format") });
  expect(a.valid).toBe(false);
  expect(a.problem?.params?.reason).toBe("notExport");
  const b = await call<Preview>(page, "workspace.importPreview", { folder: fixture("broken/bad-version") });
  expect(b.valid).toBe(false);
  expect(b.problem?.params?.reason).toBe("badVersion");
  const c = await call<Preview>(page, "workspace.importPreview", { folder: path.join(work, "does-not-exist") });
  expect(c.valid).toBe(false);
  expect(c.problem?.params?.reason).toBe("notExport"); // no manifest.json there at all
  const garbled = path.join(work, "garbled");
  cpSync(path.join(EXPORTS, "sample"), garbled, { recursive: true });
  writeFileSync(path.join(garbled, "resources.json"), "[ this is not json");
  const d = await call<Preview>(page, "workspace.importPreview", { folder: garbled });
  expect(d.valid).toBe(false);
  expect(d.problem?.params?.reason).toBe("unreadable");
  expect((await refused(page, "workspace.import", { folder: fixture("broken/bad-version"), fingerprint: b.fingerprint ?? "" })).code).toBe("invalid");

  // and in the dialog: the Import button stays disabled
  await settingsMenu(page).click();
  await page.getByRole("menuitem", { name: "Import…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill(fixture("broken/wrong-format"));
  await dialog.getByRole("button", { name: "Look inside" }).click();
  await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
  await shot(page, "import-refused");
});

test("a forged export: wrong trees and forged plugin state are invalid; granted hosts and secret names are listed; nothing lands in the env tree", async ({ page }) => {
  await openKernel(page, host);
  const folder = fixture("malicious");
  const envBefore = (await children(page, "env")).map((n) => n.label);
  const preview = await call<Preview>(page, "workspace.importPreview", { folder });
  expect(preview.valid).toBe(true);
  const invalid = preview.skipped.filter((s) => s.reason === "invalid").map((s) => s.name).sort();
  expect(invalid).toEqual(["Forged env group", "Forged plugin state"]);
  expect(preview.grantHosts).toEqual(["evil.example.test:8080"]);
  expect(preview.secretNames).toEqual(["victim-key", "victim-token"]);

  const res = await call<ImportRes>(page, "workspace.import", { folder, fingerprint: preview.fingerprint });
  expect(res.skipped.filter((s) => s.reason === "invalid")).toHaveLength(2);
  expect((await children(page, "env")).map((n) => n.label)).toEqual(envBefore); // the forged env group did not get in
  const kids = await kidsOf(page, res.group.id);
  expect(kids.map((n) => n.label)).toContain("Malicious");
  // the grant is a user write: audited
  const audit = await call<{ operation: string }[]>(page, "audit.list", {});
  expect(audit.map((a) => a.operation)).toContain("network.grant");
});

test("import dialog shows the hosts that will be granted and the secret names (round5-review #2)", async ({ page }) => {
  await openKernel(page, host);
  await settingsMenu(page).click();
  await page.getByRole("menuitem", { name: "Import…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill(fixture("malicious"));
  await dialog.getByRole("button", { name: "Look inside" }).click();
  await expect(dialog).toContainText("evil.example.test:8080");
  await expect(dialog).toContainText("victim-token");
});

test("the workspace configuration is never imported", async ({ page }) => {
  await openKernel(page, host);
  const cfg = await cfgNode(page);
  await call(page, "params.set", { node: cfg, name: "network.allow", value: "example.com" });
  const out = path.join(work, "export-with-config");
  await call(page, "workspace.export", { folder: out });
  expect(readJson<{ kind: string }[]>(out, "resources.json").some((r) => r.kind === "core:config")).toBe(true);
  await call(page, "params.set", { node: cfg, name: "network.allow", value: "another.example.org" });
  const preview = await call<Preview>(page, "workspace.importPreview", { folder: out });
  expect(preview.skipped.some((s) => s.reason === "config")).toBe(true);
  await call(page, "workspace.import", { folder: out, fingerprint: preview.fingerprint });
  const resolved = await call<{ params?: Record<string, unknown> }>(page, "resource.get", { id: cfg });
  expect(JSON.stringify(resolved)).toContain("another.example.org");
  expect(JSON.stringify(resolved)).not.toContain("example.com\"");
  await call(page, "params.unset", { node: cfg, name: "network.allow" });
});

/* ------------------------------------------------------------------ known parameters */

test("the configuration page adds a parameter by typing its name and value under the parameters, no dialog (D470)", async ({ page }) => {
  await openKernel(page, host);
  const known = await call<{ name: string; layers: string[] }[]>(page, "params.known");
  expect(known.map((k) => k.name).sort()).toEqual(["mcp.allow_free_query", "mcp.allow_proposals", "mcp.enabled", "mcp.env", "mcp.max_rows", "mcp.rate_per_minute", "network.allow", "process.allow", "protection.no_export", "protection.readonly", "ui.language"]); // round 19 added the five mcp.* policy parameters
  expect(known.find((k) => k.name === "ui.language")!.layers).toEqual(["config"]);
  expect(known.find((k) => k.name === "protection.readonly")!.layers.sort()).toEqual(["config", "env"]);

  await showTree(page, "Settings");
  await treeItem(page, "Workspace").click();
  await expect(page.getByRole("button", { name: "Add parameter" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "New parameter" }).fill("protection.no_export");
  await page.getByRole("textbox", { name: "Value", exact: true }).fill("true");
  await shot(page, "add-param");
  await page.getByRole("textbox", { name: "Value", exact: true }).press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const cfg = await cfgNode(page);
  await expect.poll(async () => JSON.stringify(await call(page, "resource.get", { id: cfg }))).toContain("protection.no_export");

  // no_export is now on: it shows on the page and the export is refused; take it off again afterwards
  const err = await refused(page, "workspace.export", { folder: path.join(work, "blocked") });
  expect(err).toMatchObject({ code: "denied", params: { reason: "noExport" } });
  await call(page, "params.unset", { node: cfg, name: "protection.no_export" });
});

/* ------------------------------------------------------------------ read-only */

test("read-only (workspace configuration): writes and runs are refused with reason readonly; secrets and parameters still work", async ({ page }) => {
  await openKernel(page, host);
  const keep = await newNote(page, "Readonly keep", "before");
  const doomed = await newNote(page, "Readonly doomed", "before");
  const cfg = await cfgNode(page);
  await call(page, "params.set", { node: cfg, name: "protection.readonly", value: "true" });
  try {
    const layerIs = (e: Err) => expect(e.params?.layer).toBe(cfg);
    for (const [method, params] of [
      ["page.save", { target: `resource:${keep}`, changes: { "body.text": "after" } }],
      ["page.save", { target: `new:${NOTE}`, changes: { name: "Never", "body.text": "x" } }],
      ["resource.delete", { id: doomed }],
      ["tree.rename", { tree: "resources", key: keep, name: "Renamed" }],
      ["tree.createGroup", { tree: "resources", name: "Nope" }],
      ["tree.move", { tree: "resources", key: keep, position: "inside" }],
      ["run.start", { action: "run", target: `new:${SAMPLE}`, tabId: "x", input: { "body.text": "select 1" }, params: {} }],
      ["workspace.import", { folder: fixture("sample"), fingerprint: (await call<Preview>(page, "workspace.importPreview", { folder: fixture("sample") })).fingerprint }],
    ] as [string, unknown][]) {
      const e = await refused(page, method, params);
      expect(e, method).toMatchObject({ code: "denied", params: { reason: "readonly" } });
      layerIs(e);
    }
    expect((await get(page, keep)).body.text).toBe("before");
    expect((await get(page, keep)).name).toBe("Readonly keep");
    expect((await get(page, doomed)).name).toBe("Readonly doomed");

    // not refused: secrets, the parameters themselves (otherwise it could not be turned off), UI state, reads, export
    await call(page, "secrets.set", { name: "ro-secret", value: "ro-value-1" });
    await call(page, "secrets.delete", { name: "ro-secret" });
    const env = await envNode(page);
    await call(page, "params.set", { node: env, name: "ro.test", value: "1" });
    await call(page, "params.unset", { node: env, name: "ro.test" });
    await call(page, "resource.setFavorite", { id: keep, favorite: true }).catch((e) => {
      throw e;
    });
    await call(page, "workspace.export", { folder: path.join(work, "export-readonly-ok") });
    const resolved = await call<{ restrictions?: string[] }>(page, "page.resolve", { target: `resource:${keep}` });
    expect(resolved.restrictions).toContain("readonly");

    // the UI shows it and disables saving
    await showTree(page, "Resources");
    await treeItem(page, "Readonly keep").click();
    await expect(page.getByText(/Read-only protection is on/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await shot(page, "readonly");
  } finally {
    await call(page, "params.unset", { node: cfg, name: "protection.readonly" });
  }
  await call(page, "page.save", { target: `resource:${keep}`, changes: { "body.text": "after" } }); // works again
  expect((await get(page, keep)).body.text).toBe("after");
});

test("read-only on an environment only affects saves and runs of tabs that use that environment", async ({ page }) => {
  await openKernel(page, host);
  const note = await newNote(page, "Env scoped", "v1");
  const env = await envNode(page);
  await call(page, "params.set", { node: env, name: "protection.readonly", value: "true" });
  try {
    const e = await refused(page, "page.save", { target: `resource:${note}`, changes: { "body.text": "v2" }, context: { envId: env } });
    expect(e).toMatchObject({ code: "denied", params: { reason: "readonly", layer: env } });
    const run = await refused(page, "run.start", { action: "run", resourceId: note, target: `resource:${note}`, tabId: "x", envId: env, input: { "body.text": "select 1" }, params: {} }).catch(() => null);
    void run; // (a note has no run action; the sample query below covers runs)
    const q = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${SAMPLE}`, changes: { name: "Env query", "body.text": "select 1" } })).page.resourceId;
    expect(await refused(page, "run.start", { action: "run", resourceId: q, target: `resource:${q}`, tabId: "x", envId: env, input: { "body.text": "select 1" }, params: {} })).toMatchObject({ code: "denied", params: { reason: "readonly" } });
    // without the environment: saving and running are fine, the tree operations too
    await call(page, "page.save", { target: `resource:${note}`, changes: { "body.text": "v2" } });
    expect((await get(page, note)).body.text).toBe("v2");
    const runId = await call<string>(page, "run.start", { action: "run", resourceId: q, target: `resource:${q}`, tabId: "y", input: { "body.text": "select 1" }, params: {} });
    await expect.poll(async () => (await call<{ status: string }>(page, "run.get", { id: runId })).status).toBe("success");
    await call(page, "tree.rename", { tree: "resources", key: note, name: "Env scoped renamed" });
  } finally {
    await call(page, "params.unset", { node: env, name: "protection.readonly" });
  }
});

/* ------------------------------------------------------------------ CSV and no_export */

async function finishedQueryRun(page: Page, name: string) {
  const q = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${SAMPLE}`, changes: { name, "body.text": "select * from orders" } })).page.resourceId;
  const runId = await call<string>(page, "run.start", { action: "run", resourceId: q, target: `resource:${q}`, tabId: "csv", input: { "body.text": "select * from orders" }, params: {} });
  await expect.poll(async () => (await call<{ status: string }>(page, "run.get", { id: runId })).status).toBe("success");
  return { q, runId };
}

test("CSV export: BOM, CRLF, header row, rows as returned; an existing file or a relative path is refused", async ({ page }) => {
  await openKernel(page, host);
  const { runId } = await finishedQueryRun(page, "CSV source");
  const file = path.join(work, "result.csv");
  const res = await call<{ path: string; rows: number }>(page, "run.export", { run: runId, path: file, format: "csv" });
  expect(res.path).toBe(file);
  const bytes = readFileSync(file);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
  const text = bytes.subarray(3).toString("utf8");
  const lines = text.split("\r\n");
  expect(lines.at(-1)).toBe(""); // every line, the last one too, ends in CRLF
  expect(lines.length - 1).toBe(res.rows + 1);
  expect(lines[0]).toContain("customer");
  expect(lines[1]!.split(",").length).toBe(lines[0]!.split(",").length);
  expect((await call<{ operation: string }[]>(page, "audit.list", {})).map((a) => a.operation)).toContain("run.export");

  expect((await refused(page, "run.export", { run: runId, path: file, format: "csv" })).params?.reason).toBe("exists");
  expect((await refused(page, "run.export", { run: runId, path: "result.csv", format: "csv" })).params?.reason).toBe("notAbsolute");
  expect((await refused(page, "run.export", { run: runId, path: path.join(work, "x.json"), format: "json" })).params?.reason).toBe("badFormat");
  expect((await refused(page, "run.export", { run: runId, path: path.join(dataDir, "inside.csv"), format: "csv" })).params?.reason).toBe("insideDataDir");
  expect(existsSync(path.join(dataDir, "inside.csv"))).toBe(false);
});

test("CSV export from the result area writes the file (browser path dialog)", async ({ page }) => {
  const q = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${SAMPLE}`, changes: { name: "CSV via UI", "body.text": "select * from orders" } })).page.resourceId;
  void q;
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, "CSV via UI").click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("table", { name: "Result" }).locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });
  const file = path.join(work, "from-ui.csv");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "File path" }).fill(file);
  await shot(page, "export-csv-dialog");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect.poll(() => existsSync(file)).toBe(true);
  expect([...readFileSync(file).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
});

test("a run that is not a table cannot be exported as CSV", async ({ page }) => {
  await openKernel(page, host);
  const ping = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${HTTP}`, changes: { name: "Not a table", "body.method": "GET", "body.url": "http://127.0.0.1:9/none", "body.headers": "", "body.body": "" } })).page.resourceId;
  const runId = await call<string>(page, "run.start", { action: "send", resourceId: ping, target: `resource:${ping}`, tabId: "nt", input: {}, params: {} }).catch(() => null);
  test.skip(!runId, "could not start the HTTP action here");
  await expect.poll(async () => (await call<{ status: string }>(page, "run.get", { id: runId! })).status).not.toBe("running");
  const e = await refused(page, "run.export", { run: runId!, path: path.join(work, "nt.csv"), format: "csv" });
  expect(e.code).toBe("invalid");
  expect(["notTable", "notFinished", "noOutput"]).toContain(e.params?.reason);
  expect(existsSync(path.join(work, "nt.csv"))).toBe(false);
});

test("no_export: workspace and result exports are refused, the page says so, the CSV button is disabled; read and run still work", async ({ page }) => {
  await openKernel(page, host);
  const { q, runId } = await finishedQueryRun(page, "Protected result");
  const cfg = await cfgNode(page);
  await call(page, "params.set", { node: cfg, name: "protection.no_export", value: "true" });
  try {
    for (const [method, params] of [
      ["workspace.export", { folder: path.join(work, "no-export") }],
      ["run.export", { run: runId, path: path.join(work, "no-export.csv"), format: "csv" }],
    ] as [string, unknown][]) {
      const e = await refused(page, method, params);
      expect(e, method).toMatchObject({ code: "denied", params: { reason: "noExport", layer: cfg } });
    }
    expect(existsSync(path.join(work, "no-export"))).toBe(false);
    expect(existsSync(path.join(work, "no-export.csv"))).toBe(false);
    expect((await call<{ restrictions?: string[] }>(page, "page.resolve", { target: `resource:${q}` })).restrictions).toContain("noExport");
    // reading and saving are not restricted by no_export
    await call(page, "page.save", { target: `resource:${q}`, changes: { "body.text": "select 2" } });

    await showTree(page, "Resources");
    await treeItem(page, "Protected result").click();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByRole("table", { name: "Result" }).locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Export protection is on|Export CSV/ }).first()).toBeDisabled();
    await shot(page, "no-export");
  } finally {
    await call(page, "params.unset", { node: cfg, name: "protection.no_export" });
  }
  await call(page, "workspace.export", { folder: path.join(work, "export-after-no-export") }); // allowed again
});
