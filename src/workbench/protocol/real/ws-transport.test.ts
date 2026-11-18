// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWsTransport } from "./ws-transport";

class FakeSocket {
  static last: FakeSocket;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send() {}
  close() {}
}

afterEach(() => vi.unstubAllGlobals());

describe("browser transport (D403)", () => {
  it("asks for a workspace in its address when the tab was opened for one", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    await createWsTransport("ws://127.0.0.1:1/", "tok", "web-1", "ws id/1");
    expect(FakeSocket.last.url).toContain("&workspace=ws%20id%2F1");
    await createWsTransport("ws://127.0.0.1:1/", "tok", "web-1");
    expect(FakeSocket.last.url).not.toContain("workspace=");
  });

  it("'new window' opens another tab of this page with ?workspace=<id>, without an opener", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const transport = await createWsTransport("ws://127.0.0.1:1/", "tok", "web-1");
    await transport.openWindow!("abc");
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("workspace")).toBe("abc");
    expect([target, features]).toEqual(["_blank", "noopener"]);
  });
});
