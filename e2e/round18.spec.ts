/**
 * Round 18 (sqlpool-parity K1–K10, docs/redesign/ai-plugins.md) against the real kernel.
 * Nothing real is contacted: both AI providers talk to the local fake in fixtures/fake-ai.ts (SSE + NDJSON),
 * API keys live only in the in-memory secret store the devhost is started with.
 * Phase 1 = scaffold + fixme placeholders; phase 2 (after the integration branch merges) fills every case in.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, openKernel, ROOT, rpc, startHost, stopHost, type Host } from "./kernel-host";
import { FakeAi } from "./fixtures/fake-ai";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;
let ai: FakeAi;

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round18-")));
  ai = await new FakeAi().start();
  host = await startHost(path.join(base, "data"), { ONEDESK_TEST_HOOKS: "1" }, path.join(ROOT, "plugins"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  ai?.stop();
  if (base) rmSync(base, { recursive: true, force: true });
});
test.beforeEach(() => ai?.reset());

/* ------------------------------------------------------------------ helpers */

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type RunInfo = { id: string; status: string; error?: { code: string; message?: string; params?: Record<string, string> }; output?: any; partial?: unknown };
const waitRun = async (page: Page, id: string): Promise<RunInfo> => {
  for (let i = 0; i < 300; i++) {
    const r = await call<RunInfo>(page, "run.get", { id });
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("run did not end");
};
const create = async (page: Page, kind: string, changes: Record<string, unknown>) =>
  (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
const startRaw = (page: Page, action: string, target: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  call<string>(page, "run.start", { action, target, tabId: "e2e-tab", input: {}, params, locale: "en-US", ...extra });
void [openKernel, create, startRaw, waitRun, call]; // used by phase 2

const ANTHROPIC = "org.onedesk.ai.anthropic:connection"; // kind ids to confirm against the merged manifests
const OLLAMA = "org.onedesk.ai.ollama:connection";
void [ANTHROPIC, OLLAMA];

/* ------------------------------------------------------------------ scaffold check (runs now) */

test("scaffold: fake AI speaks SSE and NDJSON and records requests", async () => {
  ai.set({ chunks: ["a", "b"] });
  const sse = await (await fetch(`${ai.origin}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", stream: true }) })).text();
  expect(sse).toContain("content_block_delta");
  expect(sse).toContain("message_stop");
  const nd = (await (await fetch(`${ai.origin}/api/chat`, { method: "POST", body: JSON.stringify({ model: "m" }) })).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(nd.at(-1).done).toBe(true);
  expect(ai.chats()).toHaveLength(2);
  ai.set({ status: 529 });
  expect((await fetch(`${ai.origin}/v1/messages`, { method: "POST", body: "{}" })).status).toBe(529);
});

/* ------------------------------------------------------------------ K1–K10 placeholders */

test.describe("K1–K10 (phase 2)", () => {
  test.fixme("K1: table and text results get an Analyze result action; it is disabled with a reason when ai.policy is off; the AI plugin can read only the clicked run (denied/notInResultAction otherwise)", async () => {});
  test.fixme("K2: an authorised docs folder syncs into resources; the preview picks docs by table/column names via any-word relevance search (X6, kinds filter); total stays within budget", async () => {});
  test.fixme("K3: Analyze opens an editable preview (full Markdown, doc checkboxes, connection + model + token estimate); nothing reaches the fake server until Send; after Send the SSE answer streams into Run.partial then the final output", async () => {});
  test.fixme("K4: redaction — password/token/email/phone columns masked, emails and long digit strings masked, only the first 20 rows, cells cut at 200 chars; the body the fake server received contains none of the secrets", async () => {});
  test.fixme("K5: the API key is never in the resource body, audit, run, data dir or the plugin-visible request; the fake server saw it only in x-api-key; a host not written in the connection is refused; Ollama loopback works only when written explicitly", async () => {});
  test.fixme("K6: save an analysis (name, sent content, answer, connection, model, usage) under the run (run_artifacts); deleting the run deletes it", async () => {});
  test.fixme("K7: SQL plugin 'write with AI' sends instruction + docs + table/column names and no row data (assert on the fake server's body)", async () => {});
  test.fixme("K8: proposed SQL is checked — single SELECT/WITH passes; multiple statements, DML, comments hiding a second statement are rejected with check.reason", async () => {});
  test.fixme("K9: Accept puts the text in the editor as an unsaved change; Reject leaves the saved content untouched", async () => {});
  test.fixme("K10: settings — default connection (resource-reference param with implements kinds, per-environment override), redaction rules, docs folder; key save/remove; ai.policy off/preview/allow behaviour", async () => {});
});

/* ------------------------------------------------------------------ kernel X5/X6/X15/X16 (phase 2) */

test.describe("kernel facilities (phase 2)", () => {
  test.fixme("X16: streaming — chunks arrive as Run.partial while the fake server is still sending; cancelling the run drops the connection (fake server counts aborted === 1) and the run ends cancelled", async () => {});
  test.fixme("X16: idleTimeoutMs — a server that stalls after headers ends the run with invalid/timeout; a long (> 60 s) run is allowed only inside an action", async () => {});
  test.fixme("X16: error status (401/429/529) bodies reach the plugin and map to auth/rateLimit/overloaded; refusal stop_reason maps to stop:'refusal'", async () => {});
  test.fixme("X15: interfaces.call finds the implementation by resource kind; no uses → denied/notUsed; unknown resource → invalid/noImplementation; wrong kind → invalid/wrongInterface; interfaces.list returns both providers", async () => {});
  test.fixme("X5: result.actions lists Analyze only for table/text outputs and not at all for others", async () => {});
  test.fixme("X6: search mode:any + rank:relevance + kinds returns title hits first and respects the kinds filter", async () => {});
  test.fixme("shell: result-area buttons and live partial output (Markdown) render; screenshots round18-*.png", async () => {});
});
