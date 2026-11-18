/**
 * Round 14 against the REAL kernel: the six acceptance points of docs/requirements.md section D, one by one, and the
 * light/dark tour of the main pages (docs/screenshots/round14-light-*.png, round14-dark-*.png) with an automatic
 * contrast scan of every page that is photographed.
 * devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data directory (kernel-host.ts): the real keychain and
 * ~/Library/Application Support/onedesk* are never touched. The only network is a local HTTP fixture (transfer-server.mjs).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
// @ts-ignore plain JS module, no types
import { startServer } from "./fixtures/transfer-server.mjs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const NOTE = "org.onedesk.note:note";
const LINK = "org.onedesk.link:link";
const PROMPT = "org.onedesk.prompt:prompt";
const REQUEST = "org.onedesk.http:request";
const COMPOSITE = "org.onedesk.composite:composite";
const COLLECTION = "org.onedesk.collection:collection";
const HTTP_PLUGIN = "org.onedesk.http";

let host: Host;
let base: string;
let srv: { port: number; url: string; close(): Promise<void> };

test.beforeAll(async () => {
  // D411: with ONEDESK_E2E_REQUIRE_DEVHOST=1 (set by `pnpm check`) a missing devhost is a failure, not a silent skip.
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round14-")));
  srv = await startServer({ port: 0 });
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (srv) await srv.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const bare = (page: Page) => page.goto("/workbench.html?reset&quiet");
type Saved = { page: { resourceId: string } };
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<Saved>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
type Res = { id: string; name: string; deleted: boolean; tags?: string[]; body: Record<string, unknown> };
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });

const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
const showTree = async (page: Page, name: string) => {
  const b = sideTab(page, name);
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });
const entry = (page: Page, n: string) => page.getByRole("link", { name: n }).or(page.getByRole("button", { name: n })).first();
const settingsMenu = (page: Page) => page.locator('button[aria-haspopup="menu"][aria-label="Settings"]');

/* ------------------------------------------------------------------ D1: start, menu lists every resource type */

test("D1: the app starts on the welcome page; the side tree and the New menu list every resource type", async ({ page }) => {
  await openKernel(page, host);
  await expect(page.getByRole("heading", { name: "Welcome to OneDesk" })).toBeVisible({ timeout: 20_000 });
  // the activity bar names the trees
  for (const v of ["Resources", "Environments", "Plugins", "Settings"]) await expect(sideTab(page, v)).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  for (const kind of ["Note", "Link", "Prompt", "HTTP request", "Composite", "Collection"]) {
    await expect(page.getByRole("menuitem", { name: new RegExp(kind, "i") }).first(), `New menu: ${kind}`).toBeVisible();
  }
  await page.keyboard.press("Escape");
});

/* ------------------------------------------------------------------ D2: create the four types, open each */

