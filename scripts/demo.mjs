#!/usr/bin/env node
// 演示工作区：把这几轮做的功能各放一个能动手的例子，再加一本《OneDesk 导览》说明每个例子怎么玩。
//
//   pnpm demo            第一次：建演示数据（约 1 分钟），以后：直接打开
//   pnpm demo --fresh    删掉演示数据重建
//   pnpm demo --dir <文件夹>   演示数据放在别处（默认 ~/OneDesk-演示）
//
// 只用开发用的主进程（onedesk-devhost）和一个单独的数据文件夹，不碰正式的应用数据
// （~/Library/Application Support/onedesk/）。身份的私钥在开发用的钥匙串条目（服务名 onedesk-dev）。
// 跑起来以后在浏览器里打开打印出的网址；Ctrl+C 结束。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const DIR = path.resolve(args.includes("--dir") ? args[args.indexOf("--dir") + 1] : path.join(homedir(), "OneDesk-演示"));
// The workspace data, apart from the folders the plugins are granted (a granted folder may not be inside the data).
const DATA = path.join(DIR, "数据");
const FRESH = args.includes("--fresh");
const KERNEL_PORT = 47811;
const WEB_PORT = 1420;

const say = (s) => console.log(`\x1b[36m[演示]\x1b[0m ${s}`);

/* ------------------------------------------------------------------ the dev host */

function targetDir() {
  const r = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(r.stdout).target_directory;
}

function build() {
  say("编译开发用的主进程（第一次会久一点）…");
  const r = spawnSync("cargo", ["build", "-q", "-p", "onedesk-worker", "-p", "onedesk-host"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return path.join(targetDir(), "debug", "onedesk-devhost");
}

/** All official plugins (bundled and external) linked into one folder. */
function pluginsDir() {
  const dir = path.join(DIR, ".plugins");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const r of ["plugins", "plugins-external"]) {
    for (const n of readdirSync(path.join(ROOT, r))) if (!n.startsWith(".") && !n.startsWith("_")) symlinkSync(path.join(ROOT, r, n), path.join(dir, n));
  }
  return dir;
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startHost(bin, dataDir, port, token, plugins) {
  const proc = spawn(bin, ["--data-dir", dataDir, "--port", String(port), "--token", token, "--plugins", plugins], {
    cwd: ROOT,
    env: { ...process.env, ONEDESK_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`主进程 30 秒没有就绪\n${err}`)), 30_000);
    proc.stdout.on("data", (d) => String(d).includes("READY") && (clearTimeout(t), resolve()));
    proc.on("exit", (c) => reject(new Error(`主进程退出了（${c}）\n${err}`)));
  });
  proc.removeAllListeners("exit");
  return { proc, port, token };
}

const stop = (h) => new Promise((r) => (h.proc.once("exit", r), h.proc.kill("SIGTERM")));

