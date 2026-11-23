/**
 * Round 21 against the REAL kernel: writing help (D462, docs/redesign/ai-assist.md §9). The shell's ✨ on a field and
 * "Fill with AI" on a page start the AI plugin's `assist` action through `assist.start`; the answer is a proposal that
 * only Accept puts into the page (unsaved). Nothing real is contacted: the Anthropic connection talks to the local fake
 * (plugins/_testing/fake-ai). devhost runs with the in-memory secret store and a temp data directory.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakeAi, type FakeAi } from "../plugins/_testing/fake-ai/server";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

const AI = "org.onedesk.ai";
const ANTH = "org.onedesk.ai.anthropic:connection";
const NOTE = "org.onedesk.note:note";
const LINK = "org.onedesk.link:link";

let host: Host;
let base: string;
let ai: FakeAi;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round21a-")));
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
const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `round21-${name}.png`) });
};
const chats = () => ai.requests.filter((r) => r.method === "POST" && r.path === "/v1/messages");
const userText = (r: { body: any }): string => {
  const m = r.body?.messages?.[0];
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c: any) => c.text ?? "").join("") : "";
};
/** `assist.start` then wait for the run: the provider's JSON answer. */
async function assistRun(page: Page, input: Record<string, unknown>, envId?: string): Promise<any> {
  const id = await call<string>(page, "assist.start", { target: "page:org.onedesk.welcome:welcome", tabId: "e2e", locale: "en-US", envId, input });
  let r: { status: string; output?: { text: string }; error?: unknown } = { status: "running" };
  for (let i = 0; i < 300 && r.status === "running"; i++) {
    r = await call(page, "run.get", { id });
    if (r.status === "running") await page.waitForTimeout(100);
  }
  expect(r.status, JSON.stringify(r.error)).toBe("success");
  return JSON.parse(r.output!.text);
}

test("the kernel names the provider: the AI plugin implements onedesk.assist/1", async ({ page }) => {
  await openKernel(page, host);
  expect(await call(page, "assist.provider")).toMatchObject({ available: true, plugin: AI });
  // a connection to the fake, as the default one
  const conn = await create(page, ANTH, { name: "Fake Anthropic", "body.baseUrl": ai.url, "body.secret": "sk-ant-e2e-assist" });
  await call(page, "plugin.setSetting", { plugin: AI, name: "connection", value: conn });
});

test("✨ on a note's content: prepare shows what would be sent, Send asks the fake, Accept puts the proposal in as an unsaved change", async ({ page }) => {
  ai.set({ kind: "ok", pieces: ["- point one\n", "- point two"] });
  await openKernel(page, host);
  const id = await create(page, NOTE, { name: "Weekly sync", "body.text": "Met with ann@example.com about the roadmap." });
  await page.locator("[data-tree-key]", { hasText: "Weekly sync" }).first().dblclick();
  await page.getByRole("button", { name: "Write with AI" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Summarize as two bullet points");
  const before = chats().length;
  await dialog.getByRole("button", { name: "Continue" }).click();
  // preview (the default policy): the request is shown, nothing was sent yet, the email is masked
  const preview = dialog.getByRole("textbox").first();
  await expect(preview).toHaveValue(/Summarize as two bullet points/, { timeout: 20_000 });
  await expect(preview).toHaveValue(/\[email\]/);
  await expect(dialog).toContainText("Fake Anthropic");
  expect(chats().length).toBe(before);
  await shot(page, "assist-preview");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(dialog.getByRole("textbox").first()).toHaveValue(/point one[\s\S]*point two/, { timeout: 30_000 });
  expect(chats().length).toBe(before + 1);
  expect(userText(chats().at(-1)!)).not.toContain("ann@example.com");
  await shot(page, "assist-proposal");
  await dialog.getByRole("button", { name: "Accept" }).click();
  await expect(dialog).toHaveCount(0);
  // the proposal is in the editor, unsaved: the stored note is unchanged until saved
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveValue(/point one/);
  expect((await call<{ body: { text: string } }>(page, "resource.get", { id })).body.text).toContain("roadmap");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await call<{ body: { text: string } }>(page, "resource.get", { id })).body.text).toContain("point one");
});

test("✨ by a labelled field writes that field (the browser profile says assist.off, so it has none); with ai.policy allow there is no preview step", async ({ page }) => {
  ai.set({ kind: "ok", pieces: ["https://example.com/docs"] });
  await openKernel(page, host);
  const env = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await call(page, "params.set", { node: env, name: "ai.policy", value: "allow" });
  await create(page, LINK, { name: "Docs" });
  await openKernel(page, host);
  await page.locator("[data-tree-key]", { hasText: "Docs" }).first().dblclick();
  await expect(page.getByRole("button", { name: "Write with AI" })).toHaveCount(1); // the address, not the profile
  await expect(page.getByRole("button", { name: "Fill with AI" })).toHaveCount(0); // one field: no page-wide button
  await page.getByRole("button", { name: "Write with AI" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Link to the product documentation");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("button", { name: "Accept" })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("textbox", { name: "Address", exact: true })).toHaveValue("https://example.com/docs");
});

test("fill mode over the protocol: one JSON answer gives every asked field and nothing else", async ({ page }) => {
  ai.set({ kind: "ok", pieces: ['{"body.a":"Alpha","body.b":"Beta","body.c":"not asked"}'] });
  await openKernel(page, host);
  const values = await assistRun(page, { step: "send", mode: "fill", instruction: "fill", page: { title: "T", kind: "K" }, fields: [{ name: "body.a", label: "A", kind: "text", value: "" }, { name: "body.b", label: "B", kind: "longtext", value: "" }] });
  expect(values).toMatchObject({ step: "send", mode: "fill", values: { "body.a": "Alpha", "body.b": "Beta" } });
  expect(Object.keys(values.values)).toEqual(["body.a", "body.b"]);
});

test("with ai.policy off the help says so and sends nothing", async ({ page }) => {
  const env = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await call(page, "params.set", { node: env, name: "ai.policy", value: "off" });
  await openKernel(page, host);
  const before = chats().length;
  const out = await assistRun(page, { step: "prepare", mode: "fill", instruction: "x", page: { title: "", kind: "" }, fields: [{ name: "body.a", label: "A", kind: "text", value: "" }] }, env);
  expect(out.error.code).toBe("policyOff");
  expect(chats().length).toBe(before);
  await call(page, "params.set", { node: env, name: "ai.policy", value: "preview" });
});
