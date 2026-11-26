/**
 * D487 §29 (docs/redesign/book.md) against the REAL kernel, the real book plugin and a real MCP client (onedesk-mcp on
 * stdio): an AI reads a book (book_contents, book_page, read) and proposes changes — two edits in chapter 1, a new
 * "Summary" page, the draft deleted; the user reviews them under "Proposals to review": accepts the edit, rejects the
 * deletion, changes the summary and accepts it; the history says which proposal and who proposed it. A second
 * proposal is made, the user changes the same paragraph first: it is marked "Original changed", looked at again and
 * accepted. The app and a headless MCP worker never run on one workspace at once (the workspace lock).
 * Screenshots (not checked in): test-results/screenshots/proposals-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { connectMcp, type StdioMcpClient } from "./_mcp/mcp-client";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, ui, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const MCP_BIN = process.env.ONEDESK_MCP_BIN ?? path.join(ROOT, "target/debug/onedesk-mcp");
const B = "org.onedesk.book";
const TOOL = (name: string) => `org_onedesk_book__${name}`;

let base: string;
let dataDir: string;
let host: Host | null = null;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST) || !existsSync(MCP_BIN), `onedesk-devhost / onedesk-mcp not built (${DEVHOST}, ${MCP_BIN})`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-proposals-")));
  dataDir = path.join(base, "data");
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

type Node = { key: string; label: string };
const call = <T = any>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host!, method, params);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `proposals-${name}.png`) });

async function up(page: Page) {
  host = await startHost(dataDir);
  await openKernel(page, host);
}
async function down() {
  if (host) await stopHost(host);
  host = null;
}
async function withMcp<T>(fn: (c: StdioMcpClient) => Promise<T>): Promise<T> {
  const c = await connectMcp({ command: MCP_BIN, args: ["--data-dir", dataDir], env: { ONEDESK_DATA_DIR: dataDir, ONEDESK_MCP_IDLE_MS: "300" } });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}
async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  return (await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes })).page.resourceId;
}
const text = async (page: Page, id: string) => (await call<{ body: Record<string, any> }>(page, "resource.get", { id })).body.text;

const ids = {} as Record<"book" | "c1" | "c2" | "draft" | "app", string>;

test("an AI reads a book and proposes; the user accepts, rejects, edits and accepts", async ({ page }) => {
  await up(page);
  ids.book = await make(page, `${B}:book`, null, { name: "Field guide" });
  await expect.poll(async () => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent: ids.book })).nodes.length).toBe(2);
  ids.c1 = await make(page, `${B}:page`, ids.book, { name: "Birds", "body.text": "Birds have feathers.\n\nMost birds can fly." });
  ids.c2 = await make(page, `${B}:page`, ids.book, { name: "Trees", "body.text": "Trees are tall plants." });
  ids.draft = await make(page, `${B}:page`, ids.book, { name: "Draft", "body.text": "notes to self" });
  ids.app = await make(page, `${B}:appendix`, ids.book, { name: "Glossary" });
  await call(page, "resource.setAiVisible", { id: ids.book, visible: true, withChildren: true });
  await call(page, "workspace.setConfig", { name: "mcp.enabled", value: "true" });
  await call(page, "workspace.setConfig", { name: "mcp.allow_proposals", value: "true" });
  await down();

  await withMcp(async (c) => {
    const tools = (await c.listTools()).map((t: { name: string }) => t.name);
    for (const t of ["tree", "read", "propose", TOOL("book_contents"), TOOL("book_page"), TOOL("book_refs")]) expect(tools).toContain(t);
    const contents = JSON.parse((await c.callTool(TOOL("book_contents"), { book: ids.book })).json.output.text);
    const birds = contents.entries.find((e: any) => e.id === ids.c1);
    expect(birds).toMatchObject({ role: "body", number: "Chapter 1", name: "Birds" });
    expect(contents.roles.toc).toContain("contents");
    const pageInfo = JSON.parse((await c.callTool(TOOL("book_page"), { id: ids.c1, book: ids.book })).json.output.text);
    expect(pageInfo.text).toContain("Most birds can fly.");
    const read = (await c.callTool("read", { id: ids.c1 })).json;
    const field = read.fields.find((f: any) => f.path === "body.text");
    expect(field.changeable).toBe(true);
    const r = await c.callTool("propose", {
      title: "Tighten chapter 1",
      comment: "Two clearer sentences, a summary, and the draft removed.",
      items: [
        { op: "update", id: ids.c1, rev: read.rev, changes: { "body.text": "Birds have feathers and lay eggs.\n\nMost birds can fly; penguins cannot." } },
        { op: "create", kind: `${B}:page`, parent: ids.book, before: ids.draft, name: "Summary", values: { "body.text": "Birds and trees, in short." } },
        { op: "delete", id: ids.draft },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.json.status).toBe("pending");
  });

  await up(page);
  // Nothing written yet.
  expect(await text(page, ids.c1)).toBe("Birds have feathers.\n\nMost birds can fly.");
  const views = page.getByRole("navigation", { name: "Views" });
  await views.getByRole("button", { name: /^Proposals to review/ }).click();
  await ui.node(page, "Tighten chapter 1").click();
  await expect(page.getByRole("heading", { name: /Tighten chapter 1/ }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/AI client/).first()).toBeVisible();
  const item = (n: RegExp) => page.locator("section", { has: page.getByRole("heading", { name: n }) }).last();
  await expect(item(/1\. Change · Birds/).locator(".od-diff__mark--added").first()).toBeVisible();
  await shot(page, "review");

  await item(/1\. Change · Birds/).getByRole("button", { name: "Accept", exact: true }).click();
  await expect(item(/1\. Change · Birds/).getByText("Accepted")).toBeVisible({ timeout: 15_000 });
  await item(/3\. Delete · Draft/).getByRole("button", { name: "Reject", exact: true }).click();
  await expect(item(/3\. Delete · Draft/).getByText("Rejected")).toBeVisible({ timeout: 15_000 });
  const add = item(/2\. Add · Summary/);
  await add.getByRole("button", { name: "Edit", exact: true }).click();
  await add.getByRole("textbox", { name: /^Edit .*Text|^Edit Content|^Edit / }).last().fill("Birds and trees, briefly.");
  await add.getByRole("button", { name: "Accept as edited" }).click();
  await expect(add.getByText("Accepted")).toBeVisible({ timeout: 15_000 });
  await shot(page, "decided");

  // In the book: the edit, the new page before the draft (kept), the summary as edited.
  expect(await text(page, ids.c1)).toBe("Birds have feathers and lay eggs.\n\nMost birds can fly; penguins cannot.");
  const kids = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent: ids.book })).nodes.map((n) => n.label);
  expect(kids).toEqual(expect.arrayContaining(["Summary", "Draft"]));
  expect(kids.indexOf("Summary")).toBe(kids.indexOf("Draft") - 1);
  const summary = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent: ids.book })).nodes.find((n) => n.label === "Summary")!.key;
  expect(await text(page, summary)).toBe("Birds and trees, briefly.");
  // The history says so.
  const h = await call<any[]>(page, "resource.history", { id: ids.c1 });
  expect(h.find((e) => e.field === "body.text")).toMatchObject({ actor: "user", proposal: { title: "Tighten chapter 1" } });
  expect(h.find((e) => e.field === "body.text").proposal.proposer).toMatch(/^ai:/);
  await page.getByRole("button", { name: "Expand all" }).first().click().catch(() => undefined);
  await down();
});

test("the original changed after the proposal: marked, looked at again, accepted", async ({ page }) => {
  await withMcp(async (c) => {
    const read = (await c.callTool("read", { id: ids.c2 })).json;
    const r = await c.callTool("propose", { title: "Trees, better", items: [{ op: "update", id: ids.c2, rev: read.rev, changes: { "body.text": "Trees are tall woody plants." } }] });
    expect(r.isError).toBe(false);
  });
  await up(page);
  // The user changes the same paragraph first.
  await call(page, "page.save", { target: `resource:${ids.c2}`, changes: { "body.text": "Trees are tall, living plants." } });
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Proposals to review/ }).click();
  await ui.node(page, "Trees, better").click();
  const item = page.locator("section", { has: page.getByRole("heading", { name: /1\. Change · Trees/ }) }).last();
  await expect(item.getByText("Original changed")).toBeVisible({ timeout: 15_000 });
  await expect(item.locator(".od-diff__cell--removed").first()).toContainText("living");
  await shot(page, "stale");
  await item.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(item.getByText("Accepted")).toBeVisible({ timeout: 15_000 });
  expect(await text(page, ids.c2)).toBe("Trees are tall woody plants.");
  // Nothing left to review.
  expect((await call<{ pending: number }>(page, "proposal.count", {})).pending).toBe(0);
  await down();
});
