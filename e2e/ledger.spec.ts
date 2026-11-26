/**
 * D487 §27 (docs/redesign/book.md) against the REAL kernel and the real ledger and book plugins: a stock ledger as a
 * book — setup (moving average), an item with opening stock; a goods receipt filled in its table of lines, audited and
 * posted; an issue; the issue reversed by a red voucher; a stocktake loss; the month closed on the stock summary, after
 * which that month takes no more vouchers; the catalog marks low stock.
 * Screenshots (not checked in): test-results/screenshots/ledger-*.png.
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
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-ledger-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const L = "org.onedesk.ledger";
type Node = { key: string; label: string };
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `ledger-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });
const kids = async (page: Page, parent: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent })).nodes;
const body = async (page: Page, id: string) => (await call<{ body: Record<string, any> }>(page, "resource.get", { id })).body;

async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes });
  return r.page.resourceId;
}

async function open(page: Page, name: string) {
  await page.getByRole("treeitem", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 15_000 });
}

test("a stock ledger: receipt, issue, reversal, stocktake, month-end close", async ({ page }) => {
  await openKernel(page, host);
  const env = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await call(page, "params.set", { node: env, name: "Signer", value: "Wang" });
  const book = await make(page, "org.onedesk.book:book", null, { name: "Materials ledger" });
  await expect.poll(async () => (await kids(page, book)).length).toBe(2);
  const toc = (await kids(page, book)).find((n) => n.label === "Contents")!.key;
  await call(page, "resource.delete", { id: toc });
  await make(page, `${L}:setup`, book, { name: "Setup", "body.method": "moving", "body.started": "2026-11-01" });
  await make(page, `${L}:catalog`, book, { name: "Catalog" });
  const screw = await make(page, `${L}:item`, book, { name: "Screw M6", "body.code": "S-06", "body.unit": "pcs", "body.openQty": 1000, "body.openPrice": 0.1, "body.min": 1495 });
  const reg = await make(page, `${L}:vouchers`, book, { name: "Vouchers" });
  const receipt = await make(page, `${L}:receipt`, reg, { name: "Receipt 1", "body.date": "2026-11-03" });
  await expect.poll(async () => (await body(page, receipt)).no, { timeout: 15_000 }).toBe("RK-202611-001");

  // Fill the receipt's lines in its table.
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await open(page, "Receipt 1");
  await page.getByRole("button", { name: "Add a line" }).click();
  await page.getByRole("combobox", { name: "Item" }).click();
  await page.getByRole("option", { name: "Screw M6" }).click();
  await page.getByRole("textbox", { name: "Quantity" }).fill("500");
  await page.getByRole("textbox", { name: "Unit price" }).fill("0.13");
  await expect(page.getByText("Total: 65.00")).toBeVisible({ timeout: 15_000 });
  await shot(page, "receipt");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await body(page, receipt)).lines, { timeout: 15_000 }).toEqual([expect.objectContaining({ item: screw, qty: 500, price: 0.13 })]);
  await action(page, "Audit").click();
  await expect(page.getByText("Audited by Wang").first()).toBeVisible({ timeout: 15_000 });
  await action(page, "Post").click();
  await expect.poll(async () => (await body(page, screw)).bal, { timeout: 30_000 }).toMatchObject({ qty: 1500, amount: 165 });

  // An issue, then reversed.
  const issue = await make(page, `${L}:issue`, reg, { name: "Issue 1", "body.date": "2026-11-05", "body.lines": [{ item: screw, qty: 600 }] });
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await open(page, "Issue 1");
  await action(page, "Audit").click();
  await expect(page.getByText("Audited by Wang").first()).toBeVisible({ timeout: 15_000 });
  await action(page, "Post").click();
  await expect.poll(async () => (await body(page, screw)).bal, { timeout: 30_000 }).toMatchObject({ qty: 900, amount: 99 });
  await action(page, "Reverse").click();
  await expect(page.getByRole("heading", { level: 1, name: "Reversal of Issue 1" })).toBeVisible({ timeout: 15_000 });
  await action(page, "Audit").click();
  await expect(page.getByText("Audited by Wang").first()).toBeVisible({ timeout: 15_000 });
  await action(page, "Post").click();
  await expect.poll(async () => (await body(page, screw)).bal, { timeout: 30_000 }).toMatchObject({ qty: 1500, amount: 165 });
  const issued = await call<{ stamps: { label: string }[] }>(page, "resource.get", { id: issue });
  expect(issued.stamps.map((s) => s.label)).toContain("Reversed");

  // A stocktake: 10 missing.
  const count = await make(page, `${L}:count`, reg, { name: "Count 1", "body.date": "2026-11-28", "body.lines": [{ item: screw, actual: 1490 }] });
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await open(page, "Count 1");
  await action(page, "Audit").click();
  await expect(page.getByText("Audited by Wang").first()).toBeVisible({ timeout: 15_000 });
  await action(page, "Post").click();
  await expect.poll(async () => (await body(page, screw)).bal, { timeout: 30_000 }).toMatchObject({ qty: 1490, amount: 163.9 });
  void count;

  // The item's ledger.
  await open(page, "Screw M6");
  await expect(page.getByText("On hand: 1490 pcs, worth 163.90")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row", { name: /Stocktake loss/ })).toBeVisible();
  await shot(page, "item");

  // The catalog marks low stock.
  await open(page, "Catalog");
  await expect(page.getByRole("row", { name: /Screw M6/ })).toContainText("Below the lower limit", { timeout: 15_000 });

  // Month-end close.
  const sum = await make(page, `${L}:summary`, book, { name: "November", "body.month": "2026-11" });
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await open(page, "November");
  await expect(page.getByRole("row", { name: /Screw M6 1000 100\.00 500 65\.00/ })).toBeVisible({ timeout: 15_000 });
  await action(page, "Close month").click();
  await expect(page.getByText("2026-11 is closed.").first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "closed");
  expect((await body(page, sum)).month).toBe("2026-11");
  const late = await make(page, `${L}:receipt`, reg, { name: "Late", "body.date": "2026-11-30", "body.lines": [{ item: screw, qty: 1, price: 1 }] });
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await open(page, "Late");
  await action(page, "Audit").click();
  await expect(page.getByText("2026-11 is closed.").first()).toBeVisible({ timeout: 15_000 });
  void late;
});
