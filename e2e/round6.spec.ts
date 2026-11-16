/**
 * Round 6 against the REAL kernel: external programs (the example "command" plugin), event subscriptions, and the
 * small items (failed automatic upgrade, purge count, reference field labels).
 * devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data directory (see kernel-host.ts): the real
 * keychain and ~/Library/Application Support/onedesk* are never touched. Programs: only /bin/echo, /bin/sh,
 * /bin/sleep, the packaged hello.sh. Every sleep uses a marker number (777x) so leftovers can be found with pgrep.
 * Assertions use error codes/reasons and protocol results; the few UI checks use English labels (locale en-US).
 * Screenshots: docs/screenshots/round6-*.png.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

const FIXTURES = path.join(ROOT, "e2e/fixtures/plugins");
const CMD_DIR = path.join(FIXTURES, "com.example.command/0.1.0");
const CMD = "com.example.command:command";
const CMD_ID = "com.example.command";
const SAMPLE = "org.onedesk.sample:query";
const NOTE = "org.onedesk.note:note";
const SECRET_VALUE = "s3cr3t-value-77x";

let host: Host;
let base: string;
let dataDir: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round6-")));
  dataDir = path.join(base, "data");
  host = await startHost(dataDir);
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  stray(true); // no test may leave a program behind
  if (base) rmSync(base, { recursive: true, force: true });
});

/** Marker sleeps (`sleep 777x`) still alive; with `kill` they are ended and the call returns what it found. */
function stray(kill = false): string[] {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-f", "^sleep 777[0-9]$"], { encoding: "utf8" });
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
  const pids = out.split("\n").filter(Boolean);
  if (kill) for (const p of pids) try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ }
  return pids;
}

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round6-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Err = { code: string; params?: Record<string, string>; detail?: string };
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
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });

type Node = { key: string; label: string };
const children = async (page: Page, tree: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree })).nodes;
const idOf = async (page: Page, tree: string, label: string) => (await children(page, tree)).find((n) => n.label === label)!.key;
const cfgNode = (page: Page) => idOf(page, "config", "Workspace");
const envNode = (page: Page) => idOf(page, "env", "Default");

type RunInfo = {
  id: string;
  status: string;
  progress?: { message?: string };
  summary?: { message?: string };
  error?: { code: string; reason?: string; message: string };
  output?: { type: string; text?: string };
};
type CmdSpec = { program: string; args?: string[]; env?: string[] };

