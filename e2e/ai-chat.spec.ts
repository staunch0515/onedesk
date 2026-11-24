/**
 * D479 (docs/redesign/ai-chat.md) against the REAL kernel and the real built-in plugins: the one AI entry point is the
 * "AI chat" button. It opens (the first time: makes, next to the page) a conversation about the page; the description is
 * the lasting background, the box is what is wanted this time; with the default policy the first Send shows the full
 * text and the second sends; an answer's changes go into the page only as unsaved changes. Material is any resource
 * dropped on the conversation, sent only when the user lets AI see it. Nothing real is contacted: the Anthropic
 * connection talks to the local fake (plugins/_testing/fake-ai). Screenshots: test-results/screenshots/ai-chat-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakeAi, type FakeAi } from "../plugins/_testing/fake-ai/server";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const AI = "org.onedesk.ai";
const ANTH = "org.onedesk.ai.anthropic:connection";
const NOTE = "org.onedesk.note:note";

let host: Host;
let base: string;
let ai: FakeAi;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-ai-chat-")));
  ai = await startFakeAi();
  host = await startHost(path.join(base, "data"), { ONEDESK_TEST_HOOKS: "1" });
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (ai) await ai.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
type Node = { key: string; label: string };
const roots = async (page: Page) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources" })).nodes;
const chats = () => ai.requests.filter((r) => r.method === "POST" && r.path === "/v1/messages");
const userText = (r: { body: any }): string => {
  const m = r.body?.messages?.at(-1);
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c: any) => c.text ?? "").join("") : "";
};
const systemOf = (r: { body: any }) => JSON.stringify(r.body?.system ?? "");
const env = async (page: Page) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
const setPolicy = async (page: Page, value: string) => call(page, "params.set", { node: await env(page), name: "ai.policy", value });
const treeItem = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const shot = async (page: Page, name: string) => {
  await page.mouse.move(720, 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `ai-chat-${name}.png`) });
};
const APPLY = (values: Record<string, string>) => "Here it is.\n\n```onedesk-apply\n" + JSON.stringify(values) + "\n```";

test("the AI workbench is the provider; a connection to the fake is the default", async ({ page }) => {
  await openKernel(page, host);
  expect(await call(page, "assist.provider")).toMatchObject({ available: true, plugin: AI, command: `${AI}:openChat` });
  const conn = await create(page, ANTH, { name: "Fake Anthropic", "body.baseUrl": ai.url, "body.secret": "sk-ant-e2e-chat" });
  await call(page, "plugin.setSetting", { plugin: AI, name: "connection", value: conn });
});

test("one entry point: the AI chat button opens a conversation next to the page; preview, then send; Apply puts the answer in unsaved", async ({ page }) => {
  await openKernel(page, host);
  const id = await create(page, NOTE, { name: "Weekly sync", description: "Meeting notes of the team", "body.text": "Met with ann@example.com about the roadmap." });
  await treeItem(page, "Weekly sync").click();
  // No ✨ by fields any more, and no other AI button.
  await expect(page.getByRole("button", { name: "Write with AI" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fill with AI" })).toHaveCount(0);
  await page.getByRole("button", { name: "AI chat" }).click();
  // Asking for a chat about the note is the word to let AI see it.
  await expect.poll(async () => (await call<{ aiVisible?: boolean }>(page, "resource.get", { id })).aiVisible).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "AI: Weekly sync" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Target: Weekly sync" })).toBeVisible();
  // The conversation sits right next to its page in the tree.
  const labels = (await roots(page)).map((n) => n.label);
  expect(labels.indexOf("AI: Weekly sync")).toBe(labels.indexOf("Weekly sync") - 1);
  await shot(page, "new");

  const before = chats().length;
  await box(page).fill("Make it two bullet points");
  await box(page).press("Enter");
  // Preview (the default policy): the full text is shown, the e-mail masked, nothing sent.
  await expect(page.getByText("What will be sent to Fake Anthropic").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("[email]").first()).toBeVisible();
  expect(chats().length).toBe(before);
  await shot(page, "preview");

  ai.set({ kind: "ok", pieces: [APPLY({ "body.text": "- roadmap\n- next steps" })] });
  await box(page).press("Enter");
  await expect(page.getByRole("article", { name: "AI" })).toContainText("Here it is.", { timeout: 30_000 });
  await expect(page.getByRole("article", { name: "Me" })).toContainText("Make it two bullet points");
  await expect(box(page)).toHaveValue("");
  expect(chats().length).toBe(before + 1);
  const sent = chats().at(-1)!;
  expect(userText(sent)).toBe("Make it two bullet points");
  expect(systemOf(sent)).toContain("Meeting notes of the team");
  expect(systemOf(sent)).not.toContain("ann@example.com");
  await shot(page, "answer");

  await page.getByRole("button", { name: "Apply to Weekly sync" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Weekly sync" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveValue("- roadmap\n- next steps");
  expect((await call<{ body: { text: string } }>(page, "resource.get", { id })).body.text, "nothing is saved by Apply").toContain("roadmap.");
  await shot(page, "applied");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await call<{ body: { text: string } }>(page, "resource.get", { id })).body.text).toBe("- roadmap\n- next steps");

  // The same button opens the same conversation, with what was said.
  await page.getByRole("button", { name: "AI chat" }).click();
  await expect(page.getByRole("article", { name: "Me" })).toContainText("Make it two bullet points");
  expect((await roots(page)).filter((n) => n.label === "AI: Weekly sync")).toHaveLength(1);
});

test("Apply over unsaved typing asks first", async ({ page }) => {
  await setPolicy(page, "allow");
  await openKernel(page, host);
  await create(page, NOTE, { name: "Draft plan", "body.text": "v1" });
  await treeItem(page, "Draft plan").click();
  await page.getByRole("textbox", { name: "Content", exact: true }).fill("typed by me");
  await page.getByRole("button", { name: "AI chat" }).click();
  ai.set({ kind: "ok", pieces: [APPLY({ "body.text": "from AI" })] });
  await box(page).fill("Rewrite");
  await box(page).press("Enter");
  await page.getByRole("button", { name: "Apply to Draft plan" }).click({ timeout: 30_000 });
  const ask = page.getByRole("dialog");
  await expect(ask).toContainText("Replace your unsaved changes?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Apply to Draft plan" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Replace" }).click();
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveValue("from AI");
});

test("from New: an unsaved note's chat writes from the description typed in its info panel; the content is kept with the first save", async ({ page }) => {
  await setPolicy(page, "allow");
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Note", exact: true }).click();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText("Not saved yet")).toBeVisible();
  await info.getByRole("textbox", { name: "Name" }).fill("Moon poem");
  await info.getByRole("textbox", { name: "Description" }).fill("A four-line poem about the moon");
  await page.getByRole("button", { name: "AI chat" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "AI: Moon poem" })).toBeVisible();
  ai.set({ kind: "ok", pieces: [APPLY({ "body.text": "Silver moon\nover the sea" })] });
  const before = chats().length;
  // Nothing typed: the description is the request.
  await box(page).press("Enter");
  await expect(page.getByRole("article", { name: "AI" })).toBeVisible({ timeout: 30_000 });
  expect(chats().length).toBe(before + 1);
  expect(userText(chats().at(-1)!)).toBe("A four-line poem about the moon");
  await page.getByRole("button", { name: "Apply to Moon poem" }).click();
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveValue("Silver moon\nover the sea");
  await expect(info.getByText("Not saved yet")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "Moon poem" })).toBeVisible();
  const saved = (await roots(page)).find((n) => n.label === "Moon poem")!;
  expect((await call<{ body: { text: string } }>(page, "resource.get", { id: saved.key })).body.text).toBe("Silver moon\nover the sea");
});

test("material: a resource dropped on the conversation goes along only once the user lets AI see it", async ({ page }) => {
  await setPolicy(page, "allow");
  await openKernel(page, host);
  const facts = await create(page, NOTE, { name: "Team facts", "body.text": "The team has FIVE-MARKER people." });
  const chat = await create(page, `${AI}:analysis`, { name: "Questions" });
  const drop = await call<{ handled?: boolean }>(page, "tree.move", { tree: "resources", key: facts, target: chat, position: "inside" });
  expect(drop.handled).toBe(true);
  await treeItem(page, "Questions").click();
  const material = page.getByRole("table", { name: "refs" });
  await expect(material).toContainText("Team facts");
  await expect(material).toContainText("Not allowed for AI");
  ai.set({ kind: "ok", pieces: ["I do not know."] });
  await box(page).fill("How many people?");
  await box(page).press("Enter");
  await expect(page.getByRole("article", { name: "AI" }).last()).toContainText("I do not know.", { timeout: 30_000 });
  expect(systemOf(chats().at(-1)!)).not.toContain("FIVE-MARKER");
  await call(page, "resource.setAiVisible", { id: facts, visible: true });
  await openKernel(page, host);
  await treeItem(page, "Questions").click();
  await expect(page.getByRole("table", { name: "refs" })).toContainText("Allowed");
  ai.set({ kind: "ok", pieces: ["Five."] });
  await box(page).fill("And now?");
  await box(page).press("Enter");
  await expect(page.getByRole("article", { name: "AI" }).last()).toContainText("Five.", { timeout: 30_000 });
  const last = chats().at(-1)!;
  expect(systemOf(last)).toContain("FIVE-MARKER");
  // earlier turns go along
  expect(JSON.stringify(last.body.messages)).toContain("How many people?");
  await shot(page, "material");
});

test("with ai.policy off nothing is sent and the page says so", async ({ page }) => {
  await setPolicy(page, "off");
  await openKernel(page, host);
  const before = chats().length;
  const chat = await create(page, `${AI}:analysis`, { name: "Off chat" });
  await treeItem(page, "Off chat").click();
  await expect(page.getByText(/turned off/).first()).toBeVisible();
  await box(page).fill("Hello");
  await box(page).press("Enter");
  await expect(page.getByText(/ai\.policy = off/).first()).toBeVisible({ timeout: 20_000 });
  expect(chats().length).toBe(before);
  expect((await call<{ body: { turns: unknown[] } }>(page, "resource.get", { id: chat })).body.turns).toEqual([]);
  await setPolicy(page, "preview");
});