/** One protocol call (as the e2e helpers do: hello, then the call). */
function rpc(h, method, params = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/?token=${h.token}&client=demo`);
    const send = (id, m, p) => ws.send(JSON.stringify({ id, method: m, params: p }));
    ws.onopen = () => send(1, "hello", { protocol: "1" });
    ws.onerror = () => reject(new Error(`连不上主进程（${method}）`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === 1) return send(2, method, params);
      if (msg.id === 2) {
        ws.close();
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
      }
    };
  });
}

/* ------------------------------------------------------------------ helpers for seeding */

const B = "org.onedesk.book";
const X = "org.onedesk.exercise";
const D = "org.onedesk.document";
const L = "org.onedesk.ledger";
const I = "org.onedesk.inbox";
const P = "org.onedesk.program";

async function make(h, kind, parent, name, body = {}) {
  const changes = { name };
  for (const [k, v] of Object.entries(body)) changes[`body.${k}`] = v;
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  return (await rpc(h, "page.save", { target, changes })).page.resourceId;
}
const kids = async (h, parent) => (await rpc(h, "tree.children", { tree: "resources", parent })).nodes;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await wait(200);
  }
}
/** A new book; its cover and contents (made by the book) get Chinese names; `noContents`: another kind of contents takes its place. */
async function newBook(h, name, noContents = false) {
  const book = await make(h, `${B}:book`, null, name);
  await until(async () => (await kids(h, book)).length >= 2, "新书的封面和目录");
  for (const n of await kids(h, book)) {
    if (n.label === "Contents" && noContents) await rpc(h, "resource.delete", { id: n.key });
    else if (n.label === "Contents") await rpc(h, "page.save", { target: `resource:${n.key}`, changes: { name: "目录" } });
    else if (n.label === "Cover") await rpc(h, "page.save", { target: `resource:${n.key}`, changes: { name: "封面" } });
  }
  return book;
}
/** Runs a page action as the user would (`run.start`), waits for it to end. */
async function run(h, action, resourceId) {
  const id = await rpc(h, "run.start", { action, resourceId, target: `resource:${resourceId}`, tabId: "demo", locale: "zh-CN" });
  return until(async () => {
    const r = await rpc(h, "run.get", { id });
    return r && r.status !== "running" && r.status !== "queued" ? r : null;
  }, `运行 ${action}`, 60_000);
}
async function defaultEnv(h) {
  return (await rpc(h, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default" || n.label === "默认")?.key;
}

/* ------------------------------------------------------------------ the examples */

const MANIFEST = JSON.stringify(
  {
    id: "org.example.convert",
    version: "0.1.0",
    apiVersion: "2",
    name: "plugin.name",
    icon: "ruler",
    main: "main.js",
    contributes: {
      kinds: [{ id: "conversion", label: "kind.conversion", icon: "ruler", tree: "resources", page: "conversion", newName: "kind.conversion", defaults: { m: 1 } }],
      menus: { new: ["conversion"] },
      pages: [{ id: "conversion", recompute: true, actions: [{ id: "save", role: "save", label: "action.save", icon: "save", primary: true, shortcut: ["Mod", "S"] }] }],
      locales: { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" },
    },
  },
  null,
  2,
);
const MAIN = `import { convert } from "./lib/convert.js";

export default {
  activate(host) {
    host.pages.handle("conversion", {
      render(ctx) {
        const m = Number((ctx.resource && ctx.resource.body && ctx.resource.body.m) || 0);
        return {
          view: [
            { type: "form", id: "f", layout: "stack", fields: [{ name: "m", label: ctx.t("field.m"), kind: "number", bind: "body.m" }] },
            { type: "text", id: "cm", text: "= " + convert(m, "m", "cm") + " 厘米" },
          ],
        };
      },
    });
  },
};
`;
const CONVERT = `// 把米换成厘米。故意留了一个错（乘 10），测试页会抓到它。
export function convert(n, from, to) {
  if (from === "m" && to === "cm") return n * 10;
  return n;
}
`;
const TESTS = `test("一米是一百厘米", () => {
  const { convert } = load("lib/convert.js");
  expect(convert(1, "m", "cm")).toBe(100);
});
test("页面显示厘米", async () => {
  const pages = {};
  load("main.js").default.activate({ pages: { handle: (id, h) => (pages[id] = h) } });
  const r = await pages.conversion.render({ host: fakeHost(), t: (k) => k, resource: { body: { m: 2 } } });
  expect(r.view[1].text).toBe("= 200 厘米");
});
`;

const GUIDE = [
  [
    "怎么用这本导览",
    `这个演示工作区里，每个功能都放了一个现成的例子。每一章说一个功能：**它是什么、去哪里看、动手试什么**。

- 左边“资源”树里，每个例子是一本书或一组页；点开就是。
- 正文里蓝色的 [[名字]] 是引用，点了直接打开那个例子。
- 想从头再来：在终端里运行 \`pnpm demo --fresh\`。

这本导览本身也是一本书：有封面、目录、凡例，可以点“开始阅读”连续读。`,
  ],
  [
    "书和角色",
    `OneDesk 的书只负责“装订”：哪些页、什么顺序。每一页由它的**角色**决定怎么显示、怎么编号——封面、目录、正文页、附录、凡例、版权页……

**去看**：这本 [[OneDesk 导览]] 自己。点“开始阅读”：章节自动编号，目录在左边。

**动手**：在 [[OneDesk 导览]] 下面新建一个“书页”，写几句；再打开目录，看它自己出现、自动编号。`,
  ],
  [
    "课本和练习",
    `课本也是一本书：练习页可以在书上直接作答、当场判；测验是一张卡片，在自己的作答页上答、交卷、判分；学习记录里有成绩单和错题本。

**去看**：[[三年级数学（演示）]]，它的目录是“课本目录”，显示每课的进度。

**动手**：
1. 开始阅读，在“加法练习”里填答案，点“检查”；
2. 在“单元测验”卡片上点“开始”，答完“交卷”；
3. 左边活动栏的“学习记录”里看成绩单和错题本。`,
  ],
  [
    "文书和审签",
    `文书照模板写：模板里的 {{?填写项}} 在文书里变成输入框；可以签名定稿、修订、作废，也可以寄给别人审签。

**去看**：模板 [[请假单模板]] 和照它写的 [[请假单（演示）]]。

**动手**：打开请假单，改“开始日期”；点“定稿”看签章。`,
  ],
  [
    "库存账本",
    `业务系统也做成书：一本库存账本有账簿启用表、存货目录、每种存货的账页、单据簿、收发存汇总表。单据要先**审核**（盖章）再**记账**，记错了用红字冲销。

**去看**：[[原料库存账（演示）]]。“入库单 1”已经填好还没审核。

**动手**：
1. 打开“入库单 1”，点“审核”，再点“记账”；
2. 打开“螺丝 M6”看账页；打开“存货目录”看结存和预警；
3. 打开“十一月汇总”，点“月末结账”。`,
  ],
  [
    "凡例和检查",
    `凡例写这本书的体例：正文的规矩、用字表（不用什么、改用什么）、符号表；它还自动列出这本书怎么编排。“按凡例检查”会找出全书里不合用字表的地方，并能一次提出修改。

**去看**：[[OneDesk 导览]] 的“凡例”页。

**动手**：在任何一章里写“登陆”两个字，保存；回到凡例点“按凡例检查”，再点“提出修改”。`,
  ],
  [
    "修订提案（AI 和别人提的修改）",
    `谁都不直接改你的书：AI、别人提的修改是一个**修订提案**，你看前后对照，逐项接受或拒绝。

**去看**：左边活动栏“待审的修改”，里面有一个“导览：措辞调整”。

**动手**：打开它，看对照（删掉的、加上的都标出来）；接受一项、拒绝一项；回到这一章看结果，信息栏“历史”里写着是哪个提案改的。

AI 客户端（MCP）连上以后也能读书、提修改：见设置里的“AI 与 MCP”。`,
  ],
  [
    "身份和签名",
    `每个工作区有一个身份（一对密钥）。签章、发布的书、寄出的信都自动带签名，对方能验证“确实是你、内容没被改过”。通讯录里记着别人的身份卡，核对过指纹的标“已核对”。

**去看**：设置菜单里的“身份和通讯录”：你的身份“王老师”，通讯录里有“李老师”（已核对）。

**动手**：导出自己的身份卡；看一张签章的“签名有效”。`,
  ],
  [
    "收件箱：来件和回件",
    `书可以当收件箱：别人寄来的不是邮件，而是要你处理的页——作答的测验、要审签的文书。你做完点“回件”，对方那边自动收回结果。

**去看**：[[收文簿]] 里有一份李老师寄来的“第一次作业”（要你作答一份小测验）。

**动手**：
1. 打开“第一次作业”，看要做的事；
2. 打开里面的“乘法小测”，开始、作答、交卷；
3. 回到来件，点“回件…”：写出一个回件文件（在演示文件夹的“信件”里），寄回给李老师就行。

[[发文簿]] 里有一封写好没寄的“请审阅”，可以选收件人“李老师”寄出。`,
  ],
  [
    "程序书：在书里写插件",
    `一本有清单页的书就是程序书：清单页、代码页（先讲解再代码）、语言页、测试页、构建页。测试在一个空沙箱里跑，什么也碰不到；“安装试用”把书里的插件装上；“构建…”写出签名的插件包。

**去看**：[[单位换算（程序书）]]。

**动手**：
1. 打开“测试”，点“运行测试”：两个失败（期望 100，实际 10）；
2. 打开代码页“换算”，把 \`n * 10\` 改成 \`n * 100\`，保存；再运行测试，全部通过；
3. 打开“构建”，点“安装试用”，确认；顶栏“新建”里出现“换算”，新建一个试试；
4. 点“构建…”：写出 \`org.example.convert-0.1.0.odplugin\`（在演示文件夹的“输出”里）。`,
  ],
];

