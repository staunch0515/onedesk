// Test fixture: a throwaway HTTP server for the transfer e2e checks. Listens on 127.0.0.1 only.
//   node e2e/fixtures/transfer-server.mjs <port>      (port 0 = pick a free one; the chosen port is printed)
// Routes:
//   GET  /bytes/<n>        n bytes of a repeating pattern (byte i = i % 251), with Content-Length
//   GET  /nolength/<n>     the same, chunked (no Content-Length)
//   GET  /slow             sends 1 KiB every 100 ms for up to 10 minutes (to cancel a download); /slow/<ms> sets the pause
//   GET  /status/<code>    answers with that status and a small text body (non-2xx downloads write no file)
//   PUT|POST /sink[/name]  reads the whole body, remembers the byte count, answers 200 {"name","bytes"} (text)
//   GET  /received         JSON list of what the sink got: [{ name, method, bytes, headers }]
//   POST /reset            forgets the sink records
//   ANY  /echo[/…]         answers 200 compact JSON {method, path, query, headers, body}: the query as an object (repeated names -> array),
//                          all request headers (lower-case names), the body as text. Header `x-echo: yes`. HEAD gets the same headers, no body.
// Used as a module too: `startServer({ port?, host? })` resolves to { port, url, received, close }.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";
export const patternByte = (i) => i % 251;

const chunk = (start, len) => {
  const b = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) b[i] = patternByte(start + i);
  return b;
};

const BLOCK = 64 * 1024;

export function startServer({ port = 0, host = HOST } = {}) {
  if (host !== HOST) throw new Error("the transfer test server only listens on 127.0.0.1");
  const received = [];
  const sockets = new Set();
  const timers = new Set();
  const send = (res, status, text, type = "text/plain") => {
    res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const [head, arg] = parts;

    if (req.method === "GET" && (head === "bytes" || head === "nolength")) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0) return send(res, 400, "bad size");
      const headers = { "content-type": "application/octet-stream" };
      if (head === "bytes") headers["content-length"] = n;
      res.writeHead(200, headers);
      let sent = 0;
      const pump = () => {
        while (sent < n) {
          const len = Math.min(BLOCK, n - sent);
          const ok = res.write(chunk(sent, len));
          sent += len;
          if (!ok) return void res.once("drain", pump);
        }
        res.end();
      };
      return pump();
    }

    if (req.method === "GET" && head === "slow") {
      const pause = arg === undefined ? 100 : Number(arg);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let ticks = 0;
      const timer = setInterval(() => {
        if (++ticks > (10 * 60 * 1000) / Math.max(pause, 1)) {
          clearInterval(timer);
          timers.delete(timer);
          return res.end();
        }
        res.write(chunk(0, 1024));
      }, pause);
      timers.add(timer);
      res.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
      return;
    }

    if (req.method === "GET" && head === "status") {
      const code = Number(arg);
      if (!Number.isInteger(code) || code < 200 || code > 599) return send(res, 400, "bad status");
      return send(res, code, `status ${code}`);
    }

    if ((req.method === "PUT" || req.method === "POST") && head === "sink") {
      let bytes = 0;
      req.on("data", (d) => (bytes += d.length));
      req.on("end", () => {
        const name = parts.slice(1).join("/");
        const headers = {};
        for (const k of ["content-type", "content-length", "authorization", "x-test"]) if (req.headers[k] !== undefined) headers[k] = req.headers[k];
        received.push({ name, method: req.method, bytes, headers });
        send(res, 200, JSON.stringify({ name, bytes }), "application/json");
      });
      req.on("error", () => res.destroy());
      return;
    }

    if (head === "echo") {
      const chunks = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        const query = {};
        for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
        const text = JSON.stringify({ method: req.method, path: url.pathname, query, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "x-echo": "yes" });
        res.end(req.method === "HEAD" ? undefined : text);
      });
      req.on("error", () => res.destroy());
      return;
    }

    if (req.method === "GET" && head === "received") return send(res, 200, JSON.stringify(received), "application/json");
    if (req.method === "POST" && head === "reset") {
      received.length = 0;
      return send(res, 200, "ok");
    }
    send(res, 404, "not found");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://${HOST}:${actual}`,
        received,
        close: () =>
          new Promise((done) => {
            for (const t of timers) clearInterval(t);
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv[2];
  const port = arg === undefined ? 0 : Number(arg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write("usage: node transfer-server.mjs <port>\n");
    process.exit(2);
  }
  const s = await startServer({ port });
  process.stdout.write(`listening ${s.url}\n`);
  const stop = () => s.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
