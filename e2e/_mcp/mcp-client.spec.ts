/** Self-test of the fake MCP client against e2e/_mcp/fake-server.mjs (no kernel, no network). */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { connectMcp, McpRpcError } from "./mcp-client";

const server = path.join(import.meta.dirname, "fake-server.mjs");

test("handshake, tools/list, tools/call, tool error, protocol error, clean close", async () => {
  const c = await connectMcp({ command: process.execPath, args: [server] });
  expect(c.serverInfo.name).toBe("fake");
  expect((await c.listTools()).map((t) => t.name)).toEqual(["echo"]);
  const ok = await c.callTool("echo", { text: "hi" });
  expect(ok.isError).toBe(false);
  expect(ok.json).toEqual({ said: "hi" });
  const bad = await c.callTool("fail");
  expect(bad.isError).toBe(true);
  expect(bad.text).toBe("nope");
  await expect(c.callTool("nope")).rejects.toBeInstanceOf(McpRpcError);
  expect(c.strayStdout).toEqual([]);
  expect(await c.close()).toBe(0);
});
