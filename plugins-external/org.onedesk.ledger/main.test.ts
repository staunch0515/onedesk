import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin from "./main.js";
// @ts-ignore
import { sendOut, takeIn, writeLines, newPending, PAGE_LINES } from "./posting.js";
import { checkView, registry } from "../../plugins/_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const EN = locale("en-US");
const t = (key: string) => ({ "en-US": EN[key] ?? key, "zh-CN": ZH[key] ?? key });
const L = "org.onedesk.ledger";
const k = (s: string) => `${L}:${s}`;

type Res = { id: string; kind: string; name: string; parentId: string | null; body: Record<string, any>; stamps?: any[]; createdAt?: number };

/** A ledger book: setup, register, two items; the host a ledger's code gets. */
function world(method = "moving", items: Array<[string, string, number, number]> = [["screw", "螺丝 M6", 1000, 0.1], ["plate", "钢板", 10, 50]]) {
  const res = new Map<string, Res>();
  const order: string[] = [];
  const add = (r: Res) => {
    res.set(r.id, r);
    order.push(r.id);
  };
  add({ id: "bk", kind: "x.book:book", name: "原料库存账", parentId: null, body: {} });
  add({ id: "setup", kind: k("setup"), name: "启用表", parentId: "bk", body: { method, qtyDecimals: 2, amountDecimals: 2, closed: [], started: "2026-11-01" } });
  add({ id: "reg", kind: k("vouchers"), name: "单据簿", parentId: "bk", body: {} });
  for (const [id, name, q, p] of items) add({ id, kind: k("item"), name, parentId: "bk", body: { unit: "个", openQty: q, openPrice: p, min: 100 } });
  let next = 0;
  const opened: string[] = [];
  const files = new Map<string, string>();
  let failOn: string | null = null;
  const kids = (p: string) => order.filter((x) => res.get(x)?.parentId === p);
  const host = {
    params: { async get(n: string) { return n === "签名人" ? { found: true, value: "王会计", sourceName: "W" } : { found: false }; } },
    interfaces: {
      async list() { return [{ plugin: "x.book" }]; },
      async call(_i: string, action: string) {
        if (action === "roles") return { data: { kinds: [{ kind: "book", role: "book" }] } };
        return { data: { items: [] } };
      },
    },
    files: { async roots() { return [{ path: "/out" }]; }, async stat(p: string) { if (!files.has(p)) throw new Error("nf"); }, async writeText(p: string, s: string) { files.set(p, s); } },
    ui: { open: async (x: string) => void opened.push(x) },
    resources: {
      async get(id: string) { return res.has(id) ? structuredClone(res.get(id)) : null; },
      async search(o: { ids: string[] }) { return o.ids.map((id) => res.get(id)).filter(Boolean).map((r) => ({ id: r!.id, name: r!.name, kind: r!.kind, parent: r!.parentId })); },
      async list(o: { kind: string; parent?: string }) { return order.map((id) => res.get(id)).filter((r) => r && r.kind === k(o.kind) && (o.parent === undefined || r.parentId === o.parent)).map((r) => structuredClone(r)); },
      async tree(id: string) {
        const out: any[] = [];
        const walk = (p: string, depth: number) => {
          for (const x of kids(p)) {
            out.push({ id: x, kind: res.get(x)!.kind, name: res.get(x)!.name, depth });
            walk(x, depth + 1);
          }
        };
        walk(id, 1);
        return { nodes: out, next: null };
      },
      async create(o: { kind: string; name?: string; body?: any; parent?: string }) {
        const id = `n${++next}`;
        add({ id, kind: k(o.kind), name: o.name ?? o.kind, parentId: o.parent ?? null, body: structuredClone(o.body ?? {}), createdAt: next });
        return structuredClone(res.get(id));
      },
      async update(id: string, changes: Record<string, any>) {
        if (failOn === id) throw new Error("disk full");
        const r = res.get(id)!;
        if (r.stamps && r.stamps.length) throw Object.assign(new Error("denied"), { code: "denied", params: { reason: "stamped" } });
        for (const [key, v] of Object.entries(changes)) r.body[key.slice(5)] = structuredClone(v);
        return { rev: 2 };
      },
      async remove(id: string) {
        res.delete(id);
        order.splice(order.indexOf(id), 1);
      },
      async stamp(id: string, o: any) { const r = res.get(id)!; r.stamps = [...(r.stamps ?? []), { label: o.label, signer: o.signer, at: 1 }]; },
      async unstamp(id: string, o: any) { if (!o.reason) throw new Error("noReason"); res.get(id)!.stamps = []; },
    },
  };
  const ctx = (id: string | null, extra: Record<string, any> = {}) => ({ t, locale: "zh-CN", host, params: {}, resource: id ? structuredClone(res.get(id)) : null, ...extra });
  const voucher = (kind: string, date: string, lines: any[], extra: Record<string, any> = {}) => {
    const id = `v${++next}`;
    add({ id, kind: k(kind), name: id, parentId: "reg", body: { date, no: id, summary: "", lines, ...extra } });
    return id;
  };
  return { res, ctx, voucher, opened, files, setFail: (id: string | null) => (failOn = id) };
}