async function seedLi(bin, plugins, card) {
  // The other side of the letter: Li's own workspace, only to write the letter.
  say("准备寄件人李老师的工作区…");
  const liDir = path.join(DIR, "李老师的数据");
  const h = await startHost(bin, liDir, await freePort(), randomBytes(16).toString("hex"), plugins);
  try {
    await rpc(h, "identity.create", { name: "李老师" });
    await rpc(h, "identity.exportCard", { path: path.join(DIR, "信件", "李老师.odid") });
    const me = await rpc(h, "contact.importCard", { path: path.join(DIR, "信件", "王老师.odid") });
    await rpc(h, "contact.setChecked", { id: me.id, checked: true });
    await rpc(h, "plugin.grantFolder", { plugin: I, path: path.join(DIR, "信件") });
    const quiz = await make(h, `${X}:test`, null, "乘法小测", { timing: "submit" });
    await make(h, `${X}:question`, quiz, "七八", { type: "fill", stem: "7 × 8 = {{?}}", answers: "56", rule: "number", points: 1 });
    await make(h, `${X}:question`, quiz, "九九", { type: "fill", stem: "9 × 9 = {{?}}", answers: "81", rule: "number", points: 1 });
    const outbox = await make(h, `${I}:outbox`, null, "发文簿");
    const sent = await make(h, `${I}:sent`, outbox, "第一次作业", { subject: "第一次作业", comment: "做完这份小测验，周五前回件。", due: "2099-12-31", to: [{ who: me.id }], pages: [{ page: quiz, task: "answer" }] });
    const r = await run(h, `${I}:send`, sent);
    if (r.status !== "success") throw new Error(`寄件失败：${JSON.stringify(r.error)}`);
  } finally {
    await stop(h);
  }
}

