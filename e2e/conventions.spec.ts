/**
 * D487 §31 (docs/redesign/book.md) against the REAL kernel and the real book plugin: a book with a preface, conventions
 * (a table of words and one of symbols), two chapters, references and contents. The conventions page shows the text,
 * the tables and how the book is arranged; “Check against the conventions” lists the places (not the one in a code
 * block); “Propose changes” makes one proposal, accepted under “Proposals to review”; checking again finds nothing.
 * Then an AI client (onedesk-mcp) gets the conventions with the contents and the same places from book_check.
 * Screenshots (not checked in): test-results/screenshots/conventions-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { connectMcp } from "./_mcp/mcp-client";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, ui, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.setTimeout(240_000);

const MCP_BIN = process.env.ONEDESK_MCP_BIN ?? path.join(ROOT, "target/debug/onedesk-mcp");
const B = "org.onedesk.book";
let base: string;
let dataDir: string;
let host: Host | null = null;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST) || !existsSync(MCP_BIN), `onedesk-devhost / onedesk-mcp not built (${DEVHOST}, ${MCP_BIN})`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-conventions-")));
  dataDir = path.join(base, "data");
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

type Node = { key: string; label: string };
const call = <T = any>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host!, method, params);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `conventions-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });
async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  return (await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes })).page.resourceId;
}
const text = async (page: Page, id: string) => (await call<{ body: Record<string, any> }>(page, "resource.get", { id })).body.text;

test("conventions: the tables, the arrangement, checking, one proposal, and the same for AI", async ({ page }) => {
  host = await startHost(dataDir);
  await openKernel(page, host);
  const book = await make(page, `${B}:book`, null, { name: "Data handbook" });
  await expect.poll(async () => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent: book })).nodes.length).toBe(2);
  await make(page, `${B}:preface`, book, { name: "Preface", "body.text": "Why a login matters." });
  const conv = await make(page, `${B}:conventions`, book, { name: "Conventions" });
  // A new one starts from a skeleton.
  await expect.poll(async () => String(await text(page, conv)), { timeout: 15_000 }).toContain("1. Arrangement");
  await call(page, "page.save", {
    target: `resource:${conv}`,
    changes: { "body.terms": [{ avoid: "login", use: "sign in", note: "" }, { avoid: "databank", use: "database", note: "" }], "body.symbols": [{ symbol: "*", meaning: "optional" }] },
  });
  const c1 = await make(page, `${B}:page`, book, { name: "Storage", "body.text": "A databank holds tables.\n\n```\nlogin --user x\n```" });
  const c2 = await make(page, `${B}:page`, book, { name: "Access", "body.text": "Every login is logged. A databank needs a login." });
  await make(page, `${B}:references`, book, { name: "References" });

  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Conventions", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Conventions" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("How this book is arranged")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Chapters are numbered “Chapter 1”/)).toBeVisible();
  await expect(page.getByText(/order first cited/)).toBeVisible();
  await shot(page, "page");

  await action(page, "Check against the conventions").click();
  await expect(page.getByText(/\b5 rows\b/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("row", { name: /A 【databank】 holds tables/ })).toBeVisible();
  // Not the one in the code block.
  await expect(page.getByRole("row", { name: /--user/ })).toHaveCount(0);
  await shot(page, "check");

  await action(page, "Propose changes").click();
  await expect.poll(async () => (await call<{ pending: number }>(page, "proposal.count", {})).pending, { timeout: 20_000 }).toBe(1);
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Proposals to review/ }).click();
  await ui.node(page, "Use the words the conventions say").click();
  await expect(page.getByText(/Plugin org\.onedesk\.book/).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByText("Accepted").first()).toBeVisible({ timeout: 15_000 });
  expect(await text(page, c1)).toBe("A database holds tables.\n\n```\nlogin --user x\n```");
  expect(await text(page, c2)).toBe("Every sign in is logged. A database needs a sign in.");

  // Checking again: nothing left.
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Data handbook|^Resources/ }).first().click().catch(() => undefined);
  await page.getByRole("treeitem", { name: "Conventions", exact: true }).click();
  await action(page, "Check against the conventions").click();
  await expect(page.getByText(/\b0 rows\b/).first()).toBeVisible({ timeout: 20_000 });

  // For AI.
  await call(page, "resource.setAiVisible", { id: book, visible: true, withChildren: true });
  await call(page, "workspace.setConfig", { name: "mcp.enabled", value: "true" });
  await call(page, "page.save", { target: `resource:${c2}`, changes: { "body.text": "One more login." } });
  await stopHost(host);
  host = null;
  const c = await connectMcp({ command: MCP_BIN, args: ["--data-dir", dataDir], env: { ONEDESK_DATA_DIR: dataDir, ONEDESK_MCP_IDLE_MS: "300" } });
  try {
    const contents = JSON.parse((await c.callTool("org_onedesk_book__book_contents", { book })).json.output.text);
    expect(contents.conventions.terms.map((t: any) => t.avoid)).toEqual(["login", "databank"]);
    expect(contents.conventions.arrangement.length).toBeGreaterThan(1);
    const check = JSON.parse((await c.callTool("org_onedesk_book__book_check", { book })).json.output.text);
    expect(check.places.map((p: any) => [p.pageName, p.found, p.use])).toEqual([["Chapter 2 Access", "login", "sign in"]]);
  } finally {
    await c.close();
  }
});
