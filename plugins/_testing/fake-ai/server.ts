/**
 * Fake AI provider for tests and e2e: speaks the Anthropic Messages API (SSE) and the Ollama API (NDJSON) on a
 * local port. It never contacts anything else and checks no key — any x-api-key is accepted and only recorded.
 * See README.md.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type Behavior =
  | { kind: "ok"; pieces?: string[]; inputTokens?: number; outputTokens?: number; model?: string; delayMs?: number }
  | { kind: "error"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "refusal"; pieces?: string[] }
  | { kind: "streamError"; pieces?: string[]; type?: string; message?: string } // HTTP 200, then an error event
  | { kind: "drop"; pieces?: string[] } // some chunks, then the socket is destroyed
  | { kind: "slow"; pieces?: string[]; delayMs: number } // like ok, but waits delayMs before each piece
  // D479: asks to use tools (some text first, if any); the caller answers with tool results in its next request.
  | { kind: "tool"; pieces?: string[]; calls: Array<{ name: string; arguments?: Record<string, unknown> }> };

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any; // parsed JSON, or the raw text when it is not JSON
}

export interface FakeAi {
  url: string;
  port: number;
  /** Every request received, in order. */
  requests: Recorded[];
  /** Behavior of the next `/v1/messages` and `/api/chat` calls (stays until changed). */
  set(b: Behavior): void;
  /** Behavior for one call only, then back to the standing one. */
  once(b: Behavior): void;
  /** Model names returned by `/v1/models` and `/api/tags` (empty list = no model downloaded). */
  setModels(ids: string[]): void;
  /** Ollama: the first `/api/chat` answers with a load line before any text. */
  setLoading(on: boolean): void;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_PIECES = ["Hello", ", ", "world", "."];

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function startFakeAi(port = 0): Promise<FakeAi> {
  const requests: Recorded[] = [];
  let standing: Behavior = { kind: "ok" };
  const queue: Behavior[] = [];
  let models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
  let loading = false;

  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* keep raw */
    }
    const path = (req.url || "").split("?")[0]!;
    requests.push({ method: req.method || "", path, headers: req.headers, body });
    const b = queue.shift() ?? standing;
    try {
      if (req.method === "GET" && path === "/v1/models") {
        if (b.kind === "error") return json(res, b.status, b.body ?? { type: "error", error: { type: "api_error", message: "fake" } }, b.headers);
        return json(res, 200, { data: models.map((id) => ({ id, type: "model", display_name: id })), has_more: false });
      }
      if (req.method === "GET" && path === "/api/version") return json(res, 200, { version: "0.99.0-fake" });
      if (req.method === "GET" && path === "/api/tags") return json(res, 200, { models: models.map((name) => ({ name, model: name })) });
      if (req.method === "POST" && path === "/v1/messages") return await anthropic(res, b, body);
      if (req.method === "POST" && path === "/api/chat") return await ollama(res, b, body);
      json(res, 404, { error: "not found" });
    } catch {
      res.destroy();
    }
  });

  async function anthropic(res: ServerResponse, b: Behavior, body: any) {
    if (b.kind === "error") return json(res, b.status, b.body ?? { type: "error", error: { type: "api_error", message: "fake error" } }, b.headers);
    const model = (b.kind === "ok" && b.model) || body?.model || "claude-haiku-5-5";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse("message_start", { type: "message_start", message: { id: "msg_fake", model, role: "assistant", usage: { input_tokens: (b.kind === "ok" && b.inputTokens) || 10, output_tokens: 1 } } }));
    res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(": ping\n\n");
    const pieces = ("pieces" in b && b.pieces) || (b.kind === "tool" ? [] : DEFAULT_PIECES);
    const delay = b.kind === "slow" ? b.delayMs : b.kind === "ok" ? b.delayMs ?? 0 : 0;
    for (let i = 0; i < pieces.length; i++) {
      if (delay) await sleep(delay);
      res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: pieces[i] } }));
      if (b.kind === "drop" && i === Math.floor(pieces.length / 2)) return void res.destroy();
    }
    if (b.kind === "tool") {
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      b.calls.forEach((c, n) => {
        const index = n + 1;
        const input = JSON.stringify(c.arguments ?? {});
        const half = Math.floor(input.length / 2);
        res.write(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_fake_${index}`, name: c.name, input: {} } }));
        res.write(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input.slice(0, half) } }));
        res.write(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input.slice(half) } }));
        res.write(sse("content_block_stop", { type: "content_block_stop", index }));
      });
      res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }));
      res.write(sse("message_stop", { type: "message_stop" }));
      return void res.end();
    }
    if (b.kind === "streamError") {
      res.write(sse("error", { type: "error", error: { type: b.type || "overloaded_error", message: b.message || "Overloaded" } }));
      return void res.end();
    }
    res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
    const out = (b.kind === "ok" && b.outputTokens) || pieces.length;
    res.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: b.kind === "refusal" ? "refusal" : "end_turn" }, usage: { output_tokens: out } }));
    res.write(sse("message_stop", { type: "message_stop" }));
    res.end();
  }

  async function ollama(res: ServerResponse, b: Behavior, body: any) {
    if (b.kind === "error") return json(res, b.status, b.body ?? { error: "fake error" }, b.headers);
    const model = body?.model || "llama3";
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
    if (loading) {
      line({ model, created_at: "x", message: { role: "assistant", content: "" }, done: false });
      loading = false;
    }
    const pieces = ("pieces" in b && b.pieces) || (b.kind === "tool" ? [] : DEFAULT_PIECES);
    const delay = b.kind === "slow" ? b.delayMs : b.kind === "ok" ? b.delayMs ?? 0 : 0;
    if (b.kind === "tool") {
      for (const p of pieces) line({ model, created_at: "x", message: { role: "assistant", content: p }, done: false });
      line({ model, created_at: "x", message: { role: "assistant", content: "", tool_calls: b.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) }, done: false });
      line({ model, created_at: "x", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 3 });
      return void res.end();
    }
    for (let i = 0; i < pieces.length; i++) {
      if (delay) await sleep(delay);
      line({ model, created_at: "x", message: { role: "assistant", content: pieces[i] }, done: false });
      if (b.kind === "drop" && i === Math.floor(pieces.length / 2)) return void res.destroy();
    }
    if (b.kind === "streamError") {
      line({ error: b.message || "model failed" });
      return void res.end();
    }
    line({ model, created_at: "x", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: (b.kind === "ok" && b.inputTokens) || 12, eval_count: (b.kind === "ok" && b.outputTokens) || pieces.length });
    res.end();
  }

  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    requests,
    set: (b) => void (standing = b),
    once: (b) => void queue.push(b),
    setModels: (ids) => void (models = ids),
    setLoading: (on) => void (loading = on),
    close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  };
}