async function seed(bin, plugins) {
  mkdirSync(path.join(DIR, "信件"), { recursive: true });
  mkdirSync(path.join(DIR, "输出"), { recursive: true });
  const h = await startHost(bin, DATA, await freePort(), randomBytes(16).toString("hex"), plugins);
  try {
    say("身份和通讯录…");
    await rpc(h, "identity.create", { name: "王老师" });
    await rpc(h, "identity.exportCard", { path: path.join(DIR, "信件", "王老师.odid") });
    const env = await defaultEnv(h);
    if (env) await rpc(h, "params.set", { node: env, name: "签名人", value: "王老师" });
    for (const p of [I, B, P, L]) await rpc(h, "plugin.grantFolder", { plugin: p, path: path.join(DIR, p === I ? "信件" : "输出") });

    say("导览书…");
    const guide = await newBook(h, "OneDesk 导览");
    const cover = (await kids(h, guide)).find((n) => n.label === "封面");
    if (cover) await rpc(h, "page.save", { target: `resource:${cover.key}`, changes: { "body.subtitle": "这几轮做的功能，每个一个例子", "body.authors": "OneDesk" } });
    await make(h, `${B}:conventions`, guide, "凡例", {
      text: "- 每章先说是什么，再说去哪里看、动手试什么。\n- 界面上的按钮名用引号。",
      terms: [{ avoid: "登陆", use: "登录", note: "进入系统叫“登录”" }],
      symbols: [{ symbol: "[[…]]", meaning: "引用：点了打开那个资源" }],
    });
    const chapters = [];
    for (const [name, text] of GUIDE) chapters.push(await make(h, `${B}:page`, guide, name, { text }));

    say("课本和练习…");
    const math = await newBook(h, "三年级数学（演示）", true);
    await make(h, `${X}:lessons`, math, "课本目录");
    const practice = await make(h, `${X}:practice`, math, "加法练习");
    await make(h, `${X}:question`, practice, "3+5", { type: "fill", stem: "3 + 5 = {{?}}", answers: "8", rule: "number" });
    await make(h, `${X}:question`, practice, "27+15", { type: "fill", stem: "27 + 15 = {{?}}", answers: "42", rule: "number" });
    await make(h, `${X}:question`, practice, "比大小", { type: "fill", stem: "38 {{?}} 83（填 < 或 >）", answers: "<", rule: "text" });
    const unit = await make(h, `${X}:test`, math, "单元测验", { limit: 10 });
    await make(h, `${X}:question`, unit, "乘法", { type: "fill", stem: "6 × 7 = {{?}}", answers: "42", rule: "number", points: 2 });
    await make(h, `${X}:question`, unit, "说理", { type: "free", stem: "为什么 3 + 5 = 5 + 3？用一句话说。", points: 2 });
    await make(h, `${X}:answers`, math, "答案");
    await make(h, `${B}:colophon`, math, "版权页", { publisher: "演示学校数学组" });

    say("文书…");
    const tpl = await make(h, `${D}:template`, null, "请假单模板", { text: "# 请假单\n\n请假人：{{?请假人 | text}}\n\n开始日期：{{?开始日期 | date}}\n\n天数：{{?天数 | number}}\n\n事由：{{?事由 | text}}", levels: "申请 / 批准" });
    await make(h, `${D}:document`, null, "请假单（演示）", { template: tpl, "v.请假人": "王老师", "v.开始日期": "2026-12-01", "v.天数": 2, "v.事由": "参加教研活动" });

    say("库存账本…");
    const ledger = await newBook(h, "原料库存账（演示）", true);
    await make(h, `${L}:setup`, ledger, "账簿启用表", { unitName: "演示工厂原料库", method: "moving", started: "2026-11-01" });
    await make(h, `${L}:catalog`, ledger, "存货目录");
    const screw = await make(h, `${L}:item`, ledger, "螺丝 M6", { code: "S-06", unit: "个", openQty: 1000, openPrice: 0.1, min: 1200 });
    await make(h, `${L}:item`, ledger, "钢板", { code: "P-01", unit: "张", openQty: 20, openPrice: 50, min: 5 });
    const reg = await make(h, `${L}:vouchers`, ledger, "单据簿");
    await make(h, `${L}:receipt`, reg, "入库单 1", { date: "2026-11-03", lines: [{ item: screw, qty: 500, price: 0.12 }] });
    await make(h, `${L}:summary`, ledger, "十一月汇总", { month: "2026-11" });

    say("程序书…");
    const prog = await newBook(h, "单位换算（程序书）");
    await make(h, `${P}:manifest`, prog, "清单", { text: MANIFEST });
    await make(h, `${P}:build`, prog, "构建", { notes: "第一版" });
    await make(h, `${P}:code`, prog, "插件", { path: "main.js", explain: "插件从这里开始：一个页面，输入米数，显示厘米。", code: MAIN });
    await make(h, `${P}:code`, prog, "换算", { path: "lib/convert.js", explain: "米和厘米的换算。", code: CONVERT });
    const texts = (rows) => rows.map(([key, text]) => ({ key, text }));
    await make(h, `${P}:locale`, prog, "中文", { language: "zh-CN", texts: texts([["plugin.name", "单位换算"], ["kind.conversion", "换算"], ["field.m", "米"], ["action.save", "保存"]]) });
    await make(h, `${P}:locale`, prog, "英文", { language: "en-US", texts: texts([["plugin.name", "Unit conversion"], ["kind.conversion", "Conversion"], ["field.m", "Metres"], ["action.save", "Save"]]) });
    await make(h, `${P}:test`, prog, "测试", { explain: "两个测试：换算对不对，页面显示对不对。", code: TESTS });

    say("收件箱…");
    const inbox = await make(h, `${I}:inbox`, null, "收文簿");
    const outbox = await make(h, `${I}:outbox`, null, "发文簿");
    await stop(h);
    await seedLi(bin, plugins);
    const h2 = await startHost(bin, DATA, await freePort(), randomBytes(16).toString("hex"), plugins);
    try {
      const li = await rpc(h2, "contact.importCard", { path: path.join(DIR, "信件", "李老师.odid") });
      await rpc(h2, "contact.setChecked", { id: li.id, checked: true });
      await rpc(h2, "letter.receive", { path: path.join(DIR, "信件", "第一次作业.odletter"), parent: inbox });
      await make(h2, `${I}:sent`, outbox, "请审阅", { subject: "请审阅请假单", comment: "请看一下，同意就审签。", to: [{ who: li.id }], pages: [] });

      say("一份待审的修订提案…");
      const target = chapters[1];
      const cur = await rpc(h2, "resource.get", { id: target });
      await rpc(h2, "proposal.create", {
        title: "导览：措辞调整",
        comment: "第二章开头说得更清楚一点，并补一句。",
        items: [{ op: "update", id: target, rev: cur.rev, changes: { "body.text": String(cur.body.text).replace("OneDesk 的书只负责“装订”", "OneDesk 里的书只做一件事：“装订”").replace("**动手**", "一本书里可以放任何插件的页，只要那种页说清楚自己在书里担当什么角色。\n\n**动手**") } }],
      });
    } finally {
      await stop(h2);
    }
  } catch (e) {
    await stop(h).catch(() => {});
    throw e;
  }
}

