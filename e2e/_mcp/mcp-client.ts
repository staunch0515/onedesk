/**
 * Round 19: a fake MCP client for the e2e specs. It speaks what a real client (Claude Desktop) speaks to `onedesk-mcp`:
 * JSON-RPC 2.0, one JSON object per line over the child's stdin/stdout (initialize → notifications/initialized →
 * tools/list → tools/call). Nothing here knows a plugin; tool names come from the server's own tools/list.
 *
 *   StdioMcpClient  – spawns a command (the real `onedesk-mcp`, or `fake-server.mjs` for the self-test).
 *   McpCallResult   – the parts of a tools/call result the specs assert on.
 */
import { spawn, type ChildProcess } from "node:child_process";

export type McpTool = { name: string; description?: string; inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] } };
export type McpCallResult = {
  /** MCP-level failure (`isError: true` in the result) */
  isError: boolean;
  /** concatenated text parts */
  text: string;
  /** `text` parsed as JSON when it is JSON, else null */
  json: any;
  raw: any;
};
export class McpRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(`MCP error ${code}: ${message}`);
  }
}

export type SpawnSpec = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };

export class StdioMcpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  /** everything the server wrote to stderr (diagnostics only; never part of the protocol) */
  stderr = "";
  /** lines on stdout that were not valid JSON-RPC (a server must never print these) */
  strayStdout: string[] = [];
  notifications: any[] = [];
  exitCode: number | null = null;
  serverInfo: any = null;
  capabilities: any = null;

  constructor(spec: SpawnSpec) {
    // ONEDESK_SECRET_STORE=memory: a test run never touches the real keychain, whatever the server spawns.
    this.proc = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, ONEDESK_SECRET_STORE: "memory" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr!.on("data", (d) => (this.stderr += d));
    this.proc.stdout!.on("data", (d) => this.onData(String(d)));
    this.proc.on("exit", (code) => {
      this.exitCode = code ?? -1;
      for (const p of this.pending.values()) p.reject(new Error(`MCP server exited (${code}) before answering\n${this.stderr}`));
      this.pending.clear();
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.strayStdout.push(line);
        continue;
      }
      if (msg && msg.jsonrpc === "2.0" && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new McpRpcError(msg.error.code, msg.error.message, msg.error.data)) : p.resolve(msg.result);
      } else if (msg && msg.method) this.notifications.push(msg);
      else this.strayStdout.push(line);
    }
  }

  /** One JSON-RPC request; rejects with McpRpcError on a protocol-level error, with a timeout error when nothing comes back. */
  request<T = any>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs} ms\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method: string, params: unknown = {}) {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** The handshake a real client does. */
  async initialize(protocolVersion = "2025-06-18") {
    const r = await this.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "onedesk-e2e-fake-client", version: "0.0.0" } });
    this.serverInfo = r.serverInfo;
    this.capabilities = r.capabilities;
    this.notify("notifications/initialized");
    return r as { protocolVersion: string; capabilities: any; serverInfo: { name: string; version?: string }; instructions?: string };
  }
  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      out.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  }
  /** tools/call. A tool-level failure comes back as `isError: true` (not a rejection); an unknown tool / bad params may reject with McpRpcError. */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<McpCallResult> {
    const raw = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = (raw.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { isError: !!raw.isError, text, json, raw };
  }

  /** Close stdin (what Claude Desktop does on quit) and wait for the server to exit; kills it after `graceMs`. */
  async close(graceMs = 5_000): Promise<number | null> {
    if (this.exitCode !== null) return this.exitCode;
    this.proc.stdin!.end();
    const t = setTimeout(() => this.proc.kill("SIGTERM"), graceMs);
    await new Promise((r) => (this.exitCode !== null ? r(null) : this.proc.once("exit", r)));
    clearTimeout(t);
    return this.exitCode;
  }
  kill() {
    this.proc.kill("SIGKILL");
  }
}

/** Open a client and run the handshake. */
export async function connectMcp(spec: SpawnSpec): Promise<StdioMcpClient> {
  const c = new StdioMcpClient(spec);
  await c.initialize();
  return c;
}