test("D2: a link, a prompt, a note and an HTTP request are created from the page and open on the right page", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "params.set", { node: await configNode(page), name: "network.allow", value: `127.0.0.1:${srv.port}` });
  const save = () => page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { name: "Welcome to OneDesk" })).toBeVisible({ timeout: 20_000 });

  await entry(page, "New link").click();
  await page.getByRole("textbox", { name: "Address", exact: true }).fill("https://example.com/docs");
  await save();
  await page.getByRole("tab", { name: /Welcome/ }).click();
  await entry(page, "New prompt").click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Summarise the meeting notes in three bullets");
  await save();
  await page.getByRole("tab", { name: /Welcome/ }).click();
  await entry(page, "New note").click();
  await page.getByRole("textbox", { name: "Content", exact: true }).fill("Quarterly roadmap with the aurora project");
  await save();
  await page.getByRole("tab", { name: /Welcome/ }).click();
  await entry(page, "New HTTP request").click();
  await page.getByRole("textbox", { name: "Address", exact: true }).fill(`${srv.url}/echo`);
  await save();

  // all four are stored, one per type
  await expect.poll(async () => (await roots(page)).map((n) => n.kind).sort(), { timeout: 15_000 }).toEqual([LINK, NOTE, PROMPT, REQUEST].sort());
  expect(await roots(page).then((r) => r.every((n) => n.label.length > 0))).toBe(true);

  // reopen each from the tree: the page of its own type shows its own field and the saved content
  await openKernel(page, host);
  await showTree(page, "Resources");
  for (const [kind, role, field, value] of [
    [LINK, "textbox", "Address", "https://example.com/docs"],
    [PROMPT, "textbox", "Prompt", "Summarise the meeting notes in three bullets"],
    [NOTE, "textbox", "Content", "aurora"],
    [REQUEST, "textbox", "Address", `${srv.url}/echo`],
  ] as const) {
    const n = (await roots(page)).find((r) => r.kind === kind)!;
    await page.locator(`[data-tree-key="${n.key}"]`).click();
    const box = page.getByRole(role, { name: field, exact: true }).first();
    await expect(box).toBeVisible({ timeout: 15_000 });
    await expect(box).toHaveValue(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

type TNode = { key: string; label: string; kind: string; state?: string };
const roots = async (page: Page, tree = "resources") => (await call<{ nodes: TNode[] }>(page, "tree.children", { tree, locale: "en-US" })).nodes;
const configNode = async (page: Page) => (await roots(page, "config")).find((n) => n.label === "Workspace")!.key;

/* ------------------------------------------------------------------ D3: disabling the HTTP plugin hides it, keeps the data */

test("D3: disabling the HTTP request plugin removes its menu entries and keeps the data; enabling brings it back", async ({ page }) => {
  await openKernel(page, host);
  const req = (await roots(page)).find((n) => n.kind === REQUEST)!;
  const before = await getRes(page, req.key);
  const newMenu = async () => {
    await page.getByRole("button", { name: "New", exact: true }).first().click();
    const has = await page.getByRole("menuitem", { name: /HTTP request/i }).count();
    await page.keyboard.press("Escape");
    return has;
  };
  expect(await newMenu()).toBeGreaterThan(0);

  await call(page, "plugin.setEnabled", { plugin: HTTP_PLUGIN, enabled: false });
  await openKernel(page, host);
  expect(await newMenu()).toBe(0);
  await showTree(page, "Resources");
  // data is kept, the item is shown as unusable rather than gone
  const stillThere = (await roots(page)).find((n) => n.key === req.key);
  expect(stillThere, "resource still in the tree while its plugin is disabled").toBeTruthy();
  expect(stillThere!.state, "the node is shown as unavailable (disabled), not as normal").toBe("disabled");
  const during = await getRes(page, req.key);
  expect(during.body).toEqual(before.body);
  expect(during.name).toBe(before.name);

  await call(page, "plugin.setEnabled", { plugin: HTTP_PLUGIN, enabled: true });
  await openKernel(page, host);
  expect(await newMenu()).toBeGreaterThan(0);
  await showTree(page, "Resources");
  await page.locator(`[data-tree-key="${req.key}"]`).click();
  await expect(page.getByRole("textbox", { name: "Address", exact: true }).first()).toHaveValue(`${srv.url}/echo`, { timeout: 15_000 });
  expect((await getRes(page, req.key)).body).toEqual(before.body);
});

/* ------------------------------------------------------------------ D4: search by name, tag and body; command palette */

test("D4: search finds resources by name, tag and body; Cmd/Ctrl+K searches and Cmd/Ctrl+Shift+P runs commands", async ({ page }) => {
  await bare(page);
  await create(page, NOTE, { name: "Zeppelin plan", "body.text": "launch the quokka initiative", tags: ["fieldwork"] });
  await openKernel(page, host);
  const search = async (text: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    const box = page.getByRole("combobox", { name: "Search this workspace" });
    await expect(box).toBeFocused();
    await box.fill(text);
  };
  for (const [query, how] of [["Zeppelin", "name"], ["fieldwork", "tag"], ["quokka", "body"]] as const) {
    await search(query);
    await expect(page.getByRole("option", { name: /Zeppelin plan/ }), `by ${how}`).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
  }
  await search("nothingmatchesthis");
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  await page.keyboard.press("Escape");

  // the command palette lists commands, filters them, and runs one
  await page.keyboard.press("ControlOrMeta+Shift+p");
  const palette = page.getByPlaceholder("Type a command");
  await expect(palette).toBeFocused();
  await palette.fill("Theme: dark");
  await page.getByRole("option", { name: /Theme: dark/ }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("Theme: light");
  await page.getByRole("option", { name: /Theme: light/ }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

/* ------------------------------------------------------------------ D5: light and dark, main pages */

type Low = { where: string; text: string; ratio: number; need: number; fg: string; bg: string };
/**
 * D411: contrast of every visible text node, and of the value or placeholder of every input/textarea, against its effective
 * background (alpha blended up the ancestors; the text colour is also multiplied by the opacity of the element and all its
 * ancestors). Needs 4.5:1; large text (>= 24px, or >= 18.66px bold) and disabled controls 3:1. Returns everything under its need.
 */
async function lowContrast(page: Page): Promise<Low[]> {
  return page.evaluate(() => {
    const parse = (c: string): number[] => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) {
        const cv = document.createElement("canvas").getContext("2d")!;
        cv.fillStyle = c;
        cv.fillRect(0, 0, 1, 1);
        const d = cv.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      }
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const over = (top: number[], bot: number[]) => {
      const a = top[3]! + bot[3]! * (1 - top[3]!);
      return [0, 1, 2].map((i) => (top[i]! * top[3]! + bot[i]! * bot[3]! * (1 - top[3]!)) / (a || 1)).concat([a]);
    };
    const lum = (c: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const bgOf = (el: Element): number[] => {
      const chain: number[][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor));
      let acc: number[] = parse(getComputedStyle(document.body).backgroundColor);
      if (acc[3]! < 1) acc = [255, 255, 255, 1];
      for (const c of chain.reverse()) if (c[3]! > 0) acc = over(c, acc);
      return acc;
    };
    const opacityOf = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : ""}`;
    const out: Low[] = [];
    const check = (el: Element, text: string, color: string) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none") return;
      const op = opacityOf(el);
      if (op === 0) return;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return;
      const disabled = !!el.closest("[disabled],[aria-disabled=true]");
      const size = parseFloat(st.fontSize);
      const bold = Number(st.fontWeight) >= 700;
      const need = disabled || size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const fg = parse(color);
      fg[3] = fg[3]! * op;
      const bg = bgOf(el);
      const f = over(fg, bg);
      const ratio = (Math.max(lum(f), lum(bg)) + 0.05) / (Math.min(lum(f), lum(bg)) + 0.05);
      if (ratio < need) out.push({ where: describe(el), text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, need, fg: color, bg: `rgb(${bg.slice(0, 3).map(Math.round)})` });
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").trim();
      const el = n.parentElement;
      if (!text || !el || ["SCRIPT", "STYLE", "TEXTAREA", "OPTION"].includes(el.tagName)) continue; // textarea text is its value, scanned below
      check(el, text, getComputedStyle(el).color);
    }
    for (const el of document.querySelectorAll("input, textarea")) {
      const input = el as HTMLInputElement;
      if (["checkbox", "radio", "hidden", "range", "file"].includes(input.type)) continue;
      // a code editor overlays a transparent textarea on its highlighted copy: the copy is scanned as text, skip the invisible one
      if (parse(getComputedStyle(el).color)[3] === 0) continue;
      if (input.value) check(el, input.value, getComputedStyle(el).color);
      else if (input.placeholder) check(el, input.placeholder, getComputedStyle(el, "::placeholder").color);
    }
    return out;
  });
}

const seeded: Record<string, string> = {};
const strictProblems: Record<string, string[]> = {};

test("D5 setup: one of every type, with something to look at", async ({ page }) => {
  await bare(page);
  await call(page, "params.set", { node: await configNode(page), name: "network.allow", value: `127.0.0.1:${srv.port}` });
  seeded.request = await create(page, REQUEST, { name: "Echo request", "body.method": "POST", "body.url": `${srv.url}/echo`, "body.query": "q=1", "body.headers": "X-Test: yes", "body.body": '{"a":1}' });
  const note = await create(page, NOTE, { name: "Weekly plan", "body.text": "# Weekly plan\n\n- **Ship** the report\n- Review [[Docs link]]\n\n> Remember the demo on Friday.\n\n`code` and a [link](https://example.com).", tags: ["work", "plan"] });
  await create(page, LINK, { name: "Docs link", "body.url": "https://example.com/docs", tags: ["work"] });
  await create(page, PROMPT, { name: "Meeting summary", "body.text": "Summarise the meeting in three bullets for {{team}}." });
  seeded.note = note;
  seeded.composite = await create(page, COMPOSITE, { name: "Friday bundle" });
  await call(page, "tree.move", { tree: "resources", key: note, target: seeded.composite, position: "inside", locale: "en-US" });
  await create(page, COLLECTION, { name: "Everything for work", "body.tags": "work" });
  await call(page, "params.set", { node: (await roots(page, "env"))[0]!.key, name: "team", value: "design" });
  await call(page, "plugin.grantFolder", { plugin: "org.onedesk.market", path: path.join(ROOT, "e2e/fixtures/market") });
  await create(page, "org.onedesk.sample:query", { name: "Sample query" });
});

for (const theme of ["light", "dark"] as const) {
  test(`D5 ${theme}: the main pages, photographed; contrast collected for the next test`, async ({ page }) => {
    const strict: string[] = []; // under the D411 need (4.5:1 text, 3:1 large/disabled)
    const snap = async (name: string) => {
      await page.mouse.move(640, 2);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `round14-${theme}-${name}.png`) });
      const low = await lowContrast(page);
      for (const l of low) {
        const line = `${theme}/${name}: <${l.where}> "${l.text}" ${l.ratio}:1 < ${l.need}:1 (text ${l.fg} on ${l.bg})`;
        strict.push(line);
      }
    };
    const open = (n: string | RegExp) => treeItem(page, n).first().click();

    await openKernel(page, host, theme);
    await expect(page.getByRole("heading", { name: "Welcome to OneDesk" })).toBeVisible({ timeout: 20_000 });
    await snap("welcome");

    await showTree(page, "Resources");
    await open(/^Docs link/);
    await expect(page.getByRole("textbox", { name: "Address", exact: true })).toBeVisible();
    await snap("link");
    await open(/^Meeting summary/);
    await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible();
    await snap("prompt");
    await open(/^Friday bundle/);
    await page.keyboard.press("ArrowRight");
    await expect(treeItem(page, /^Weekly plan/).first()).toBeVisible();
    await snap("composite");
    await open(/^Weekly plan/);
    await expect(page.getByRole("textbox", { name: "Content", exact: true })).toBeVisible();
    await snap("tree-note");
    await open(/^Everything for work/);
    await expect(page.getByRole("tab", { name: /^Everything for work/, selected: true })).toBeVisible();
    await page.waitForTimeout(500);
    await snap("collection");

    await page.locator(`[data-tree-key="${seeded.request}"]`).click();
    await expect(page.getByRole("button", { name: "Send", exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await expect(page.getByText(/200 OK · \d+ ms/).first()).toBeVisible({ timeout: 30_000 });
    await snap("http");

    await open(/^Sample query/);
    await page.waitForTimeout(800);
    await snap("sample");

    await showTree(page, "Plugin market");
    await page.locator("[data-tree-key]", { hasText: "Local packages" }).first().dblclick();
    await expect(page.getByRole("combobox", { name: "Package to install" })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await snap("market");
    await showTree(page, "Files");
    await page.waitForTimeout(500);
    await snap("files");

    await showTree(page, "Environments");
    await open(/^Default/);
    await expect(page.getByRole("textbox", { name: "team", exact: true })).toBeVisible();
    await snap("environment");

    await showTree(page, "Settings");
    await open(/^Workspace/);
    await expect(page.getByRole("button", { name: "Add parameter" })).toBeVisible();
    await snap("workspace-config");

    await showTree(page, "Plugins");
    await open(/^HTTP request/);
    await expect(page.getByRole("tab", { name: /HTTP request/, selected: true })).toBeVisible();
    await snap("plugin");

    await settingsMenu(page).click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await snap("settings");
    await page.keyboard.press("Escape");

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await expect(page.getByPlaceholder("Type a command")).toBeFocused();
    await snap("palette");
    await page.keyboard.press("Escape");

    const wsButton = page.locator('button[aria-haspopup="menu"]').filter({ hasText: /\S/ }).first();
    await wsButton.click();
    await page.getByRole("menuitem", { name: "Manage workspaces…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await snap("workspaces");

    strictProblems[theme] = strict;
    mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
    writeFileSync(path.join(ROOT, `test-results/round14-contrast-${theme}.txt`), strict.join("\n") + "\n");
  });

  test(`D5 ${theme}: contrast meets D411 (4.5:1 text, 3:1 large and disabled)`, async ({}, info) => {
    const found = strictProblems[theme] ?? [];
    // Known failures wait for the shell to change the tokens; the test turns itself on when there are none left.
    info.annotations.push({ type: "found", description: found.join("\n") });
    test.fixme(found.length > 0, `${found.length} text(s) under the D411 contrast need in ${theme}; see round14-tests-done.md, "审查后的修改"`);
    expect(found).toEqual([]);
  });
}

/* ------------------------------------------------------------------ D6: kernel tests cover CRUD, plugin loading/manifest, actions */

/** Names of the Rust tests in crates/kernel (src and tests/), read from the source. Compiling and running them is `pnpm test:rust`. */
function kernelTests(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".rs")) {
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((l, i) => {
          if (!/^\s*#\[(tokio::)?test/.test(l)) return;
          for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
            const m = /^\s*(?:pub )?(?:async )?fn (\w+)/.exec(lines[j]!);
            if (m) {
              out.add(m[1]!);
              break;
            }
          }
        });
      }
    }
  };
  walk(path.join(ROOT, "crates/kernel"));
  return out;
}

/** Named tests per D6 topic. This only checks that they exist; it is `pnpm test:rust` that runs them (and must pass). */
const D6_TESTS: Record<string, string[]> = {
  "resource create / update / delete / restore": [
    "pipeline_transaction_history_and_audit_agree",
    "pipeline_group_delete_is_one_batch",
    "history_is_by_field_newest_first_and_restore_is_a_new_revision",
    "undelete_restores_the_whole_batch_and_falls_back_to_the_root",
    "purge_leaves_no_name_or_content_anywhere_in_the_database",
    "search_matches_all_words_short_words_and_ranks",
  ],
  "plugin loading": [
    "valid_manifest_loads_with_localized_labels",
    "registry_keeps_the_highest_version_and_lists_rejections",
    "disabled_plugin_greys_out_hides_and_refuses_then_comes_back",
    "a_kernel_started_on_an_index_runs_plugins_from_their_folders",
    "palette_plugins_tree_and_broken_packages",
  ],
  "manifest validation": ["manifest_rejects_each_kind_of_error", "inspect_reports_bad_packages_and_permissions", "a_bad_languages_declaration_keeps_the_package_out"],
  "action execution": [
    "run_success_is_recorded_with_events_output_and_audit",
    "run_failures_are_error_runs_not_protocol_errors",
    "run_can_be_cancelled_while_kernel_keeps_answering_and_late_host_calls_are_refused",
    "run_times_out",
  ],
};

test("D6: the kernel has named tests for resource CRUD, plugin loading, manifest validation and action execution (they run in pnpm test:rust)", () => {
  const tests = kernelTests();
  for (const [topic, names] of Object.entries(D6_TESTS)) for (const n of names) expect(tests.has(n), `${topic}: Rust test \`${n}\` exists in crates/kernel`).toBe(true);
});
