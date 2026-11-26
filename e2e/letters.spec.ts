/**
 * D487 §35 (docs/redesign/book.md, K19) against the REAL kernel and the real letters, exercise and document plugins, two
 * workspaces (two devhosts) that know each other's identity: the teacher sends a test as homework; the student takes
 * the letter (signed, checked), answers the test, replies; the teacher takes the reply: the letter shows who answered
 * and how, the attempt is among the learning records (“Answers by letter”). Then a document is sent for review: the
 * reviewer reviews it (a stamped, signed review), replies; the sender's document lists the review.
 * Screenshots (not checked in): test-results/screenshots/letters-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

let a: Host;
let b: Host;
let base: string;
let outA: string;
let outB: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-letters-")));
  a = await startHost(path.join(base, "a"));
  b = await startHost(path.join(base, "b"));
  outA = path.join(base, "outA");
  outB = path.join(base, "outB");
  mkdirSync(outA, { recursive: true });
  mkdirSync(outB, { recursive: true });
});
test.afterAll(async () => {
  if (a) await stopHost(a);
  if (b) await stopHost(b);
  if (base) rmSync(base, { recursive: true, force: true });
});

const I = "org.onedesk.inbox";
const X = "org.onedesk.exercise";
const D = "org.onedesk.document";
type Node = { key: string; label: string };
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `letters-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });
async function make(page: Page, h: Host, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  return (await rpc<{ page: { resourceId: string } }>(page, h, "page.save", { target, changes })).page.resourceId;
}
const letters = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".odletter")).sort();
async function takeFile(page: Page, file: string, title: RegExp, button: string) {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("menuitem", { name: "Import file…" }).click();
  await page.getByRole("textbox", { name: "Package file" }).fill(file);
  await page.getByRole("button", { name: "Look inside" }).click();
  await expect(page.getByRole("dialog", { name: title })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: button, exact: true }).click();
}
async function open(page: Page, name: string | RegExp) {
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name, exact: typeof name === "string" }).first().click();
}

let toB = "";
let quiz = "";
let doc = "";

test("the teacher sends a test as homework; the student takes it, answers and replies", async ({ page }) => {
  // Both have identities and know each other (cards exchanged, fingerprints checked).
  await openKernel(page, a);
  await rpc(page, a, "identity.create", { name: "Teacher Zhang" });
  await rpc(page, a, "identity.exportCard", { path: path.join(base, "zhang.odid") });
  await rpc(page, a, "plugin.grantFolder", { plugin: I, path: outA });
  await openKernel(page, b);
  await rpc(page, b, "identity.create", { name: "Li Ming" });
  await rpc(page, b, "identity.exportCard", { path: path.join(base, "li.odid") });
  await rpc(page, b, "plugin.grantFolder", { plugin: I, path: outB });
  const zhang = (await rpc<{ id: string }>(page, b, "contact.importCard", { path: path.join(base, "zhang.odid") })).id;
  await rpc(page, b, "contact.setChecked", { id: zhang, checked: true });
  await make(page, b, `${I}:inbox`, null, { name: "Letters received" });

  await openKernel(page, a);
  toB = (await rpc<{ id: string }>(page, a, "contact.importCard", { path: path.join(base, "li.odid") })).id;
  await rpc(page, a, "contact.setChecked", { id: toB, checked: true });
  quiz = await make(page, a, `${X}:test`, null, { name: "Unit 1 quiz", "body.timing": "submit" });
  await make(page, a, `${X}:question`, quiz, { name: "Times", "body.type": "fill", "body.stem": "7 × 8 = {{?}}", "body.answers": "56", "body.rule": "number" });
  const outbox = await make(page, a, `${I}:outbox`, null, { name: "Letters sent" });
  await make(page, a, `${I}:sent`, outbox, { name: "Homework 1", "body.subject": "Homework 1", "body.comment": "Please hand in by Friday.", "body.due": "2099-12-01", "body.to": [{ who: toB }], "body.pages": [{ page: quiz, task: "answer" }] });
  await page.reload();
  await open(page, "Homework 1");
  await expect(page.getByRole("textbox", { name: "Subject" })).toHaveValue("Homework 1", { timeout: 15_000 });
  await shot(page, "compose");
  await action(page, "Send…").click();
  await expect.poll(() => letters(outA), { timeout: 30_000 }).toEqual(["Homework 1.odletter"]);
  await expect(page.getByText(/Answers: 0 of 1/).first()).toBeVisible({ timeout: 15_000 });

  // The student takes it: signed by the teacher, checked; then it is in the register.
  await openKernel(page, b);
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("menuitem", { name: "Import file…" }).click();
  await page.getByRole("textbox", { name: "Package file" }).fill(path.join(outA, "Homework 1.odletter"));
  await page.getByRole("button", { name: "Look inside" }).click();
  const dialog = page.getByRole("dialog", { name: /Letter: Homework 1/ });
  await expect(dialog).toContainText("Teacher Zhang (checked)", { timeout: 15_000 });
  await expect(dialog).toContainText("Please hand in by Friday.");
  await expect(dialog).toContainText("Due: 2099-12-01");
  await shot(page, "take");
  await dialog.getByRole("button", { name: "Take it" }).click();
  await expect(page.getByText(/What is asked of you/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row", { name: /Unit 1 quiz Answer To do/ })).toBeVisible();
  // Answer the test (the copy in the letter).
  await open(page, "Unit 1 quiz");
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await page.getByRole("textbox", { name: "（1）" }).fill("56");
  await action(page, "Hand in").click();
  await expect(page.getByText(/1\/1|1 \/ 1/).first()).toBeVisible({ timeout: 15_000 });
  // Back to the letter: done; reply.
  await open(page, "Homework 1");
  await expect(page.getByRole("row", { name: /Unit 1 quiz Answer Done: Handed in, 1\/1/ })).toBeVisible({ timeout: 15_000 });
  await action(page, "Reply…").click();
  await expect.poll(() => letters(outB), { timeout: 30_000 }).toEqual(["Homework 1-reply.odletter"]);
  await shot(page, "letter");
});

test("the teacher takes the reply: who answered and how; the attempt is filed", async ({ page }) => {
  await openKernel(page, a);
  await takeFile(page, path.join(outB, "Homework 1-reply.odletter"), /Reply to “Homework 1”/, "Take the reply");
  await expect(page.getByText(/Answers: 1 of 1/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row", { name: /Li Ming .*Handed in, 1\/1/ })).toBeVisible();
  await shot(page, "answered");
  // Filed among the learning records, in a folder of its own.
  const tree = await rpc<{ id: string }[]>(page, a, "tree.list");
  const records = tree.find((t) => t.id.endsWith(":records"))!.id;
  const top = (await rpc<{ nodes: Node[] }>(page, a, "tree.children", { tree: records })).nodes;
  const folder = top.find((n) => n.label === "Answers by letter")!;
  const kids = (await rpc<{ nodes: Node[] }>(page, a, "tree.children", { tree: records, parent: folder.key })).nodes;
  expect(kids.map((n) => n.label)).toEqual(["Li Ming · Unit 1 quiz"]);
});

test("a document sent for review: reviewed, signed, sent back, listed on the sender's document", async ({ page }) => {
  await openKernel(page, a);
  const env = (await rpc<{ nodes: Node[] }>(page, a, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await rpc(page, a, "params.set", { node: env, name: "Signer", value: "Zhang" });
  const tpl = await make(page, a, `${D}:template`, null, { name: "Leave template", "body.text": "Leave from {{?From | text}}" });
  doc = await make(page, a, `${D}:document`, null, { name: "Leave request", "body.template": tpl, "body.v.From": "Monday" });
  const outbox = (await rpc<{ nodes: Node[] }>(page, a, "tree.children", { tree: "resources" })).nodes.find((n) => n.label === "Letters sent")!.key;
  const sent = await make(page, a, `${I}:sent`, outbox, { name: "Please review", "body.subject": "Please review", "body.to": [{ who: toB }], "body.pages": [{ page: doc, task: "sign" }] });
  await page.reload();
  await open(page, "Please review");
  await action(page, "Send…").click();
  await expect.poll(() => letters(outA).includes("Please review.odletter"), { timeout: 30_000 }).toBe(true);
  void sent;

  await openKernel(page, b);
  const envB = (await rpc<{ nodes: Node[] }>(page, b, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await rpc(page, b, "params.set", { node: envB, name: "Signer", value: "Director Li" });
  await takeFile(page, path.join(outA, "Please review.odletter"), /Letter: Please review/, "Take it");
  await expect(page.getByRole("row", { name: /Leave request Review and sign To do/ })).toBeVisible({ timeout: 15_000 });
  await open(page, "Leave request");
  await page.getByRole("combobox", { name: "Decision" }).click();
  await page.getByRole("option", { name: "Agree", exact: true }).click();
  await page.getByRole("textbox", { name: "Opinion" }).fill("Approved");
  await action(page, "Review").click();
  await expect(page.getByText(/Reviewed: Agree/).first()).toBeVisible({ timeout: 15_000 });
  await open(page, "Please review");
  await expect(page.getByRole("row", { name: /Leave request Review and sign Done: Agree/ })).toBeVisible({ timeout: 15_000 });
  await action(page, "Reply…").click();
  await expect.poll(() => letters(outB).includes("Please review-reply.odletter"), { timeout: 30_000 }).toBe(true);

  await openKernel(page, a);
  await takeFile(page, path.join(outB, "Please review-reply.odletter"), /Reply to “Please review”/, "Take the reply");
  await expect(page.getByText(/Answers: 1 of 1/).first()).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await open(page, "Leave request");
  await expect(page.getByText(/Li Ming: Agree — Approved \(signature valid, checked\)/)).toBeVisible({ timeout: 15_000 });
  await shot(page, "reviewed");
});
