/**
 * D487 §17 (docs/redesign/book.md) against the REAL kernel and the real formula, note and book plugins, from New: a
 * formula finds its parameter and is tried out; a note calls it inline and as a worked block, filled from the
 * environment; the results follow changes and a rename; in a book an embedded formula is numbered “Equation (1-1)”
 * and referred to by that number, and a formula placed in the book is a page of its own.
 * Screenshots (not checked in): test-results/screenshots/formula-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(150_000);

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-formula-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const F = "org.onedesk.formula:formula";
const B = "org.onedesk.book";
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const kids = async (page: Page, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent })).nodes;
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `formula-${name}.png`) });
const toggle = (page: Page) => page.locator(".od-titlebar__actions").getByRole("button", { name: "Read / Edit" });

async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes });
  return r.page.resourceId;
}

let formula = "";

test("from New: a formula finds its parameter, is tried out, and is called from a note in the tab's environment", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Formula", exact: true }).click();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText("Not saved yet")).toBeVisible();
  const name = info.getByRole("textbox", { name: "Name" });
  await name.fill("C2F");
  await expect(name).toHaveValue("C2F");
  await page.getByRole("textbox", { name: "Formula", exact: true }).fill("K = C + 273.15\nF = C * 9 / 5 + 32");
  await page.getByRole("textbox", { name: "Result unit" }).fill("°F");
  await page.getByLabel("Decimal places").fill("1");
  // The parameter is found in the formula: its row appears.
  await expect(page.getByText("Parameter C")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "Meaning" }).fill("Celsius");
  await page.getByRole("textbox", { name: "Unit", exact: true }).fill("°C");
  await page.getByRole("textbox", { name: "Default" }).fill("20");
  await expect(page.getByText("F = 68 °F").first()).toBeVisible({ timeout: 15_000 });
  // Trying a value: on this tab only.
  await page.getByRole("textbox", { name: "C", exact: true }).fill("37");
  await expect(page.getByText("F = 98.6 °F").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("K = 310.2").first()).toBeVisible();
  await shot(page, "page");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "C2F" })).toBeVisible();
  formula = (await kids(page)).find((n) => n.label === "C2F")!.key;

  // A note calls it inline and as a block; the environment fills {{room}}.
  const env = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await call(page, "params.set", { node: env, name: "room", value: "25" });
  await make(page, "org.onedesk.note:note", null, { name: "Fever", "body.text": "Body temperature is about [[=C2F | C=37]].\n\n![[C2F | C={{room}}]]\n\nBroken: [[=C2F | C]]." });
  await page.reload();
  await page.getByRole("treeitem", { name: "Fever", exact: true }).click();
  await toggle(page).click();
  await expect(page.getByText("Body temperature is about 98.6 °F.")).toBeVisible({ timeout: 15_000 });
  const block = page.getByRole("figure", { name: "C2F（C=25）" });
  await expect(block).toContainText("C = 25 °C", { timeout: 15_000 });
  await expect(block).toContainText("F = 77 °F");
  await expect(page.getByText("The parameters are written wrongly")).toBeVisible();
  await shot(page, "note");
  // The call is a link to the formula.
  await page.getByRole("link", { name: "98.6 °F" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "C2F" })).toBeVisible();
  // Its info panel says it is called, with what.
  await expect(page.getByRole("complementary", { name: "Info" }).getByText("Call C=37")).toBeVisible({ timeout: 15_000 });

  // Changes show: fewer places; a rename does not break the call.
  await call(page, "page.save", { target: `resource:${formula}`, changes: { "body.decimals": 0, name: "Celsius to Fahrenheit" } });
  await page.reload();
  await page.getByRole("treeitem", { name: "Fever", exact: true }).click();
  await toggle(page).click();
  await expect(page.getByText("Body temperature is about 99 °F.")).toBeVisible({ timeout: 15_000 });
});

test("in a book: an embedded formula is Equation (1-1), referred to by it; a formula in the book is a page", async ({ page }) => {
  await openKernel(page, host);
  const book = await make(page, `${B}:book`, null, { name: "Physics" });
  await expect.poll(async () => (await kids(page, book)).length).toBe(2);
  await make(page, `${B}:page`, book, {
    name: "Heat",
    "body.text": "![[Celsius to Fahrenheit]]\nEquation: Temperature\n\nFrom [[Celsius to Fahrenheit]], 37 °C is [[=Celsius to Fahrenheit | C=37]].",
  });
  await make(page, F, book, { name: "Body mass", "body.text": "BMI = m / h^2", "body.decimals": 1 });
  await make(page, `${B}:figures`, book, { name: "Lists" });
  await page.reload();
  await page.getByRole("treeitem", { name: "Physics", exact: true }).click();
  await page.getByRole("button", { name: "Start reading" }).click();
  const nav = page.getByRole("navigation", { name: "Contents" });
  await expect(nav.getByRole("button", { name: "Chapter 1 Heat" })).toBeVisible({ timeout: 15_000 });
  await expect(nav.getByRole("button", { name: "Chapter 2 Body mass" })).toBeVisible();
  const heat = page.getByRole("region", { name: "Chapter 1 Heat" });
  await expect(heat).toContainText("Equation (1-1) Temperature", { timeout: 15_000 });
  await expect(heat).toContainText("From Equation (1-1), 37 °C is 99 °F.");
  // The calculation page shows the formula and where its parameters come from.
  await nav.getByRole("button", { name: "Chapter 2 Body mass" }).click();
  await expect(page.getByRole("region", { name: "Chapter 2 Body mass" })).toContainText("BMI = m ÷ h²");
  await shot(page, "book");
  // The list of figures has the equations.
  await page.getByRole("treeitem", { name: "Lists", exact: true }).click();
  await expect(page.getByText("Equation (1-1)")).toBeVisible({ timeout: 15_000 });
});
