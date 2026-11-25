/**
 * D484 §16 against the REAL kernel and the real image and note plugins, from New: an image is put before the first
 * save and shown after it; a screenshot pasted into a note is stored and shown in reading; `![[name]]` embeds the image;
 * clicking shows it large. Screenshots (not checked in): test-results/screenshots/images-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-images-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const roots = async (page: Page) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources" })).nodes;
const content = (page: Page) => page.getByRole("textbox", { name: "Content", exact: true });
const toggle = (page: Page) => page.locator(".od-titlebar__actions").getByRole("button", { name: "Read / Edit" });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `images-${name}.png`) });

// Two 40 × 30 PNGs (red, blue).
const RED = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAALElEQVR4nO3NMQ0AAAgDsMlBBP6DLGTA0aR/M10nIhaLxWKxWCwWi8Xiv/ECXGd+jLiIbqkAAAAASUVORK5CYII=";
const BLUE = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQ0AAAgDsMlBIhKRhQw4mvRvqudExGKxWCwWi8VisVj8N175o5fb2jpjLQAAAABJRU5ErkJggg==";

/** Drops (or pastes) a PNG on an element, as the system would. */
async function give(target: Locator, b64: string, how: "drop" | "paste", name = "shot.png") {
  await target.evaluate(
    (el, { b64, how, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: "image/png" }));
      if (how === "drop") el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      else el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    },
    { b64, how, name },
  );
}

async function newOf(page: Page, menu: string, name: string) {
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: menu, exact: true }).click();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText("Not saved yet")).toBeVisible();
  const box = info.getByRole("textbox", { name: "Name" });
  await box.fill(name);
  await expect(box).toHaveValue(name);
}

test("from New: an image is put before the first save, shown, saved, and shown large", async ({ page }) => {
  await openKernel(page, host);
  await newOf(page, "Image", "Circuit");
  const drop = page.getByRole("group", { name: "Image" });
  await expect(drop).toContainText("Drop an image here");
  await give(drop, RED, "drop", "circuit.png");
  await expect(drop.getByRole("button", { name: "Show large: circuit.png" })).toBeVisible({ timeout: 15_000 });
  await expect(drop).toContainText("40 × 30 · PNG");
  await shot(page, "new");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "Circuit" })).toBeVisible();
  const id = (await roots(page)).find((n) => n.label === "Circuit")!.key;
  const saved = await call<{ body: { image: { blob: string; width: number } } }>(page, "resource.get", { id });
  expect(saved.body.image.width).toBe(40);
  // Shown after a reload too (read for the saved resource), and large on click.
  await page.reload();
  await page.getByRole("treeitem", { name: "Circuit", exact: true }).click();
  const show = page.getByRole("button", { name: "Show large: circuit.png" });
  await expect(show).toBeVisible({ timeout: 15_000 });
  await show.click();
  await expect(page.getByRole("dialog", { name: "circuit.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Replaced: the field shows the new one, and the old one is still in the history.
  await give(page.getByRole("group", { name: "Image" }), BLUE, "drop", "blue.png");
  await expect(page.getByRole("button", { name: "Show large: blue.png" })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await call<{ body: { image: { blob: string } } }>(page, "resource.get", { id })).body.image.blob).not.toBe(saved.body.image.blob);
  const old = await call<{ type: string }>(page, "blob.read", { blob: saved.body.image.blob, resource: id });
  expect(old.type).toBe("image/png");
});

test("a pasted screenshot is stored in a note and shown in reading; ![[Circuit]] embeds the image", async ({ page }) => {
  await openKernel(page, host);
  await newOf(page, "Note", "Board notes");
  await content(page).click();
  await page.keyboard.type("The board:\n\n");
  await give(content(page), RED, "paste");
  await expect(content(page)).toHaveValue(/!\[Image\]\(blob:[0-9a-f]{64}\)/, { timeout: 15_000 });
  await content(page).press("End");
  await page.keyboard.type("\n\n![[Circuit]]");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "Board notes" })).toBeVisible();
  await toggle(page).click();
  await expect(page.locator("img.od-markdown__img")).toHaveCount(1, { timeout: 15_000 });
  const embed = page.getByRole("figure", { name: "Circuit" });
  await expect(embed.getByRole("button", { name: /Show large: Circuit/ })).toBeVisible({ timeout: 15_000 });
  await shot(page, "note");
  await page.locator("img.od-markdown__img").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
});
