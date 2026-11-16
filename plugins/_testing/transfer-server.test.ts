/** Checks of the round-8 test server `e2e/fixtures/transfer-server.mjs` (local HTTP only, 127.0.0.1). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-ignore plain JS module, no types
import { patternByte, startServer } from "../../e2e/fixtures/transfer-server.mjs";

let srv: { port: number; url: string; received: any[]; close(): Promise<void> };
beforeAll(async () => {
  srv = await startServer({ port: 0 });
});
afterAll(async () => {
  await srv.close();
});

describe("transfer server", () => {
  it("listens on 127.0.0.1 only and refuses another host", async () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(() => startServer({ host: "0.0.0.0" })).toThrow("127.0.0.1");
  });
  it("GET /bytes/<n> sends exactly n pattern bytes with a content length, also beyond one block", async () => {
    for (const n of [0, 5, 70000]) {
      const res = await fetch(`${srv.url}/bytes/${n}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(n));
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBe(n);
      for (const i of [0, 1, n - 1, 65536, 65537]) if (i >= 0 && i < n) expect(body[i]).toBe(patternByte(i));
    }
  });
  it("GET /nolength/<n> sends the same bytes without a content length", async () => {
    const res = await fetch(`${srv.url}/nolength/100000`);
    expect(res.headers.get("content-length")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(100000);
  });
  it("GET /status/<code> answers with that status; bad input is a 400", async () => {
    expect((await fetch(`${srv.url}/status/404`)).status).toBe(404);
    expect((await fetch(`${srv.url}/status/503`)).status).toBe(503);
    expect((await fetch(`${srv.url}/status/abc`)).status).toBe(400);
    expect((await fetch(`${srv.url}/bytes/-1`)).status).toBe(400);
    expect((await fetch(`${srv.url}/nowhere`)).status).toBe(404);
  });
  it("PUT /sink/<name> counts the received bytes and remembers them; reset forgets", async () => {
    await fetch(`${srv.url}/reset`, { method: "POST" });
    const body = Buffer.alloc(200000, 7);
    const res = await fetch(`${srv.url}/sink/a.bin`, { method: "PUT", body, headers: { "x-test": "1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "a.bin", bytes: 200000 });
    const list = await (await fetch(`${srv.url}/received`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "a.bin", method: "PUT", bytes: 200000 });
    expect(list[0].headers["x-test"]).toBe("1");
    expect(srv.received).toHaveLength(1);
    await fetch(`${srv.url}/reset`, { method: "POST" });
    expect(await (await fetch(`${srv.url}/received`)).json()).toEqual([]);
  });
  it("GET /slow keeps sending until the client goes away", async () => {
    const ctl = new AbortController();
    const res = await fetch(`${srv.url}/slow/20`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    let got = 0;
    while (got < 3 * 1024) got += (await reader.read()).value!.length;
    expect(got).toBeGreaterThanOrEqual(3 * 1024);
    ctl.abort();
    await reader.read().catch(() => undefined);
  });
});
