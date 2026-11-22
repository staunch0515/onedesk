/**
 * Minimal fake AI providers for round 18 e2e (never the real Anthropic/Ollama).
 * Stand-in until r18-providers' fixture (plugins/_testing/fake-ai/) lands; swap the import then.
 *  - Anthropic-style SSE: POST /v1/messages (stream), GET /v1/models
 *  - Ollama-style NDJSON: POST /api/chat, GET /api/tags, GET /api/version
 * Every request is recorded (method, url, headers, parsed body) so tests can assert what was sent.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: any };
export type FakeAiOpts = {
  /** chunks of the answer text; each becomes one delta/line */
  chunks?: string[];
  /** delay between chunks (ms) */
  delayMs?: number;
  /** answer with this HTTP status and error body instead of streaming */
  status?: number;
  /** 'refusal' makes the SSE stop_reason refusal */
  stop?: "end_turn" | "refusal" | "max_tokens";
  /** never send anything after the headers (idle-timeout tests) */
  hang?: boolean;
};

export class FakeAi {
  server!: http.Server;
  port = 0;
  seen: Seen[] = [];
  opts: FakeAiOpts = {};
  /** how many connections were closed by the client before the end of the stream */
  aborted = 0;
  models = ["claude-haiku-5-5", "claude-sonnet-5-5"];
  ollamaModels = ["llama3.2:latest"];

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
        this.seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        void this.handle(req, res, body);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  stop() { this.server?.closeAllConnections?.(); this.server?.close(); }
  get origin() { return `http://127.0.0.1:${this.port}`; }
  reset() { this.seen = []; this.opts = {}; this.aborted = 0; }
  set(o: FakeAiOpts) { this.opts = o; }
  chats() { return this.seen.filter((s) => s.method === "POST" && /\/v1\/messages|\/api\/chat/.test(s.url)); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, body: any) {
    const o = this.opts;
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/v1/models")) return json(res, 200, { data: this.models.map((id) => ({ id, type: "model" })) });
    if (req.method === "GET" && url.startsWith("/api/tags")) return json(res, 200, { models: this.ollamaModels.map((name) => ({ name })) });
    if (req.method === "GET" && url.startsWith("/api/version")) return json(res, 200, { version: "0.0.0-fake" });
    if (o.status && o.status >= 400) return json(res, o.status, url.startsWith("/v1/") ? { type: "error", error: { type: "api_error", message: "fake failure" } } : { error: "fake failure" });
    const chunks = o.chunks ?? ["Hello", " from", " the fake."];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    res.on("close", () => { if (!res.writableEnded) this.aborted++; });
    if (url.startsWith("/v1/messages")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (o.hang) return;
      const ev = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev("message_start", { type: "message_start", message: { id: "msg_fake", model: body?.model ?? "fake", usage: { input_tokens: 12, output_tokens: 0 } } });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (const c of chunks) { await wait(o.delayMs ?? 0); if (res.destroyed) return; ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } }); }
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: o.stop ?? "end_turn" }, usage: { output_tokens: chunks.length } });
      ev("message_stop", { type: "message_stop" });
      return void res.end();
    }
    if (url.startsWith("/api/chat")) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      if (o.hang) return;
      for (const c of chunks) { await wait(o.delayMs ?? 0); if (res.destroyed) return; res.write(JSON.stringify({ model: body?.model, message: { role: "assistant", content: c }, done: false }) + "\n"); }
      res.write(JSON.stringify({ model: body?.model, message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 12, eval_count: chunks.length }) + "\n");
      return void res.end();
    }
    json(res, 404, { error: "not found" });
  }
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
