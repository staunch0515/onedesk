#!/usr/bin/env node
// A tiny MCP server (stdin/stdout JSON-RPC lines) used only to test e2e/_mcp/mcp-client.ts itself.
import readline from "node:readline";
const tools = [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  if (m.method === "tools/list") return send({ id: m.id, result: { tools } });
  if (m.method === "tools/call") {
    if (m.params.name === "echo") return send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ said: m.params.arguments.text }) }] } });
    if (m.params.name === "fail") return send({ id: m.id, result: { isError: true, content: [{ type: "text", text: "nope" }] } });
    return send({ id: m.id, error: { code: -32602, message: "unknown tool" } });
  }
  send({ id: m.id, error: { code: -32601, message: "method not found" } });
});
