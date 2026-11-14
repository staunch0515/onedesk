import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Local HTTP target for request tests (random port; CORS open because the preview page fetches cross-origin). */
export async function startHttpServer(): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.url?.startsWith("/teapot")) {
      res.writeHead(418, { "content-type": "text/plain" }).end("short and stout");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
