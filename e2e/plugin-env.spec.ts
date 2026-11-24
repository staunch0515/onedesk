/**
 * The plugin requirements of D466 against the REAL kernel and the real built-in plugins (devhost on a temp dir):
 *  - environment parameters are added freely: any name, any value, typed in the "Add parameter" dialog;
 *  - every tab picks an environment (the kernel's default; the welcome page is the exception);
 *  - a note is a template: {{name}} is filled from the tab's environment, another environment gives another text;
 *  - one function, one control: the note's reading/editing switch is only in the actions row.
 * Screenshots (not checked in): test-results/screenshots/plugin-env-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const NOTE = "org.onedesk.note:note";
let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-plugin-env-")));
  host = await startHost(path.join(base, "data"));
});

test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const children = async (page: Page, tree: string, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
const showTree = async (page: Page, name: string) => {
  const b = sideTab(page, name);
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const treeItem = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const envSelect = (page: Page) => page.getByRole("combobox", { name: "Environment of this tab" });

async function pickEnv(page: Page, name: string) {
  await envSelect(page).click();
  await page.getByRole("option", { name: new RegExp(`^\\s*${name}$`) }).click();
  await expect(envSelect(page)).toContainText(name);
}

test("an environment parameter is added by typing any name and value (D466)", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Environments");
  await treeItem(page, "Default").click();
  await page.getByRole("button", { name: "Add parameter" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill("tenant_id");
  await dialog.getByRole("textbox", { name: "Value" }).fill("1001");
  await page.screenshot({ path: path.join(OUT, "plugin-env-add-param.png") });
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const root = (await children(page, "env")).find((n) => n.label === "Default")!.key;
  type P = { name: string; value: string };
  await expect.poll(async () => (await call<{ params: P[] }>(page, "params.env", { envId: root })).params.find((p) => p.name === "tenant_id")?.value).toBe("1001");
  // A second environment with another value, for the next test.
  await page.getByRole("button", { name: "New environment" }).first().click();
  await page.getByRole("textbox", { name: "New name" }).fill("Other");
  await page.keyboard.press("Enter");
  await expect(treeItem(page, "Other")).toBeVisible();
  const other = (await children(page, "env", root)).find((n) => n.label === "Other")!.key;
  await call(page, "params.set", { node: other, name: "tenant_id", value: "2002" });
});

test("a note picks an environment and is a template; its reading/editing switch is only in the actions row (D466)", async ({ page }) => {
  await openKernel(page, host);
  const id = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${NOTE}`, changes: { name: "Tenant note", "body.text": "Tenant **{{tenant_id}}**, key {{secret:k}}" } })).page.resourceId;
  await showTree(page, "Resources");
  await treeItem(page, "Tenant note").click();
  await expect(page.getByRole("heading", { level: 1, name: "Tenant note" })).toBeVisible();
  // Every tab picks an environment, the note's too; and it has the info panel.
  await expect(envSelect(page)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Info" })).toBeVisible();
  // No second control for the mode: only the action.
  await expect(page.getByRole("combobox", { name: "Mode" })).toHaveCount(0);
  const toggle = page.locator(".od-titlebar__actions").getByRole("button", { name: "Read / Edit" });
  await expect(toggle).toBeVisible();

  await pickEnv(page, "Default");
  // The placeholder strip shows the environment's value while editing.
  await expect(page.getByRole("textbox", { name: "tenant_id", exact: true })).toHaveAttribute("placeholder", "1001");
  await toggle.click();
  // The reading view: Markdown, the placeholder filled (in bold), the secret never.
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveCount(0);
  const reading = page.locator(".od-pf__content p", { hasText: "Tenant" });
  await expect(reading).toHaveText("Tenant 1001, key {{secret:k}}");
  await expect(reading.locator("strong")).toHaveText("1001");
  await page.screenshot({ path: path.join(OUT, "plugin-env-note-default.png") });
  // Another environment, another text; the saved note is unchanged.
  await pickEnv(page, "Other");
  await expect(reading).toHaveText("Tenant 2002, key {{secret:k}}");
  await page.screenshot({ path: path.join(OUT, "plugin-env-note-other.png") });
  expect((await call<{ body: { text: string } }>(page, "resource.get", { id })).body.text).toContain("{{tenant_id}}");
  // Back to editing: the editor shows the text as written.
  await toggle.click();
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveValue(/\{\{tenant_id\}\}/);
});

test("only the welcome page goes without an environment; content pages have one", async ({ page }) => {
  await openKernel(page, host);
  type D = { usesEnv: boolean };
  const resolve = (target: string) => call<D>(page, "page.resolve", { target, context: {} });
  expect((await resolve(`new:${NOTE}`)).usesEnv).toBe(true);
  expect((await resolve("new:org.onedesk.link:link")).usesEnv).toBe(true);
  expect((await resolve("new:org.onedesk.prompt:prompt")).usesEnv).toBe(true);
  expect((await resolve("page:org.onedesk.welcome/welcome")).usesEnv).toBe(false);
});
