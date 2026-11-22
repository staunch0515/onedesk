/**
 * A throw-away PostgreSQL for the round-15 specs: `initdb` into a temp directory, a random local port, scram passwords,
 * two databases with a little data. Nothing outside the given directory is touched and nothing real is contacted.
 * (A fake ssh server was tried and dropped: OpenSSH reads the config of the passwd home, not $HOME, and programs run
 * by the kernel get no other environment, so a throw-away host alias cannot be given to it.)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export function findPgBin(): string | null {
  const roots = ["/Library/PostgreSQL", "/Applications/Postgres.app/Contents/Versions", "/opt/homebrew/opt", "/usr/local/opt"];
  const has = (d: string) => existsSync(path.join(d, "bin/initdb"));
  const fromEnv = process.env.ONEDESK_E2E_PG_BIN; // a bin directory holding initdb/pg_ctl/psql
  if (fromEnv && existsSync(path.join(fromEnv, "initdb"))) return fromEnv;
  for (const r of roots) {
    if (!existsSync(r)) continue;
    if (has(r)) return path.join(r, "bin");
    // newest first: postgresql@18, postgresql@17, ..., libpq has no initdb and is skipped by `has`
    const names = readdirSync(r).filter((n) => /^(postgresql(@\d+)?|libpq|\d+|Latest)$/.test(n));
    for (const v of names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) if (has(path.join(r, v))) return path.join(r, v, "bin");
  }
  return null;
}

export const pgBinOrNull = findPgBin();

/** Why the PostgreSQL specs cannot run here (null when they can). Set ONEDESK_E2E_REQUIRE_PG=1 to turn the skip into a failure. */
export const PG_SKIP_REASON: string | null = pgBinOrNull
  ? null
  : "no PostgreSQL server programs (initdb/pg_ctl/psql) found — install one (e.g. `brew install postgresql@17`) or set ONEDESK_E2E_PG_BIN to its bin directory";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export const PG_USER = "app";
export const PG_PASSWORD = "e2e-Pg-pass-7x";
// Round 19: a role that connects over TCP without a password (trust), for specs whose connection is used by a second process
// (a headless worker cannot see the devhost's in-memory secret store, and the real keychain is never touched by tests).
export const PG_TRUST_USER = "app_trust";
export const DB1 = "shop";
export const DB2 = "other";

export type Pg = { bin: string; dir: string; port: number; stop(): void; psql(db: string, sql: string, user?: string): string };

export async function startPg(dir: string): Promise<Pg> {
  const bin = pgBinOrNull;
  if (!bin) throw new Error("no PostgreSQL found");
  const data = path.join(dir, "pgdata");
  const sock = path.join(dir, "sock");
  mkdirSync(sock, { recursive: true });
  const port = await freePort();
  const run = (cmd: string, args: string[], input?: string) => execFileSync(path.join(bin, cmd), args, { input, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8", "--locale=C"]);
  // trust on the unix socket for the set-up below; the TCP side asks for the scram password
  writeFileSync(path.join(data, "pg_hba.conf"), `local all all trust\nhost all ${PG_TRUST_USER} 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n`);
  run("pg_ctl", ["-D", data, "-o", `-p ${port} -k ${sock} -c listen_addresses=127.0.0.1 -c fsync=off`, "-l", path.join(dir, "pg.log"), "-w", "start"]);
  const psql = (db: string, sql: string, user = "postgres") => run("psql", ["-X", "-q", "-h", sock, "-p", String(port), "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", sql]);
  psql("postgres", `CREATE ROLE ${PG_USER} LOGIN PASSWORD '${PG_PASSWORD}'`);
  psql("postgres", `CREATE ROLE ${PG_TRUST_USER} LOGIN`);
  for (const db of [DB1, DB2]) psql("postgres", `CREATE DATABASE ${db} OWNER ${PG_USER}`);
  psql(
    DB1,
    `CREATE TABLE orders (id int PRIMARY KEY, customer text, amount numeric(10,2), placed_at timestamptz, note text);
     INSERT INTO orders VALUES (1,'ann',10.50,'2026-01-01T10:00:00Z','first'),(2,'bob',20.00,'2026-01-02T10:00:00Z',NULL),(3,'o''neil',30.25,'2026-01-03T10:00:00Z',''),(4,'dee, "d"',5,'2026-01-04T10:00:00Z','multi
line');`,
    PG_USER,
  );
  psql(DB1, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PG_TRUST_USER}`, PG_USER);
  psql(DB2, "CREATE TABLE marker (v text); INSERT INTO marker VALUES ('second database');", PG_USER);
  return {
    bin,
    dir,
    port,
    stop: () => {
      try {
        run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      } catch {
        // already stopped
      }
    },
    psql: (db, sql, user = PG_USER) => psql(db, sql, user),
  };
}
