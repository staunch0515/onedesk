/**
 * Round 17: fake `ssh`, `scp` and `docker` for the e2e specs, so no spec ever touches a real server or container.
 *
 * Why this is not just "put them first on PATH": the kernel finds a system program only in its fixed folders
 * (`SYSTEM_DIRS`, `/usr/bin` first; PATH is never read) and `searchPaths` is only tried when none of those has the
 * program. The real /usr/bin/ssh therefore always wins. What the kernel does allow is a `plugin` program, looked up in
 * `plugin-data/<id>/bin/` and then at the manifest's `path` inside the package. So `prepareFakePlugins` makes a
 * temp copy of the plugins folder in which every `ssh`/`scp`/`docker` declaration is turned into
 * `{ source: "plugin", path: "bin/<name>" }` and puts the fake there; the devhost is started with `--plugins <copy>`.
 * The shipped manifests are not touched and nothing else about the plugins changes.
 *
 * Fakes record every call and answer from rules (see fake-tools/fake-tool.sh for the file formats). Modes:
 *  - script  : plain stdout/stderr/exit code (steps may sleep between lines, to test live output and timeouts)
 *  - exec    : ssh runs the remote command in a local shell inside `remoteHome`, PATH = the temp PostgreSQL's bin,
 *              so `pg_dump` talks to the throw-away database
 *  - scp     : copies from/to `remoteHome`
 *  - docker-exec / docker-cp : run the command locally / copy into `containerFs`
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Step = { out: string } | { err: string } | { sleep: number };
export type Rule = {
  /** Extended regex tested against the arguments joined with spaces; default: matches every call. */
  match?: string;
  steps?: Step[];
  code?: number;
  mode?: "script" | "exec" | "scp" | "docker-exec" | "docker-cp";
  /** KEY=VALUE pairs exported to the command a mode runs (e.g. PGPASSWORD). */
  env?: Record<string, string>;
};
export type Call = { tool: string; args: string[] };
export type FakeTool = "ssh" | "scp" | "docker";
export const FAKE_TOOLS: FakeTool[] = ["ssh", "scp", "docker"];

const SCRIPT = path.join(import.meta.dirname, "fake-tools/fake-tool.sh");

export class FakeTools {
  readonly dir: string;
  readonly binDir: string;
  readonly remoteHome: string;
  readonly containerFs: string;
  private n: Record<string, number> = {};
  constructor(dir: string, pgBin?: string | null) {
    this.dir = dir;
    this.binDir = path.join(dir, "bin");
    this.remoteHome = path.join(dir, "remote-home");
    this.containerFs = path.join(dir, "container-fs");
    mkdirSync(this.binDir, { recursive: true });
    mkdirSync(this.remoteHome, { recursive: true });
    mkdirSync(this.containerFs, { recursive: true });
    mkdirSync(path.join(dir, "calls"), { recursive: true });
    if (pgBin) writeFileSync(path.join(dir, "path"), pgBin);
    const body = readFileSync(SCRIPT, "utf8").replaceAll("__STATE__", dir);
    for (const t of FAKE_TOOLS) {
      const f = path.join(this.binDir, t);
      writeFileSync(f, body);
      chmodSync(f, 0o755);
    }
  }

  /** Add a rule for a tool; rules are tried in the order they were added. */
  rule(tool: FakeTool, r: Rule): this {
    const i = (this.n[tool] = (this.n[tool] ?? 0) + 1);
    const d = path.join(this.dir, "rules", tool, String(i).padStart(3, "0"));
    mkdirSync(d, { recursive: true });
    if (r.match !== undefined) writeFileSync(path.join(d, "match"), r.match);
    if (r.code !== undefined) writeFileSync(path.join(d, "code"), String(r.code));
    if (r.mode) writeFileSync(path.join(d, "mode"), r.mode);
    if (r.env) writeFileSync(path.join(d, "env"), Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    if (r.steps) {
      const line = (s: Step) => ("out" in s ? `out ${s.out.replace(/\n/g, "\\n")}` : "err" in s ? `err ${s.err.replace(/\n/g, "\\n")}` : `sleep ${s.sleep}`);
      writeFileSync(path.join(d, "steps"), r.steps.map(line).join("\n") + "\n");
    }
    return this;
  }

  /** Forget the rules (and optionally the recorded calls). */
  reset(clearCalls = true) {
    rmSync(path.join(this.dir, "rules"), { recursive: true, force: true });
    this.n = {};
    if (clearCalls) {
      rmSync(path.join(this.dir, "calls"), { recursive: true, force: true });
      mkdirSync(path.join(this.dir, "calls"), { recursive: true });
    }
  }

  /** The recorded calls in order, optionally of one tool. */
  calls(tool?: FakeTool): Call[] {
    const d = path.join(this.dir, "calls");
    return readdirSync(d)
      .filter((f) => f.endsWith(".args") && (!tool || f.endsWith(`-${tool}.args`)))
      .sort()
      .map((f) => ({ tool: f.replace(/^\d+-/, "").replace(/\.args$/, ""), args: readFileSync(path.join(d, f), "utf8").split("\n").slice(0, -1) }));
  }

  /**
   * A temp copy of the plugins folder in which fake-able programs are declared as the plugin's own (`source: "plugin"`).
   * Plugins that declare none of them are symlinked, not copied. Returns the folder to pass as `--plugins`.
   * The fakes themselves go to `<dataDir>/workspaces/default/plugin-data/<plugin id>/bin/<name>`: that is the first place
   * the kernel looks for a plugin's own program, and the only one that keeps the executable bit (the host copies
   * built-in packages file by file and drops it).
   */
  preparePlugins(realPlugins: string, outDir: string, dataDir: string, workspace = "default"): string {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (const name of readdirSync(realPlugins)) {
      const src = path.join(realPlugins, name);
      if (!statSync(src).isDirectory()) continue;
      const mf = path.join(src, "manifest.json");
      let manifest: { id?: string; requires?: { programs?: { name: string; source: string; path?: string; searchPaths?: string[] }[] } } | null = null;
      if (existsSync(mf)) {
        try {
          manifest = JSON.parse(readFileSync(mf, "utf8"));
        } catch {
          manifest = null;
        }
      }
      const fake = (manifest?.requires?.programs ?? []).filter((p) => (FAKE_TOOLS as string[]).includes(p.name));
      if (!manifest || !fake.length) {
        symlinkSync(src, path.join(outDir, name));
        continue;
      }
      const dst = path.join(outDir, name);
      cpSync(src, dst, { recursive: true });
      const bin = path.join(dataDir, "workspaces", workspace, "plugin-data", manifest.id ?? name, "bin");
      mkdirSync(bin, { recursive: true });
      for (const p of fake) {
        p.source = "plugin";
        p.path = `bin/${p.name}`; // a manifest check wants one; the file is not in the package, the one in plugin-data wins
        delete p.searchPaths;
        cpSync(path.join(this.binDir, p.name), path.join(bin, p.name));
      }
      writeFileSync(path.join(dst, "manifest.json"), JSON.stringify(manifest, null, 2));
    }
    return outDir;
  }
}