async function newCmd(page: Page, name: string, spec: CmdSpec): Promise<string> {
  const changes = { name, "body.program": spec.program, "body.args": (spec.args ?? []).join("\n"), "body.env": (spec.env ?? []).join("\n") };
  return (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${CMD}`, changes })).page.resourceId;
}
/** Starts an action with the page's values in `input` (without them the action gets empty values). */
async function start(page: Page, id: string, spec: CmdSpec, action = "run", envId?: string): Promise<string> {
  const input = { "body.program": spec.program, "body.args": (spec.args ?? []).join("\n"), "body.env": (spec.env ?? []).join("\n") };
  return call<string>(page, "run.start", { action, resourceId: id, target: `resource:${id}`, tabId: "t", ...(envId ? { envId } : {}), input, params: {} });
}
const getRun = (page: Page, id: string) => call<RunInfo>(page, "run.get", { id });
async function finished(page: Page, runId: string): Promise<RunInfo> {
  await expect.poll(async () => (await getRun(page, runId)).status, { timeout: 20_000 }).not.toBe("running");
  return getRun(page, runId);
}
async function runOnce(page: Page, spec: CmdSpec, name = "cmd") {
  const id = await newCmd(page, name, spec);
  return { id, run: await finished(page, await start(page, id, spec)) };
}

/** Install through the protocol, as the dialog does: inspect, then install what was shown. */
type Preview = { valid: boolean; problem?: unknown; id: string; version: string; fingerprint: string; permissions: { id: string; detail: string }[]; addedPermissions: string[] };
async function installPkg(page: Page, folder: string) {
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder });
  await call(page, "app.installPlugin", { folder, id: preview.id, version: preview.version, fingerprint: preview.fingerprint });
  return preview;
}
type VersionRow = { version: string; active: boolean; confirmed?: boolean };
const versions = async (page: Page, plugin: string) => (await call<{ versions: VersionRow[] }>(page, "plugin.get", { plugin })).versions;
const activeVersion = async (page: Page, plugin: string) => (await versions(page, plugin)).find((v) => v.active)?.version;

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

/* ------------------------------------------------------------------ install */

test("install: bad-programs is refused; the dialog of the command plugin has its own programs section", async ({ page }) => {
  await openKernel(page, host);
  const bad = await call<Preview>(page, "app.inspectPlugin", { folder: path.join(FIXTURES, "bad-programs") });
  expect(bad.valid).toBe(false);
  expect(JSON.stringify(bad.problem)).toContain("badPrograms");
  await refused(page, "app.installPlugin", { folder: path.join(FIXTURES, "bad-programs"), id: bad.id, version: bad.version, fingerprint: bad.fingerprint });

  await showTree(page, "Plugins");
  await page.getByRole("button", { name: "Install a plugin…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(CMD_DIR);
  await page.getByRole("button", { name: "Look inside" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("It runs external programs");
  for (const name of ["echo", "sleep", "sh", "hello"]) await expect(dialog).toContainText(name);
  await expect(dialog).toContainText("from the plugin"); // hello is the packaged one
  await shot(page, "install-programs");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => activeVersion(page, CMD_ID)).toBe("0.1.0");
  const perm = (await call<{ permissions: { id: string; detail: string; granted: boolean }[] }>(page, "plugin.get", { plugin: CMD_ID })).permissions.find((p) => p.id === "programs")!;
  expect(perm.granted).toBe(true);
  expect(perm.detail).toContain("hello (plugin)");
});

/* ------------------------------------------------------------------ running programs */

test("run echo: no shell (; and $() arrive as written), exit 0, output and summary", async ({ page }) => {
  await openKernel(page, host);
  const { run } = await runOnce(page, { program: "echo", args: ["a;b", "$(echo hi)", "`x`", "*"] }, "Echo");
  expect(run.status).toBe("success");
  expect(run.output).toMatchObject({ type: "text", text: "a;b $(echo hi) `x` *\n" });
  expect(run.summary?.message).toMatch(/^exit 0 · \d+ ms$/);
});

test("run hello with a secret in the environment: the value is ***, in no run, no file", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "secrets.set", { name: "cmd-secret", value: SECRET_VALUE });
  const spec = { program: "hello", args: ["world"], env: ["GREETING={{secret:cmd-secret}}"] };
  const { id, run } = await runOnce(page, spec, "Hello");
  expect(run.status).toBe("success");
  expect(run.output!.text).toBe("hello world\nGREETING=***\n");
  expect(JSON.stringify(await getRun(page, run.id))).not.toContain(SECRET_VALUE);
  expect(JSON.stringify(await call(page, "run.listFor", { resourceId: id }).catch(() => null))).not.toContain(SECRET_VALUE);
  expect(JSON.stringify(await call(page, "audit.list", {}))).not.toContain(SECRET_VALUE);
  expect(filesContaining(dataDir, SECRET_VALUE)).toEqual([]);

  // a secret name that is only in the unsaved draft is refused (D318: names come from the saved resource)
  await call(page, "secrets.set", { name: "draft-only", value: "draft-only-value-91c2" });
  const run2 = await finished(page, await start(page, id, { program: "hello", env: ["GREETING={{secret:draft-only}}"] }));
  expect(run2.status).toBe("error");
  expect(run2.error).toMatchObject({ code: "denied", reason: "secretNotAllowed" });
  await call(page, "secrets.delete", { name: "draft-only" });
});

test("a non-zero exit code is still a successful run; stderr follows stdout, marked", async ({ page }) => {
  await openKernel(page, host);
  const { run } = await runOnce(page, { program: "sh", args: ["-c", "echo out; echo err >&2; exit 3"] }, "Exit three");
  expect(run.status).toBe("success");
  expect(run.summary?.message).toMatch(/^exit 3 · \d+ ms$/);
  expect(run.output!.text).toBe("out\n--- stderr ---\nerr\n");
});

test("output streams while the program runs: the first lines are there before it ends", async ({ page }) => {
  await openKernel(page, host);
  const spec = { program: "sh", args: ["-c", "echo first; echo second; sleep 3; echo last"] };
  const id = await newCmd(page, "Streaming", spec);
  const runId = await start(page, id, spec);
  await expect.poll(async () => (await getRun(page, runId)).progress?.message ?? "", { timeout: 2_500 }).toContain("second");
  expect((await getRun(page, runId)).status).toBe("running");
  const done = await finished(page, runId);
  expect(done.output!.text).toBe("first\nsecond\nlast\n");
});

test("cancel ends the program and its child and grandchild", async ({ page }) => {
  await openKernel(page, host);
  const spec = { program: "sh", args: ["-c", "sleep 7771 & sleep 7772 & wait"] };
  const id = await newCmd(page, "Cancel me", spec);
  const runId = await start(page, id, spec);
  await expect.poll(() => stray().length, { timeout: 10_000 }).toBe(2);
  await call(page, "run.cancel", { id: runId });
  await expect.poll(() => stray().length, { timeout: 10_000 }).toBe(0);
  expect((await finished(page, runId)).status).toBe("cancelled");
});

test("an action that does not wait for process.run leaves nothing behind when the run ends", async ({ page }) => {
  await openKernel(page, host);
  const spec = { program: "sleep", args: ["7773"] };
  const id = await newCmd(page, "Fire", spec);
  const run = await finished(page, await start(page, id, spec, "fire"));
  expect(run.status).toBe("success");
  await expect.poll(() => stray().length, { timeout: 10_000 }).toBe(0);
});

test("refused: an undeclared program, a library-injecting variable name", async ({ page }) => {
  await openKernel(page, host);
  const undeclared = (await runOnce(page, { program: "cat" }, "Undeclared")).run;
  expect(undeclared.status).toBe("error");
  expect(undeclared.error).toMatchObject({ code: "denied", reason: "undeclaredProgram" });
  const dyld = (await runOnce(page, { program: "echo", env: ["DYLD_INSERT_LIBRARIES=/tmp/x.dylib"] }, "Dyld")).run;
  expect(dyld.status).toBe("error");
  expect(dyld.error).toMatchObject({ code: "invalid", reason: "badEnv" });
  const audit = JSON.stringify(await call(page, "audit.list", {}));
  expect(audit).toContain("process.run");
});

/* ------------------------------------------------------------------ policy process.allow */

test("process.allow: names outside the list are refused, an empty list refuses everything, the environment layer only touches tabs with that environment", async ({ page }) => {
  await openKernel(page, host);
  const cfg = await cfgNode(page);
  const env = await envNode(page);
  const known = await call<{ name: string; layers: string[] }[]>(page, "params.known");
  expect(known.find((k) => k.name === "process.allow")!.layers.sort()).toEqual(["config", "env"]);
  const id = await newCmd(page, "Policy", { program: "echo", args: ["ok"] });
  const echo = { program: "echo", args: ["ok"] };
  const sh = { program: "sh", args: ["-c", "echo sh"] };

  await call(page, "params.set", { node: cfg, name: "process.allow", value: "echo" });
  try {
    expect((await finished(page, await start(page, id, echo))).status).toBe("success");
    const blocked = await finished(page, await start(page, id, sh));
    expect(blocked.error).toMatchObject({ code: "denied", reason: "blockedByPolicy" });
  } finally {
    await call(page, "params.unset", { node: cfg, name: "process.allow" });
  }
  expect((await finished(page, await start(page, id, sh))).status).toBe("success"); // no list = no extra limit

  // an empty list forbids everything
  await call(page, "params.set", { node: cfg, name: "process.allow", value: "" });
  try {
    const none = await finished(page, await start(page, id, echo));
    expect(none.error).toMatchObject({ code: "denied", reason: "blockedByPolicy" });
  } finally {
    await call(page, "params.unset", { node: cfg, name: "process.allow" });
  }

  // the environment layer: only runs that carry the environment are limited
  await call(page, "params.set", { node: env, name: "process.allow", value: "echo" });
  try {
    const withEnv = await finished(page, await start(page, id, sh, "run", env));
    expect(withEnv.error).toMatchObject({ code: "denied", reason: "blockedByPolicy" });
    expect((await finished(page, await start(page, id, sh))).status).toBe("success");
    expect((await finished(page, await start(page, id, echo, "run", env))).status).toBe("success");
  } finally {
    await call(page, "params.unset", { node: env, name: "process.allow" });
  }
});

/* ------------------------------------------------------------------ events */

test("events: a run in another tab updates 'last run' and a new command updates the count, unsaved input stays", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Resources");
  const id = await newCmd(page, "Watched", { program: "echo", args: ["watch"] });
  await page.reload();
  await showTree(page, "Resources");
  await treeItem(page, "Watched").click();
  await expect(page.getByText(/^Last run: /)).toBeVisible();
  await expect(page.getByText(/^Commands: \d+$/)).toBeVisible();
  const args = page.getByRole("textbox", { name: "Arguments (one per line)" });
  await args.fill("typed but not saved");
  const countBefore = Number((await page.getByText(/^Commands: \d+$/).innerText()).split(": ")[1]);

  // "another tab": a run over the protocol
  const done = await finished(page, await start(page, id, { program: "echo", args: ["watch"] }));
  expect(done.status).toBe("success");
  await expect(page.getByText(/^Last run: success at /)).toBeVisible({ timeout: 15_000 });
  await newCmd(page, "Another one", { program: "echo" });
  await expect(page.getByText(`Commands: ${countBefore + 1}`)).toBeVisible({ timeout: 15_000 });
  await expect(args).toHaveValue("typed but not saved");
  await shot(page, "events-page");
});

/* ------------------------------------------------------------------ upgrade needs a new confirmation */

test("a version with one more program is shown as a new permission; installing it is the new confirmation", async ({ page }) => {
  await openKernel(page, host);
  const folder = path.join(FIXTURES, "com.example.command/0.2.0");
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder });
  expect(preview.valid).toBe(true);
  expect(preview.addedPermissions).toContain("programs");
  expect(preview.permissions.find((p) => p.id === "programs")!.detail).toContain("cat");
  // before: cat is not declared
  const id = await newCmd(page, "Cat later", { program: "cat", args: ["/dev/null"] });
  expect((await finished(page, await start(page, id, { program: "cat", args: ["/dev/null"] }))).error).toMatchObject({ reason: "undeclaredProgram" });

  await showTree(page, "Plugins");
  await page.getByRole("button", { name: "Install a plugin…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Look inside" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("cat");
  await shot(page, "install-more-programs");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => activeVersion(page, CMD_ID)).toBe("0.2.0");
  expect((await versions(page, CMD_ID)).find((v) => v.version === "0.2.0")!.confirmed).toBe(true);
  // a command made now belongs to 0.2.0 (the older one stays with the version that declared its programs)
  const spec = { program: "cat", args: ["/dev/null"] };
  const fresh = await newCmd(page, "Cat now", spec);
  expect((await finished(page, await start(page, fresh, spec))).status).toBe("success");
});

/* ------------------------------------------------------------------ small items */

test("a failed automatic upgrade is shown on the plugin page and in the tree", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "page.save", { target: `new:${SAMPLE}`, changes: { name: "To migrate", "body.text": "select 1" } });
  await installPkg(page, path.join(FIXTURES, "org.onedesk.sample/0.3.0"));
  await expect
    .poll(async () => (await call<{ switchFailure?: { version: string; reason: string } }>(page, "plugin.get", { plugin: "org.onedesk.sample" })).switchFailure?.version, { timeout: 15_000 })
    .toBe("0.3.0");
  await showTree(page, "Plugins");
  await treeItem(page, /^Sample \d/).click();
  await expect(page.getByText(/Switching to 0\.3\.0 failed/)).toBeVisible();
  await shot(page, "switch-failure");
  const nodes = await children(page, "plugins");
  expect(JSON.stringify(nodes.find((n) => n.label.startsWith("Sample")))).toContain("switchFailed");
});

test("a reference shows the label of the field it sits in", async ({ page }) => {
  await openKernel(page, host);
  const target = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${NOTE}`, changes: { name: "Label target", "body.text": "x" } })).page.resourceId;
  await newCmd(page, "Points", { program: "echo", args: ["[[Label target]]"] });
  const refs = await call<{ field: string; fieldLabel?: unknown }[]>(page, "refs.incoming", { id: target });
  expect(refs).toHaveLength(1);
  expect(refs[0]!.field).toBe("body.args");
  expect(JSON.stringify(refs[0]!.fieldLabel)).toContain("Arguments (one per line)");
  await showTree(page, "Resources");
  await treeItem(page, "Label target").click();
  const showInfo = page.getByRole("button", { name: "Show info panel" });
  if (await showInfo.isVisible()) await showInfo.click();
  await expect(page.getByText("Arguments (one per line)").first()).toBeVisible();
  await expect(page.getByText("body.args")).toHaveCount(0);
  await shot(page, "reference-field-label");
});

test("nothing is left running at the end", async () => {
  expect(stray()).toEqual([]);
  void mkdirSync;
});
