/**
 * Round 20 sqlpool parity check (docs/handoff/round20-parity.md): shared set-up and the result recorder.
 * Every row of docs/redesign/sqlpool-parity.md §3 is done in a real devhost + real PostgreSQL; the verdict of each row is
 * written to docs/screenshots/parity/results.json (merged by row id) together with a one-line note of what was checked.
 * The oracle for result rows is `psql` against the same database (sqlpool itself does not exist on this machine).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ROOT, rpc, type Host } from "../kernel-host";
import type { Pg } from "../pg-fixture";

export const EVID = path.join(ROOT, "test-results/screenshots/parity");
mkdirSync(EVID, { recursive: true });
const RESULTS = path.join(EVID, "results.json");

export type Verdict = "通过" | "不通过" | "按新需求改了" | "未验证";
export type RowResult = { row: string; verdict: Verdict; note: string; evidence?: string };
export class Outcome {
  constructor(public verdict: Verdict, public note: string, public evidence?: string) {}
}
export const pass = (note: string, evidence?: string) => new Outcome("通过", note, evidence);
export const changed = (note: string, evidence?: string) => new Outcome("按新需求改了", note, evidence);
export const unverified = (note: string, evidence?: string) => new Outcome("未验证", note, evidence);
export const fail = (note: string, evidence?: string) => new Outcome("不通过", note, evidence);

function save(r: RowResult) {
  let all: Record<string, RowResult> = {};
  try {
    all = JSON.parse(readFileSync(RESULTS, "utf8"));
  } catch {
    /* first row */
  }
  all[r.row] = r;
  writeFileSync(RESULTS, JSON.stringify(all, null, 1));
}

/** Runs one row's check. A thrown error is recorded as 不通过 with the message (the next rows still run). */
export async function row(id: string, fn: () => Promise<Outcome | string | void>, page?: Page): Promise<void> {
  try {
    const r = await fn();
    if (r instanceof Outcome) save({ row: id, verdict: r.verdict, note: r.note, evidence: r.evidence });
    else save({ row: id, verdict: "通过", note: typeof r === "string" ? r : "" });
  } catch (e) {
    let evidence: string | undefined;
    if (page) {
      try {
        evidence = `${id}-fail.png`;
        await page.screenshot({ path: path.join(EVID, evidence) });
      } catch {
        evidence = undefined;
      }
    }
    save({ row: id, verdict: "不通过", note: String((e as Error).message ?? e).split("\n").slice(0, 6).join(" | ").slice(0, 700), evidence });
  }
}
export const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: path.join(EVID, name) });
  return name;
};

/** A short base directory (unix socket paths are limited to ~100 bytes). */
export const mkBase = (tag: string) => {
  const root = process.env.ONEDESK_PARITY_TMP ?? "/tmp/od-parity"; // short on purpose; override with ONEDESK_PARITY_TMP
  mkdirSync(root, { recursive: true });
  return realpathSync(mkdtempSync(path.join(root, `${tag}-`)));
};

/** Tables of the parity database, the same for every batch: orders (the round-15 data), a versioned item table, a 30-row table. */
export function seedParity(pg: Pg, db: string) {
  pg.psql(
    db,
    `CREATE TABLE item_ver (item_id int, name text, valid_from timestamptz, valid_to timestamptz, is_deleted boolean DEFAULT false);
     INSERT INTO item_ver VALUES
       (1,'pen','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z',false),
       (1,'pen v2','2026-02-01T00:00:00Z',NULL,false),
       (2,'cup','2026-01-01T00:00:00Z',NULL,false),
       (3,'old','2026-01-01T00:00:00Z','2026-01-15T00:00:00Z',false),
       (3,'old','2026-01-15T00:00:00Z',NULL,true);
     CREATE TABLE ord_line (line_id int PRIMARY KEY, order_id int, sku text, qty int);
     INSERT INTO ord_line SELECT g, (g % 4) + 1, 'sku' || (g % 5), g FROM generate_series(1, 30) g;`,
  );
}

/** Rows as psql prints them (the oracle). NULL is printed as the literal `NULL`. */
export function oracle(pg: Pg, db: string, sql: string, user = "app"): string[][] {
  const out = execFileSync(path.join(pg.bin, "psql"), ["-X", "-A", "-t", "-F", "\u001f", "-P", "null=NULL", "-h", path.join(pg.dir, "sock"), "-p", String(pg.port), "-U", "postgres", "-d", db, "-c", sql], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  void user;
  return out.split("\n").filter((l) => l !== "").map((l) => l.split("\u001f"));
}

export const ds = { call: <T = unknown>(page: Page, h: Host, method: string, params: unknown = null) => rpc<T>(page, h, method, params) };
export const exists = existsSync;
export { ROOT };
