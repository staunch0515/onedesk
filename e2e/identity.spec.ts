/**
 * D487 §33 (docs/redesign/book.md, K18) against the REAL kernel, two workspaces (two devhosts): A makes the identity
 * “Teacher Zhang” under Settings → My identity and exports its card; B makes its own, imports A's card into the
 * contacts and marks the fingerprint checked. A signs a document: the info panel says the signature is valid, by A.
 * A publishes a book: B's import dialog says who signed it and that the identity was checked; a package changed after
 * it was signed is refused. (A forged update signed by another key is refused too: crates/kernel/tests/packages.rs.)
 * Screenshots (not checked in): test-results/screenshots/identity-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

let a: Host;
let b: Host;
let base: string;
let out: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-identity-")));
  a = await startHost(path.join(base, "a"));
  b = await startHost(path.join(base, "b"));
  out = path.join(base, "out");
  mkdirSync(out, { recursive: true });
});
test.afterAll(async () => {
  if (a) await stopHost(a);
  if (b) await stopHost(b);
  if (base) rmSync(base, { recursive: true, force: true });
});

const B = "org.onedesk.book";
const D = "org.onedesk.document";
type Node = { key: string; label: string };
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `identity-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });
async function make(page: Page, h: Host, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  return (await rpc<{ page: { resourceId: string } }>(page, h, "page.save", { target, changes })).page.resourceId;
}
const kids = async (page: Page, h: Host, parent: string) => (await rpc<{ nodes: Node[] }>(page, h, "tree.children", { tree: "resources", parent })).nodes;
async function settings(page: Page, item: string) {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("menuitem", { name: item }).click();
}

let fingerprint = "";
const card = () => path.join(out, "zhang.odid");

test("A makes its identity and gives its card; B imports it and checks the fingerprint", async ({ page }) => {
  await openKernel(page, a);
  await settings(page, "My identity");
  const mine = page.locator(".od-section", { hasText: "You have no identity yet" });
  await mine.getByRole("textbox", { name: "Name" }).fill("Teacher Zhang");
  await mine.getByRole("textbox", { name: "Organisation" }).fill("No. 1 School");
  await page.getByRole("button", { name: "Make my identity" }).click();
  await expect(page.getByText("Your identity")).toBeVisible({ timeout: 15_000 });
  fingerprint = (await rpc<{ fingerprint: string }>(page, a, "identity.get", {})).fingerprint;
  await expect(page.getByText(fingerprint)).toBeVisible();
  await shot(page, "mine");
  // The card: written where the user says (here typed: the browser has no save dialog).
  await page.getByRole("button", { name: "Export identity card" }).click();
  await page.getByRole("textbox", { name: "File path" }).fill(card());
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect.poll(() => existsSync(card()), { timeout: 15_000 }).toBe(true);
  expect(JSON.parse(readFileSync(card(), "utf8"))).toMatchObject({ name: "Teacher Zhang", org: "No. 1 School", fingerprint });

  await openKernel(page, b);
  await rpc(page, b, "identity.create", { name: "Li Ming" });
  await settings(page, "My identity");
  await page.getByRole("button", { name: "Import an identity card" }).click();
  await page.getByRole("textbox", { name: "File path" }).fill(card());
  await page.getByRole("button", { name: "Use", exact: true }).click();
  // The contact opens: the fingerprint to compare, not checked yet.
  await expect(page.getByText(fingerprint)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Not checked").first()).toBeVisible();
  await page.getByRole("switch", { name: "I have checked this fingerprint" }).click();
  await expect(page.getByRole("dialog")).toContainText(fingerprint);
  await page.getByRole("button", { name: "Yes, it is the same" }).click();
  await expect(page.getByText("Checked", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "contact");
  const contacts = await rpc<{ nodes: Node[] }>(page, b, "tree.children", { tree: "contacts" });
  expect(contacts.nodes.map((n) => n.label)).toEqual(["Teacher Zhang"]);
});

test("A signs a document: the signature is valid and A's", async ({ page }) => {
  await openKernel(page, a);
  const env = (await rpc<{ nodes: Node[] }>(page, a, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await rpc(page, a, "params.set", { node: env, name: "Signer", value: "Zhang" });
  const tpl = await make(page, a, `${D}:template`, null, { name: "Note template", "body.text": "Note {{?Note | text}}" });
  await make(page, a, `${D}:document`, null, { name: "Signed note", "body.template": tpl, "body.v.Note": "All well" });
  await page.reload();
  await page.getByRole("treeitem", { name: "Signed note", exact: true }).click();
  await action(page, "Sign").click();
  await expect(page.getByText("Signature valid").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Signed by you \(Teacher Zhang\)/).first()).toBeVisible();
  await shot(page, "signed");
});

test("A publishes; B sees who signed it; a changed package is refused", async ({ page }) => {
  await openKernel(page, a);
  await rpc(page, a, "plugin.grantFolder", { plugin: B, path: out });
  const book = await make(page, a, `${B}:book`, null, { name: "Field notes" });
  await expect.poll(async () => (await kids(page, a, book)).length).toBe(2);
  await make(page, a, `${B}:page`, book, { name: "Birds", "body.text": "Birds fly." });
  await make(page, a, `${B}:colophon`, book, { name: "Colophon", "body.publisher": "Zhang" });
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Colophon", exact: true }).click();
  await action(page, "Publish new edition").click();
  const student = path.join(out, "Field notes-1.1-student.odpack");
  await expect.poll(() => readdirSync(out).filter((f) => f.endsWith(".odpack")).length, { timeout: 30_000 }).toBe(2);

  await openKernel(page, b);
  await settings(page, "Import resource package…");
  await page.getByRole("textbox", { name: "Package file" }).fill(student);
  await page.getByRole("button", { name: "Look inside" }).click();
  await expect(page.getByText("Signed by Teacher Zhang (checked)")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(fingerprint)).toBeVisible();
  await shot(page, "package");
  await page.getByRole("button", { name: "Cancel" }).click();

  // The same file with one word changed (the stored zip keeps package.json as it is; its CRC is fixed up).
  const bytes = readFileSync(student);
  const s = bytes.toString("latin1");
  const i = s.indexOf("Birds fly.");
  expect(i).toBeGreaterThan(0);
  const changed = Buffer.from(s.slice(0, i) + "Birds run." + s.slice(i + "Birds fly.".length), "latin1");
  const forged = path.join(out, "forged.odpack");
  writeFileSync(forged, fixCrc(changed));
  await settings(page, "Import resource package…");
  await page.getByRole("textbox", { name: "Package file" }).fill(forged);
  await page.getByRole("button", { name: "Look inside" }).click();
  await expect(page.getByText("The package was changed after it was signed. It cannot be imported.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

/** Recomputes the CRC-32 of each stored entry (local header and central directory) after its bytes were edited in place. */
function fixCrc(buf: Buffer): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const crcs = new Map<string, number>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const data = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    const c = crc(data);
    buf.writeUInt32LE(c, p + 14);
    crcs.set(name, c);
    p += 30 + nameLen + extra + size;
  }
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (crcs.has(name)) buf.writeUInt32LE(crcs.get(name)!, p + 16);
    p += 46 + nameLen + extra + comment;
  }
  return buf;
}
