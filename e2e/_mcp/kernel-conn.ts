/**
 * Round 19 helpers for the MCP specs (no browser needed):
 *   UserKernel – the devhost (the app's kernel, operator `user`) with a Node-side WebSocket for raw protocol calls. Setup (create
 *                resources, set the policy, flip ai_visible) and "what did the user see" go through it.
 *   AiWorker   – a headless `onedesk-worker --ai-client <name>`: every request on it is the AI operator, so refusals can be
 *                provoked with ANY protocol method (onedesk-mcp only ever sends the mcp.* ones).
 * The app and a headless worker never run on the same workspace at once (the workspace lock): stop one before starting the other.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT, startHost, stopHost, type Host } from "../kernel-host";

export type ProtoError = { code: string; params?: Record<string, string>; detail?: string };
export class RpcError extends Error {
  constructor(public err: ProtoError) {
    super(JSON.stringify(err));
  }
}

export class UserKernel {
  host!: Host;
  constructor(
    private dataDir: string,
    private pluginsDir: string,
  ) {}
  async start() {
    this.host = await startHost(this.dataDir, { ONEDESK_TEST_HOOKS: "1" }, this.pluginsDir);
    return this;
  }
  async stop() {
    if (this.host) await stopHost(this.host);
  }
  /** one request on a fresh WebSocket connection (hello first, as the window does) */
  rpc<T = any>(method: string, params: unknown = null): Promise<T> {
    const { port, token } = this.host;
    return new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}&client=e2e-user`);
      const send = (id: number, m: string, p: unknown) => ws.send(JSON.stringify({ id, method: m, params: p }));
      ws.onopen = () => send(1, "hello", { protocol: "1" });
      ws.onerror = () => reject(new Error("ws error"));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 1) return send(2, method, params);
        if (msg.id === 2) {
          ws.close();
          msg.error ? reject(new RpcError(msg.error)) : resolve(msg.result);
        }
      };
    });
  }
}

export class AiWorker {
  private proc!: ChildProcess;
  private sock!: net.Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (r: any) => void>();
  stderr = "";
  exitCode: number | null = null;
  constructor(
    private dataDir: string,
    private client = "e2e-raw",
    private workspace = "default",
  ) {}
  async start(): Promise<this> {
    // the workspace lock may still be held for a moment by a headless worker that is leaving (exit code 3): wait for it like the app does
    for (let i = 0; ; i++) {
      try {
        return await this.startOnce();
      } catch (e) {
        if (i >= 40 || !/worker exited 3/.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  private async startOnce() {
    this.stderr = "";
    this.exitCode = null;
    const socketPath = path.join(tmpdir(), `od-r19-${process.pid}-${Date.now()}.sock`);
    const bin = process.env.ONEDESK_WORKER_BIN ?? path.join(ROOT, "target/debug/onedesk-worker");
    this.proc = spawn(bin, ["--workspace", path.join(this.dataDir, "workspaces", this.workspace), "--plugins", path.join(this.dataDir, "plugins"), "--socket", socketPath, "--ai-client", this.client], {
      env: { ...process.env, ONEDESK_DATA_DIR: this.dataDir, ONEDESK_SECRET_STORE: "memory" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.proc.stderr!.on("data", (d) => (this.stderr += d));
    this.proc.on("exit", (c) => (this.exitCode = c ?? -1));
    for (let i = 0; i < 300 && !existsSync(socketPath); i++) {
      if (this.exitCode !== null) throw new Error(`worker exited ${this.exitCode}\n${this.stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    this.sock = net.connect(socketPath);
    await new Promise<void>((res, rej) => (this.sock.once("connect", res), this.sock.once("error", rej)));
    this.sock.on("data", (d) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const msg = JSON.parse(line);
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
    await this.call("hello", { protocol: "1" });
    rmSync(socketPath, { force: true });
    return this;
  }
  /** raw request; resolves with the result, rejects with RpcError carrying `{code, params}` */
  async call<T = any>(method: string, params: unknown = null, extra: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const p = new Promise<any>((r) => this.pending.set(id, r));
    this.sock.write(JSON.stringify({ id, method, params, client: "e2e-raw", ...extra }) + "\n");
    const msg = await p;
    if (msg.error) throw new RpcError(msg.error);
    return msg.result;
  }
  async stop() {
    this.sock?.end();
    await new Promise((r) => (this.exitCode !== null ? r(null) : this.proc.once("exit", r)));
  }
}