/* ------------------------------------------------------------------ main */

async function webUp() {
  try {
    const r = await fetch(`http://localhost:${WEB_PORT}/workbench.html`);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (FRESH) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const bin = build();
  const plugins = pluginsDir();
  const marker = path.join(DIR, ".seeded");
  if (!existsSync(marker)) {
    say(`在 ${DIR} 建演示数据…`);
    await seed(bin, plugins);
    writeFileSync(marker, new Date().toISOString());
    say("演示数据建好了。");
  }
  const tokenFile = path.join(DIR, ".token");
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : randomBytes(16).toString("hex");
  writeFileSync(tokenFile, token);
  const h = await startHost(bin, DATA, KERNEL_PORT, token, plugins);
  let web = null;
  if (!(await webUp())) {
    say("启动界面（vite）…");
    web = spawn("pnpm", ["exec", "vite", "--port", String(WEB_PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
    await until(webUp, "界面", 60_000);
  }
  const url = `http://localhost:${WEB_PORT}/workbench.html?kernel=${encodeURIComponent(`ws://127.0.0.1:${KERNEL_PORT}`)}&token=${token}&lang=zh-CN`;
  console.log(`\n  演示工作区已经开好。在浏览器里打开：\n\n  ${url}\n\n  先看《OneDesk 导览》。按 Ctrl+C 结束。\n`);
  const end = async () => {
    await stop(h).catch(() => {});
    web?.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
