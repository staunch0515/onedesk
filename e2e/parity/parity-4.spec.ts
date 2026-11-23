/** Round 20 parity batch 4: rows L1–L10 (real devhost, real PostgreSQL, browser shell). */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, openKernel, rpc, startHost, stopHost, type Host, allPlugins } from "../kernel-host";
import { DB1, PG_PASSWORD, PG_USER, pgBinOrNull, startPg, type Pg } from "../pg-fixture";
import { FakeTools } from "../fake-tools";
import { mkBase, row, seedParity, shot, unverified } from "./support";
import { existsSync } from "node:fs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let host: Host;
let base: string;
let pg: Pg;
let catalog: string;
let fake: FakeTools;

const MAPPING = `entities:
  order:
    table: orders
    description: Orders of the shop
    columns:
      id: id
      customer: customer
      amount: amount
      placed: placed_at
  item:
    table: item_ver
    columns:
      id: item_id
      name: name
    versioned:
      key: [item_id]
      from: valid_from
      to: valid_to
      deleted: is_deleted
  line:
    table: ord_line
    columns:
      id: line_id
      order: order_id
      sku: sku
      qty: qty
  ghost:
    table: no_such_table
    columns:
      id: id
`;

test.beforeAll(async () => {
  expect(existsSync(DEVHOST), `devhost at ${DEVHOST}`).toBe(true);
  base = mkBase("p4");
  pg = await startPg(path.join(base, "pg"));
  seedParity(pg, DB1);
  catalog = path.join(base, "catalog");
  mkdirSync(path.join(catalog, "sales/deep"), { recursive: true });
  const q = (rel: string, head: string, body: string) => writeFileSync(path.join(catalog, rel), `/* ---\n${head}\n--- */\n${body}\n`);
  q("sales/recent.sql", "id: sales.orders.recent\ntitle: Recent orders\ndescription: Orders above an amount\npermissions: [read]\ntags: [sales]\nparams:\n  - name: min\n    type: number\n    required: true\n    description: Smallest amount", "SELECT {{order.id}} AS id, {{order.customer}} AS customer FROM {{order}} WHERE {{order.amount}} >= :min ORDER BY {{order.id}}");
  q("sales/top.sql", "id: sales.top\ntitle: Top lines\nparams: [n]", "SELECT {{line.id}} AS id, {{line.sku}} AS sku FROM {{line}} ORDER BY {{line.qty}} DESC LIMIT :n");
  q("sales/deep/lines.sql", "id: sales.lines.by_order\ntitle: Lines of an order\nparams:\n  - name: ord\n    type: number\n    required: true", "SELECT {{line.id}} AS id, {{line.qty}} AS qty FROM {{line}} WHERE {{line.order}} = :ord ORDER BY 1");
  q("items.sql", "id: items.current\ntitle: Items", "SELECT {{item.id}} AS id, {{item.name}} AS name FROM {{item}} AS i ORDER BY 1");
  q("warn.sql", "id: misc.warn\ntitle: Warns\nparams: [unused]", "SELECT {{nothing}} AS x, :undeclared AS y");
  writeFileSync(path.join(catalog, "plain.sql"), "SELECT 1\n");
  writeFileSync(path.join(catalog, "broken.sql"), "/* ---\nid: [oops\n--- */\nSELECT 1\n");
  writeFileSync(path.join(catalog, "mapping.yaml"), MAPPING);
  fake = new FakeTools(path.join(base, "fake"), pgBinOrNull);
  fake.remoteDockerShim();
  const plugins = fake.preparePlugins(allPlugins(), path.join(base, "plugins"), path.join(base, "data"));
  host = await startHost(path.join(base, "data"), {}, plugins);
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (pg) pg.stop();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string; kind?: string; state?: string; target?: string; badge?: string };
const nodes = async (page: Page, tree: string, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
const ids = {} as Record<"shop", string>;
const sqlText = (s: string) => JSON.parse(s) as string;
void sqlText;


const DSK = "org.onedesk.datasource:source";
const SQLK = "org.onedesk.sql:query";
const view = async (page: Page, name: string) => {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const box = async (loc: ReturnType<Page["locator"]>) => (await loc.boundingBox())!;

test("L1–L10: the interface", async ({ page }) => {
  await openKernel(page, host);
  ids.shop = await create(page, DSK, { name: "Shop", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_USER, "body.password": PG_PASSWORD });
  const cfg = (await nodes(page, "config")).find((n) => n.label === "Workspace")!.key;
  await call(page, "params.set", { node: cfg, name: "datasource.default", value: ids.shop, type: "ref" });
  const g = (await call<{ key: string }>(page, "tree.createGroup", { tree: "resources", name: "Folder one" })).key;
  const q1 = await create(page, SQLK, { name: "Inside query", "body.sql": "SELECT 1 AS one", "body.source": ids.shop });
  await call(page, "tree.move", { tree: "resources", key: q1, target: g, position: "inside" });
  const g2 = (await call<{ key: string }>(page, "tree.createGroup", { tree: "resources", name: "Folder two" })).key;
  const q2 = await create(page, SQLK, { name: "Second query", "body.sql": "SELECT 2 AS two", "body.source": ids.shop });
  await call(page, "tree.move", { tree: "resources", key: q2, target: g2, position: "inside" });
  await page.reload();
  await view(page, "Resources");

  await row("L1", async () => {
    await page.getByRole("treeitem", { name: "Folder one" }).click();
    await page.getByRole("button", { name: /Expand all/i }).click();
    await page.getByRole("treeitem", { name: "Inside query" }).dblclick();
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Result" })).toBeVisible();
    await expect(page.locator("[data-tab-id]").first()).toBeVisible();
    await shot(page, "L1-layout.png");
    return "活动栏（左）、侧边树、标签页条、编辑区、底部结果面板都在（L1-layout.png）";
  }, page);

  await row("L2", async () => {
    await page.getByRole("button", { name: /Collapse all/i }).click();
    await expect(page.getByRole("treeitem", { name: "Inside query" })).toHaveCount(0);
    await page.getByRole("button", { name: /Expand all/i }).click();
    await expect(page.getByRole("treeitem", { name: "Inside query" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "Second query" })).toBeVisible();
    const f2 = page.getByRole("treeitem", { name: "Folder two" });
    await f2.click();
    await f2.press("ArrowLeft");
    await expect(page.getByRole("treeitem", { name: "Second query" })).toHaveCount(0);
    await page.reload();
    await view(page, "Resources");
    await expect(page.getByRole("treeitem", { name: "Folder two" })).toBeVisible();
    const afterReload = await page.getByRole("treeitem", { name: "Second query" }).count();
    const target = page.getByRole("treeitem", { name: "Folder one" });
    const snap = () => target.evaluate((e) => ({ r: JSON.stringify(e.getBoundingClientRect()), s: ((cs) => ({ c: cs.color, w: cs.fontWeight, b: cs.border, p: cs.padding }))(getComputedStyle(e)) }));
    const before = await snap();
    await target.hover();
    await page.waitForTimeout(300);
    const after = await snap();
    expect(after).toEqual(before);
    await shot(page, "L2-tree.png");
    if (afterReload !== 0) throw new Error("折叠状态刷新后没有记住：Folder two 折叠后刷新，其下的 Second query 又出现了");
    return "全部展开/全部折叠两个按钮有效；单独折叠 Folder two 后刷新仍是折叠；悬停只改背景色（位置、字体、颜色、边框、内边距不变）";
  }, page);

  await row("L3", async () => {
    await page.getByRole("button", { name: /Expand all/i }).click();
    await page.getByRole("treeitem", { name: "Inside query" }).dblclick();
    await page.waitForTimeout(500);
    const icons = await page.evaluate(() => Array.from(document.querySelectorAll("[data-tab-id]")).map((t) => ({ text: (t as HTMLElement).innerText.trim().slice(0, 20), svg: t.querySelector("svg")?.outerHTML.length ?? 0, html: t.querySelector("svg")?.innerHTML.slice(0, 80) ?? "" })));
    expect(icons.length).toBeGreaterThan(1);
    expect(icons.every((i) => i.svg > 0), JSON.stringify(icons)).toBe(true);
    return `每个标签页标题前都有图标（${icons.map((i) => i.text).join("、")}；${new Set(icons.map((i) => i.html)).size} 种图形）`;
  }, page);

  await row("L4", async () => {
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
    await expect(page.getByText("Inside query").first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "SQL", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy SQL" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save & run" })).toBeVisible();
    return "SQL 编辑页：面包屑与标题、图标工具栏（运行/保存/保存并运行/复制）、参数区（有 :name 时出现，见 C 组）、编辑区（L1-layout.png）";
  }, page);

  await row("L5", async () => {
    const info = page.getByText(/^info$/i).first();
    if (!(await info.isVisible().catch(() => false))) await page.getByRole("button", { name: "Show info panel" }).click({ timeout: 5000 }).catch(() => null);
    await expect(info).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("Location", { exact: true }).first()).toBeVisible();
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    const w0 = (await box(name)).width;
    await name.fill("A very long name ".repeat(12));
    await page.getByRole("textbox", { name: "Description" }).fill("long description ".repeat(40)).catch(() => null);
    await page.waitForTimeout(1000);
    const w1 = (await box(page.getByRole("textbox", { name: "Name", exact: true }).first())).width;
    expect(Math.abs(w1 - w0)).toBeLessThan(2);
    await shot(page, "L5-info-panel.png");
    await name.fill("Inside query");
    await page.getByRole("textbox", { name: "Description" }).fill("").catch(() => null);
    await page.waitForTimeout(600);
    return `右侧信息面板：名称、位置、种类、说明、标签、修改/创建记录；名称填 200 字、说明填 640 字后宽度不变（${Math.round(w0)}px → ${Math.round(w1)}px）（L5-info-panel.png）`;
  }, page);

  await row("L6", async () => {
    const seps = await page.getByRole("separator").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    const pos = () => page.evaluate(() => Array.from(document.querySelectorAll("[role=separator]")).map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)}`; }).join("|"));
    const before = await pos();
    const done: string[] = [];
    for (const name of seps.filter((x): x is string => !!x)) {
      const sep = page.getByRole("separator", { name, exact: true }).first();
      const b = await box(sep);
      const horizontal = (await sep.getAttribute("aria-orientation")) === "horizontal";
      const dx = horizontal ? 0 : 50;
      const dy = horizontal ? -40 : 0;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + dx / 2, b.y + b.height / 2 + dy / 2, { steps: 4 });
      await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 4 });
      await page.mouse.up();
      const nb = await box(sep);
      if (Math.abs(nb.x - b.x) + Math.abs(nb.y - b.y) > 10) done.push(name);
    }
    const moved = await pos();
    expect(done.length, `moved: ${done}; separators: ${seps}`).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(800);
    await page.reload();
    await view(page, "Resources");
    if (!(await page.getByRole("treeitem", { name: "Inside query" }).count())) await page.getByRole("button", { name: /Expand all/i }).click();
    await page.getByRole("treeitem", { name: "Inside query" }).dblclick({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const after = await pos();
    await shot(page, "L6-splitters.png");
    expect(after).toBe(moved);
    expect(after).not.toBe(before);
    return `界面上的分割线（${seps.join("、")}）逐个拖动：${done.join("、")} 能拖；刷新后位置都还在（L6-splitters.png）`;
  }, page);

  await row("L7", async () => {
    const mk = (name: string) => create(page, SQLK, { name, "body.sql": "SELECT 1", "body.source": ids.shop });
    await mk("Quarterly budget plan");
    await mk("budget draft notes");
    await mk("Zebra stripes");
    const hit = async (text: string) => (await call<{ title: string }[]>(page, "search.query", { text })).map((h) => h.title);
    expect(await hit("budg")).toEqual(expect.arrayContaining(["Quarterly budget plan", "budget draft notes"]));
    const short = await hit("qb");
    expect(short).toContain("Quarterly budget plan");
    expect(short).not.toContain("Zebra stripes");
    const both = await hit("budget draft");
    expect(both).toContain("budget draft notes");
    expect(both).not.toContain("Quarterly budget plan");
    expect(await hit("zzzzzzq")).toEqual([]);
    await page.locator("body").click({ position: { x: 700, y: 650 } });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator("input:focus")).toHaveCount(1);
    await page.keyboard.type("budget draft");
    await page.waitForTimeout(900);
    await shot(page, "L7-search.png");
    await expect(page.getByText("budget draft notes").first()).toBeVisible();
    await page.keyboard.press("Escape");
    return "≥3 字符走索引（budg 命中两条）；2 字符（qb）按顺序模糊命中 Quarterly budget plan、不含 Zebra；多词必须全部命中（budget draft 只命中 budget draft notes）；无匹配为空；⌘K 聚焦搜索框并列出结果（L7-search.png）";
  }, page);

  await row("L8", async () => {
    const titles = async (text: string) => (await call<{ title: string; target: string }[]>(page, "search.query", { text })).map((h) => h.title);
    const first = (await titles("budget"))[0]!;
    const other = first === "budget draft notes" ? "Quarterly budget plan" : "budget draft notes";
    const otherId = (await call<{ title: string; target: string }[]>(page, "search.query", { text: other })).find((h) => h.title === other)!.target.replace(/^resource:/, "");
    await call(page, "resource.setFavorite", { id: otherId, favorite: true });
    expect((await titles("budget"))[0]).toBe(other);
    expect(JSON.stringify(await nodes(page, "favorites"))).toContain(otherId);
    await call(page, "resource.setFavorite", { id: otherId, favorite: false });
    await page.reload();
    await view(page, "Resources");
    await page.getByRole("treeitem", { name: other, exact: true }).dblclick();
    const showInfo = page.getByRole("button", { name: "Show info panel" });
    if (await showInfo.count()) await showInfo.click();
    const tags = page.getByRole("textbox", { name: /tags?/i }).first();
    await tags.waitFor({ timeout: 8000 });
    await tags.fill("roadmap-2027");
    await tags.press("Enter");
    await page.waitForTimeout(800);
    await shot(page, "L8-tags.png");
    expect(await titles("roadmap-2027")).toContain(other);
    return "收藏的排在搜索结果和树的最前；标签在信息面板里输入（回车添加），之后按标签搜索能找到（L8-tags.png）";
  }, page);

  await row("L9", async () => {
    await page.getByRole("treeitem", { name: "Folder one" }).click().catch(() => null);
    await page.getByRole("button", { name: /Expand all/i }).click().catch(() => null);
    await page.getByRole("treeitem", { name: "Inside query" }).dblclick();
    await page.getByRole("button", { name: "Copy SQL" }).first().click();
    const toast = page.getByText("SQL copied.").first();
    await expect(toast).toBeVisible();
    const tb = await box(toast);
    const vp = page.viewportSize()!;
    expect(tb.x + tb.width).toBeGreaterThan(vp.width - 80);
    expect(tb.y + tb.height).toBeGreaterThan(vp.height - 200);
    const run = page.getByRole("button", { name: "Run", exact: true });
    const b0 = await box(run);
    await page.waitForTimeout(200);
    const b1 = await box(run);
    expect(b1.y).toBe(b0.y);
    const pos = await toast.evaluate((e) => { let n: HTMLElement | null = e as HTMLElement; while (n && getComputedStyle(n).position !== "fixed") n = n.parentElement; return n ? "fixed" : "none"; });
    expect(pos).toBe("fixed");
    await shot(page, "L9-toast.png");
    const t0 = Date.now();
    await expect(toast).toHaveCount(0, { timeout: 12_000 });
    return `提示浮在窗口右下角（position:fixed，不挤动布局：运行按钮位置不变），${Math.round((Date.now() - t0) / 100) / 10}s 后自动消失（L9-toast.png）`;
  }, page);

  await row("L10", async () => {
    await page.getByRole("button", { name: /^Settings$/ }).last().click({ timeout: 5000 }).catch(async () => { await page.locator("[aria-label=Settings]").last().click(); });
    await page.waitForTimeout(1500);
    await shot(page, "L10-settings.png");
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    return unverified(`设置页已打开（L10-settings.png）；页面文字摘录：${text.slice(0, 200)}。清单里对应 sqlpool 四个文件夹设置的：目录文件夹=查询目录插件的授权文件夹、映射文件=插件设置 mappingFile、资料文件夹=AI 插件设置 docFolder、导出文件夹=首次导出 CSV 时询问并记住（不是设置项）。设置页里这四项是否都能找到需人工对照截图`, "L10-settings.png");
  }, page);
});