const P = registry(plugin);
async function auditPost(w: ReturnType<typeof world>, id: string, params: Record<string, string> = {}) {
  const a = await P.pages.voucher.onEvent(w.ctx(id, { params }), "audit");
  const p = await P.actions.post(w.ctx(id), {});
  return { a, p };
}
const bal = (w: ReturnType<typeof world>, id: string) => w.res.get(id)!.body.bal;
const lines = (w: ReturnType<typeof world>, item: string) =>
  [...w.res.values()].filter((r) => r.kind === k("sheet") && r.parentId === item).sort((a, b) => a.body.page - b.body.page).flatMap((s) => s.body.lines);

describe("costing (D487 §27.5)", () => {
  it("moving average: in, out, all of it", () => {
    const s = { method: "moving", qtyDecimals: 2, amountDecimals: 2 };
    let b = takeIn({ qty: 1000, amount: 100, layers: [] }, 500, 65, s);
    expect(b).toMatchObject({ qty: 1500, amount: 165 });
    const r = sendOut(b, 600, s);
    expect([r.amount, r.price, r.bal.qty, r.bal.amount]).toEqual([66, 0.11, 900, 99]);
    expect(sendOut(r.bal, 900, s).bal).toMatchObject({ qty: 0, amount: 0 });
  });

  it("first in, first out: across lots; taking back", () => {
    const s = { method: "fifo", qtyDecimals: 2, amountDecimals: 2 };
    const b = takeIn({ qty: 100, amount: 100, layers: [{ qty: 100, price: 1 }] }, 100, 200, s);
    const r = sendOut(b, 150, s);
    expect(r.amount).toBe(200);
    expect(r.bal.layers).toEqual([{ qty: 50, price: 2 }]);
    const back = sendOut(r.bal, -150, s, -200);
    expect(back.bal).toMatchObject({ qty: 200, amount: 300 });
    expect(back.bal.layers[0]).toEqual({ qty: 150, price: 1.3333 });
  });
});

