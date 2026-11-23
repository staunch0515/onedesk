/** Shared by the real-kernel specs: devhost lifecycle, page helpers, raw protocol calls. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const OUT = path.join(ROOT, "test-results/screenshots");
export const DEVHOST = process.env.ONEDESK_DEVHOST_BIN ?? path.join(ROOT, "target/debug/onedesk-devhost");

/** Official plugins: bundled (plugins/) and external (plugins-external/, D456). The kernel specs load both. */
export const PLUGIN_ROOTS = [path.join(ROOT, "plugins"), path.join(ROOT, "plugins-external")];

/** Puts a link to every entry of both plugin folders into `into` (which must exist). */
export function linkAllPlugins(into: string): void {
  for (const r of PLUGIN_ROOTS) {
    if (!existsSync(r)) continue;
    for (const n of readdirSync(r)) if (!n.startsWith(".") && !existsSync(path.join(into, n))) symlinkSync(path.join(r, n), path.join(into, n));
  }
}

let merged: string | null = null;
/** One folder (per test process) that links every official plugin: the default for `startHost`. */
export function allPlugins(): string {
  if (merged) return merged;
  const dir = path.join(ROOT, "test-results", `all-plugins-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  linkAllPlugins(dir);
  merged = dir;
  return dir;
}

export type Host = { proc: ChildProcess; port: number; token: string; dataDir: string };

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

/** `pluginsDir`: e.g. the copy from `FakeTools.preparePlugins` (fake ssh/docker). `env`: extra environment for the devhost (e.g. ONEDESK_PLUGIN_IDLE_MS); the secret store is always the in-memory one. */
export async function startHost(dataDir: string, env: Record<string, string> = {}, pluginsDir: string = allPlugins()): Promise<Host> {
  const port = await freePort();
  const token = randomBytes(16).toString("hex");
  const proc = spawn(DEVHOST, ["--data-dir", dataDir, "--port", String(port), "--token", token, "--plugins", pluginsDir], {
    cwd: ROOT,
    env: { ...process.env, ...env, ONEDESK_DATA_DIR: dataDir, ONEDESK_SECRET_STORE: "memory" }, // never the real keychain
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`devhost not READY in 30s\n${err}`)), 30_000);
    proc.stdout!.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`devhost exited ${code}\n${err}`)));
  });
  return { proc, port, token, dataDir };
}

export async function stopHost(h: Host) {
  h.proc.removeAllListeners("exit");
  h.proc.kill("SIGTERM");
  await new Promise((r) => (h.proc.exitCode !== null ? r(null) : h.proc.once("exit", r)));
}

/* ------------------------------------------------------------ page helpers */

export const ui = {
  tab: (page: Page, name: string) => page.locator("[data-tab-id]", { hasText: name }),
  node: (page: Page, label: string) => page.locator("[data-tree-key]", { hasText: label }).first(),
  nodeKey: (page: Page, key: string) => page.locator(`[data-tree-key="${key}"]`),
  activity: (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true }),
  menuItem: (page: Page, name: string | RegExp) => page.getByRole("menuitem", { name }),
  editor: (page: Page) => page.getByRole("textbox", { name: "Content", exact: true }),
};

export async function openKernel(page: Page, h: Host, theme: string | null = "light") {
  await page.goto(`/workbench.html?reset&quiet${theme ? `&theme=${theme}` : ""}&kernel=${encodeURIComponent(`ws://127.0.0.1:${h.port}`)}&token=${h.token}`);
  if (theme) await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate(() => history.replaceState(null, "", location.pathname + location.search.replace("reset&", "")));
}

/** Raw protocol call over the devhost WebSocket (`/?token=&client=`, numeric ids, one JSON text frame each). */
export async function rpc<T = unknown>(page: Page, h: Host, method: string, params: unknown = null): Promise<T> {
  return page.evaluate(
    ({ url, method, params }) =>
      new Promise<T>((resolve, reject) => {
        const ws = new WebSocket(url);
        const send = (id: number, m: string, p: unknown) => ws.send(JSON.stringify({ id, method: m, params: p }));
        ws.onopen = () => send(1, "hello", { protocol: "1" });
        ws.onerror = () => reject(new Error("ws error"));
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) return send(2, method, params);
          if (msg.id === 2) {
            ws.close();
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
          }
        };
      }),
    { url: `ws://127.0.0.1:${h.port}/?token=${h.token}&client=e2e-rpc`, method, params },
  );
}

