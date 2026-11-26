/**
 * D487 §23 (docs/redesign/book.md) against the REAL kernel and the real document, formula and book plugins: a template
 * with fill-in items; from New, a document written from it in the ward's environment, filled in place, BMI computed;
 * signing checks what is required and asks about values out of range; once signed it is read only and shows what it
 * showed then (the formula and the environment change); a second level; revised with a reason; a patient's file (a
 * book) with a series of progress notes in order; another note refers to a signed value.
 * Screenshots (not checked in): test-results/screenshots/document-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-document-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const D = "org.onedesk.document";
type Node = { key: string; label: string };
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `document-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });
const roots = async (page: Page) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources" })).nodes;
const kids = async (page: Page, parent: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent })).nodes;

async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes });
  return r.page.resourceId;
}

const ADMISSION = [
  "# Admission",
  "Patient {{Name}}",
  "Temperature {{?Temp | number, ℃, 35~42, required}}",
  "## Complaint",
  "{{?Complaint | longtext, required}}",
  "Weight {{?Weight | number, kg, default={{Weight}}}} Height {{?Height | number, m}} BMI [[=BMI | W=@Weight, H=@Height]]",
].join("\n");

let env = "";
let doc = "";
let formula = "";

test("from New: a document written from a template, filled in place, BMI computed as it is typed", async ({ page }) => {
  await openKernel(page, host);
  env = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  for (const [name, value] of [["Name", "Zhang San"], ["Weight", "70"], ["Signer", "Dr Wang"]]) await call(page, "params.set", { node: env, name, value });
  formula = await make(page, "org.onedesk.formula:formula", null, { name: "BMI", "body.text": "BMI = W / (H * H)", "body.decimals": 1 });
  await make(page, `${D}:template`, null, { name: "Admission template", "body.text": ADMISSION, "body.levels": "Written / Reviewed" });

  await page.reload();
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Document", exact: true }).click();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText("Not saved yet")).toBeVisible();
  await info.getByRole("textbox", { name: "Name" }).fill("Zhang San admission");
  await page.getByRole("combobox", { name: "Template" }).click();
  await page.getByRole("option", { name: "Admission template" }).click();
  // The form shows before it is saved: the environment's values in, the default weight from it.
  await expect(page.getByText("Patient Zhang San")).toBeVisible({ timeout: 15_000 });
  await info.getByRole("textbox", { name: "Name" }).click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "Zhang San admission" })).toBeVisible();
  doc = (await roots(page)).find((n) => n.label === "Zhang San admission")!.key;
  await expect.poll(async () => (await call<{ body: Record<string, string> }>(page, "resource.get", { id: doc })).body.text, { timeout: 15_000 }).toBe(ADMISSION);

  await page.getByRole("textbox", { name: "Height" }).fill("1.75");
  await expect(page.getByText("22.9")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "Temp" }).fill("45");
  await expect(page.getByText("outside 35~42")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("ControlOrMeta+s");
  await shot(page, "fill");
});

test("signing: required first, out of range confirmed; then fixed and read only, as it was", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("treeitem", { name: "Zhang San admission", exact: true }).click();
  await action(page, "Sign").click();
  await expect(page.getByText("Not filled yet (required): Complaint").first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "Complaint" }).fill("Chest pain for two hours");
  await action(page, "Sign").click();
  await expect(page.getByText("Save it first (⌘S): a document is signed as it is saved.").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("Saved").first()).toBeVisible({ timeout: 15_000 });
  await action(page, "Sign").click();
  await expect(page.getByText(/Outside the range: Temp 45 ℃/).first()).toBeVisible({ timeout: 15_000 });
  await action(page, "Sign").click();
  await expect(page.getByText("Written: Dr Wang　waiting for: Reviewed")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("BMI 22.9")).toBeVisible({ timeout: 15_000 });
  await shot(page, "signed");
  // Read only; changing the formula and the environment changes nothing shown.
  const e = await call(page, "page.save", { target: `resource:${doc}`, changes: { name: "x" } }).catch((x: Error) => x.message);
  expect(String(e)).toContain("stamped");
  await call(page, "page.save", { target: `resource:${formula}`, changes: { "body.text": "BMI = W / H" } });
  await call(page, "params.set", { node: env, name: "Name", value: "Li Si" });
  await page.reload();
  await page.getByRole("treeitem", { name: "Zhang San admission", exact: true }).click();
  await expect(page.getByText("Patient Zhang San")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("BMI 22.9")).toBeVisible();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText(/Written · Dr Wang/)).toBeVisible();
  // The second level.
  await page.getByRole("textbox", { name: "Signer" }).fill("Dr Li");
  await action(page, "Sign").click();
  await expect(page.getByText("Reviewed: Dr Li")).toBeVisible({ timeout: 15_000 });

  // Revise: a reason first; then back to a draft, live again.
  await action(page, "Revise").click();
  await expect(page.getByText("Write the reason for revising first.").first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "Reason for revising" }).fill("Temperature mistyped");
  await action(page, "Revise").click();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "Temp" })).toBeVisible();
  await expect(info.getByText(/Revised · Temperature mistyped/)).toBeVisible();
  await shot(page, "revised");
  // Signed again (37 now), for what follows.
  await page.getByRole("textbox", { name: "Temp" }).fill("37");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("outside 35~42")).toHaveCount(0, { timeout: 15_000 });
  await action(page, "Sign").click();
  await expect(page.getByText(/Written: Dr Wang/)).toBeVisible({ timeout: 15_000 });
});

test("a patient's file: the document and a series of progress notes in order; a note refers to a signed value", async ({ page }) => {
  await openKernel(page, host);
  const notes = await make(page, `${D}:template`, null, { name: "Progress note", "body.text": "Time {{?Time | text}}\n\n{{?Note | longtext}}" });
  const file = await make(page, "org.onedesk.book:book", null, { name: "Zhang San, stay 2" });
  await call(page, "tree.move", { tree: "resources", key: doc, target: file, position: "inside" });
  const series = await make(page, `${D}:series`, file, { name: "Progress notes", "body.template": notes, "body.order": "Time" });
  const a = await make(page, `${D}:document`, series, { name: "b", "body.template": notes, "body.v.Time": "2026-11-26" });
  const b = await make(page, `${D}:document`, series, { name: "a", "body.template": notes, "body.v.Time": "2026-11-24" });
  await expect.poll(async () => (await kids(page, series)).map((n) => n.key)).toEqual([b, a]);
  // “Add one” writes one from the template, in the series.
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Progress notes", exact: true }).click();
  await action(page, "Add one").click();
  await expect.poll(async () => (await kids(page, series)).length, { timeout: 15_000 }).toBe(3);
  // Read through in the book.
  await page.getByRole("treeitem", { name: "Zhang San, stay 2", exact: true }).click();
  await page.getByRole("button", { name: /reading/ }).click();
  const nav = page.getByRole("navigation", { name: "Contents" });
  await expect(nav.getByRole("button", { name: /Zhang San admission/ })).toBeVisible({ timeout: 15_000 });
  await expect(nav.getByRole("button", { name: /Progress notes/ })).toBeVisible();
  await shot(page, "file");
  // A note quotes the signed weight.
  await make(page, "org.onedesk.note:note", null, { name: "Discharge", "body.text": "Weight on admission: [[=Zhang San admission | 项=Weight]]" });
  await page.reload();
  await page.getByRole("treeitem", { name: "Discharge", exact: true }).click();
  await page.locator(".od-titlebar__actions").getByRole("button", { name: "Read / Edit" }).click();
  await expect(page.getByText("70 kg")).toBeVisible({ timeout: 15_000 });
});