describe("a stock ledger (D487 §27)", () => {
  it("receipt, issue, reversal, stocktake: the ledger lines and balances", async () => {
    const w = world();
    const rk = w.voucher("receipt", "2026-11-03", [{ item: "screw", qty: 500, price: 0.13 }]);
    const r1 = await auditPost(w, rk);
    expect(JSON.stringify(r1.a.message)).toContain("王会计");
    expect(r1.p.failed).toBeUndefined();
    expect(bal(w, "screw")).toMatchObject({ qty: 1500, amount: 165 });
    expect(lines(w, "screw").map((l: any) => [l.type, l.inQty ?? null, l.balQty, l.balAmount])).toEqual([["open", null, 1000, 100], ["line", 500, 1500, 165]]);
    // An issue more than on hand asks first.
    const big = w.voucher("issue", "2026-11-04", [{ item: "screw", qty: 2000 }]);
    const warn = await P.pages.voucher.onEvent(w.ctx(big), "audit");
    expect(warn.params).toEqual({ "view.force": "1" });
    const ck = w.voucher("issue", "2026-11-05", [{ item: "screw", qty: 600 }]);
    await auditPost(w, ck);
    expect(lines(w, "screw").at(-1)).toMatchObject({ outQty: 600, outPrice: 0.11, outAmount: 66, balQty: 900, balAmount: 99 });
    // Posted: read only; revising refused; reversed by a red voucher.
    expect(JSON.stringify(await P.pages.voucher.onEvent(w.ctx(ck, { params: { reason: "x" } }), "revise"))).toContain("只能冲销");
    await P.pages.voucher.onEvent(w.ctx(ck), "reverse");
    const red = w.opened.at(-1)!.slice("resource:".length);
    expect(w.res.get(red)!.body).toMatchObject({ reverses: ck, lines: [{ item: "screw", qty: -600 }] });
    await auditPost(w, red);
    expect(bal(w, "screw")).toMatchObject({ qty: 1500, amount: 165 });
    expect(w.res.get(ck)!.stamps!.map((s: any) => s.label)).toContain("已冲销");
    expect(JSON.stringify(await P.pages.voucher.onEvent(w.ctx(ck), "reverse"))).toContain("已经冲销");
    // Stocktake: the book quantity kept; the loss posted at the average price.
    const pd = w.voucher("count", "2026-11-28", [{ item: "screw", actual: 1490 }]);
    await auditPost(w, pd);
    expect(w.res.get(pd)!.body.lines[0].book).toBe(1500);
    expect(lines(w, "screw").at(-1)).toMatchObject({ summary: "盘亏", outQty: 10, outAmount: 1.1, balQty: 1490, balAmount: 163.9 });
    // The pages render.
    const page = await P.pages.voucher.render(w.ctx(ck));
    expect(checkView(page.view)).toEqual([]);
    expect(page.readOnly).toBe(true);
    const item = await P.pages.item.render(w.ctx("screw"));
    expect(checkView(item.view)).toEqual([]);
    expect(JSON.stringify(item.view)).toContain("结存：1490 个，金额 163.90");
  });

  it("checks before audit; all or nothing when posting", async () => {
    const w = world();
    expect(JSON.stringify(await P.pages.voucher.onEvent(w.ctx(w.voucher("receipt", "2026-11-03", [])), "audit"))).toContain("没有明细");
    expect(JSON.stringify(await P.pages.voucher.onEvent(w.ctx(w.voucher("receipt", "2026-11-03", [{ qty: 1 }])), "audit"))).toContain("第 1 行：选存货");
    expect(JSON.stringify(await P.pages.voucher.onEvent(w.ctx(w.voucher("receipt", "", [{ item: "screw", qty: 1 }])), "audit"))).toContain("先写日期");
    expect(JSON.stringify(await P.actions.post(w.ctx(w.voucher("receipt", "2026-11-03", [{ item: "screw", qty: 1 }])), {}))).toContain("先审核");
    // Two items: the second fails; the first is undone.
    const v = w.voucher("receipt", "2026-11-03", [{ item: "screw", qty: 10, price: 1 }, { item: "plate", qty: 1, price: 50 }]);
    await P.pages.voucher.onEvent(w.ctx(v), "audit");
    w.setFail("plate");
    const r = await P.actions.post(w.ctx(v), {});
    expect(r.failed).toBeTruthy();
    expect(lines(w, "screw")).toEqual([]);
    expect(bal(w, "screw") ?? null).toBe(null);
    expect(w.res.get(v)!.stamps!.length).toBe(1);
  });

  it("a page holds 100 lines and goes on: carried and brought forward", async () => {
    const w = world();
    const words = { opening: "期初结存", carried: "过次页", forward: "承前页", pageName: (n: number) => `第 ${n} 页` };
    const many = Array.from({ length: 105 }, (_, i) => ({ type: "line", date: "2026-11-05", balQty: i, balAmount: i }));
    await writeLines(w.ctx(null), w.res.get("screw"), many, words, newPending(), { date: "2026-11-01", bal: { qty: 0, amount: 0 } });
    const sheets = [...w.res.values()].filter((r) => r.kind === k("sheet")).sort((a, b) => a.body.page - b.body.page);
    expect(sheets.map((s) => s.body.lines.length)).toEqual([PAGE_LINES, 8]);
    expect(sheets[0].body.lines.at(-1)).toMatchObject({ type: "carried", summary: "过次页" });
    expect(sheets[1].body.lines[0]).toMatchObject({ type: "forward", summary: "承前页" });
  });

  it("first in, first out through vouchers", async () => {
    const w = world("fifo", [["bolt", "螺栓", 100, 1]]);
    await auditPost(w, w.voucher("receipt", "2026-11-03", [{ item: "bolt", qty: 100, price: 2 }]));
    await auditPost(w, w.voucher("issue", "2026-11-04", [{ item: "bolt", qty: 150 }]));
    expect(lines(w, "bolt").at(-1)).toMatchObject({ outAmount: 200, balQty: 50, balAmount: 100 });
  });

  it("the summary; month-end close locks the month; reopening the last month with a reason", async () => {
    const w = world();
    await auditPost(w, w.voucher("receipt", "2026-11-03", [{ item: "screw", qty: 500, price: 0.13 }]));
    const draft = w.voucher("issue", "2026-11-20", [{ item: "screw", qty: 1 }]);
    const sum = "sum";
    w.res.set(sum, { id: sum, kind: k("summary"), name: "汇总", parentId: "bk", body: { month: "2026-11" } });
    const view = (await P.pages.summary.render(w.ctx(sum))).view;
    expect(checkView(view)).toEqual([]);
    expect(view.find((n: any) => n.id === "figures").rows[0]).toEqual(["螺丝 M6", "1000", "100.00", "500", "65.00", "0", "0.00", "1500", "165.00"]);
    expect(JSON.stringify(await P.pages.summary.onEvent(w.ctx(sum), "close"))).toContain("还没记账");
    await auditPost(w, draft);
    await P.pages.summary.onEvent(w.ctx(sum), "close");
    expect(w.res.get("setup")!.body.closed).toEqual(["2026-11"]);
    expect(lines(w, "screw").at(-1)).toMatchObject({ type: "total", summary: "本月合计", inQty: 500, outQty: 1 });
    // Closed: no voucher of that month is audited; a later one goes on a new page.
    expect(JSON.stringify(await P.pages.voucher.onEvent(w.ctx(w.voucher("receipt", "2026-11-30", [{ item: "screw", qty: 1, price: 1 }])), "audit"))).toContain("已经结账");
    await auditPost(w, w.voucher("receipt", "2026-12-01", [{ item: "screw", qty: 1, price: 1 }]));
    const sheets = [...w.res.values()].filter((r) => r.kind === k("sheet")).sort((a, b) => a.body.page - b.body.page);
    expect(sheets[1].body.lines[0]).toMatchObject({ type: "forward" });
    // Reopen: refused while December is posted.
    expect(JSON.stringify(await P.pages.summary.onEvent(w.ctx(sum, { params: { reason: "错了" } }), "reopen"))).toContain("后面的月份");
  });

  it("vouchers are numbered; roles in a book; every key in every language", async () => {
    const w = world();
    const v = w.voucher("receipt", "2026-11-03", [], { no: "" });
    await P.events["resource.changed"](w.ctx(null), { change: "created", kind: k("receipt"), id: v });
    expect(w.res.get(v)!.body.no).toBe("RK-202611-001");
    const roles = (await P.actions.roles({}, {})).data.kinds;
    expect(roles.find((r: any) => r.kind === "catalog")).toMatchObject({ role: "toc", single: true });
    expect(roles.find((r: any) => r.kind === "item")).toMatchObject({ role: "account", container: true });
    expect(manifest.contributes.menus.new).toContain("receipt");
    for (const f of ["en-US", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual(Object.keys(ZH).sort());
  });
});
