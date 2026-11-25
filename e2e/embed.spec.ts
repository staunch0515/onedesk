/**
 * D481 (docs/redesign/embed-book.md §3) against the REAL kernel and the real note plugin, from New: `![[name#section]]`
 * shows the other note's section in place, live (an edit there shows here), across a rename, filled from the tab's
 * environment; the source's info panel says it is embedded; a missing section and a loop say so.
 * Screenshots (not checked in): test-results/screenshots/embed-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-embed-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const roots = async (page: Page) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources" })).nodes;
const treeItem = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const content = (page: Page) => page.getByRole("textbox", { name: "Content", exact: true });
const toggle = (page: Page) => page.locator(".od-titlebar__actions").getByRole("button", { name: "Read / Edit" });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `embed-${name}.png`) });

async function newNote(page: Page, name: string, text: string) {
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Note", exact: true }).click();
  const info = page.getByRole("complementary", { name: "Info" });
  // The new tab's own info panel ("not saved yet"), not the one of the tab before.
  await expect(info.getByText("Not saved yet")).toBeVisible();
  const nameBox = info.getByRole("textbox", { name: "Name" });
  await nameBox.fill(name);
  await expect(nameBox).toHaveValue(name);
  await content(page).fill(text);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

const LAW = "# Labour law\n\n## Article 35\nThirty-five.\n\n## Article 36\nNo more than eight hours a day for {{who}}.\n\n## Article 37\nThirty-seven.";

test("from New: a note embeds a section of another; live, across a rename, in the tab's environment", async ({ page }) => {
  await openKernel(page, host);
  await newNote(page, "Labour law", LAW);
  await newNote(page, "Contract", "Article 2 Working hours\n\n![[Labour law#Article 36]]\n\nSigned.");
  await toggle(page).click();
  const block = page.getByRole("figure", { name: "Labour law › Article 36" });
  await expect(block).toBeVisible();
  await expect(block).toContainText("No more than eight hours a day");
  await expect(block).not.toContainText("Thirty-seven");
  await expect(page.getByText("Signed.")).toBeVisible();
  await shot(page, "section");

  // The environment fills the embedded template.
  const env = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await call(page, "params.set", { node: env, name: "who", value: "drivers" });
  await page.reload();
  await treeItem(page, "Contract").click();
  await toggle(page).click();
  await expect(page.getByRole("figure", { name: "Labour law › Article 36" })).toContainText("eight hours a day for drivers", { timeout: 15_000 });

  // An edit of the source shows here; so does a rename.
  const law = (await roots(page)).find((n) => n.label === "Labour law")!.key;
  await call(page, "page.save", { target: `resource:${law}`, changes: { "body.text": LAW.replace("eight hours", "seven hours") } });
  await call(page, "page.save", { target: `resource:${law}`, changes: { name: "Labour Act" } });
  await page.reload();
  await treeItem(page, "Contract").click();
  await toggle(page).click();
  const renamed = page.getByRole("figure", { name: "Labour Act › Article 36" });
  await expect(renamed).toContainText("seven hours a day", { timeout: 15_000 });

  // The title opens the source; its info panel says it is embedded, and where.
  await renamed.getByRole("button", { name: "Labour Act › Article 36" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Labour Act" })).toBeVisible();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText("Embedded")).toBeVisible();
  await expect(info.getByText("› Article 36")).toBeVisible();
  await shot(page, "info");
});

test("a missing section, a missing resource and a loop say so instead of failing", async ({ page }) => {
  await openKernel(page, host);
  await newNote(page, "Edge cases", "![[Labour Act#Article 99]]\n\n![[Nobody]]\n\n![[Edge cases]]");
  await toggle(page).click();
  await expect(page.getByText("There is no section “Article 99” in it.")).toBeVisible();
  await expect(page.getByRole("figure", { name: "Nobody" })).toContainText("not there any more");
  await expect(page.getByRole("figure", { name: "Edge cases" })).toContainText("Embedded too deep, or inside itself");
  await shot(page, "edges");
});

test("D482 from New: typing ![[ offers the candidates with where they are; the one picked is written uniquely; a bare namesake is flagged and rewritten", async ({ page }) => {
  await openKernel(page, host);
  const groupOf = async (name: string) => (await call<{ key: string }>(page, "tree.createGroup", { tree: "resources", name })).key;
  const a = await groupOf("Book A");
  const b = await groupOf("Book B");
  for (const [g, who] of [[a, "first"], [b, "second"]] as const) {
    await call(page, "page.save", { target: `new:org.onedesk.note:note?parent=${g}`, changes: { name: "Chapter 1", "body.text": `This is the ${who} book.` } });
  }
  await page.reload();
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Note", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Info" }).getByText("Not saved yet")).toBeVisible();
  await page.getByRole("complementary", { name: "Info" }).getByRole("textbox", { name: "Name" }).fill("Reader");
  await content(page).click();
  await page.keyboard.type("Read this:\n\n![[Chapter");
  const list = page.getByRole("listbox", { name: "Resources to refer to" });
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list).toContainText("Book A/Chapter 1");
  await expect(list).toContainText("Book B/Chapter 1");
  await shot(page, "suggest");
  await list.getByRole("option", { name: /Book B\/Chapter 1/ }).click();
  await expect(content(page)).toHaveValue("Read this:\n\n![[Book B/Chapter 1]]");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "Reader" })).toBeVisible();
  await toggle(page).click();
  await expect(page.getByRole("figure", { name: "Chapter 1" })).toContainText("This is the second book.");

  // A bare name that two resources have: the info panel says so, and writes it uniquely on request.
  const reader = (await roots(page)).find((n) => n.label === "Reader")!.key;
  await call(page, "page.save", { target: `resource:${reader}`, changes: { "body.text": "![[Book B/Chapter 1]]\n\nSee [[Chapter 1]]." } });
  await page.reload();
  await treeItem(page, "Reader").click();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText("2 with this name")).toBeVisible();
  await shot(page, "ambiguous");
  await info.getByRole("button", { name: "Write it uniquely" }).click();
  await expect(info.getByText("2 with this name")).toHaveCount(0);
  const text = (await call<{ body: { text: string } }>(page, "resource.get", { id: reader })).body.text;
  expect(text).toMatch(/See \[\[Book [AB]\/Chapter 1\]\]\./);
});
