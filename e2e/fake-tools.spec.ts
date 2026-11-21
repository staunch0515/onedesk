/** Round 17: proves the fake ssh/docker fixture is what the kernel really runs (and that no real server is contacted). */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { FakeTools } from "./fake-tools";
import { DEVHOST, openKernel, ROOT, rpc, startHost, stopHost, type Host } from "./kernel-host";
import { pgBinOrNull } from "./pg-fixture";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.setTimeout(60_000);

let host: Host;
let base: string;
let fake: FakeTools;

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST)).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-fake-")));
  fake = new FakeTools(path.join(base, "fake"), pgBinOrNull);
  host = await startHost(path.join(base, "data"), {}, fake.preparePlugins(path.join(ROOT, "plugins"), path.join(base, "plugins"), path.join(base, "data")));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);

test("the ssh the data source plugin runs is the fake: its arguments are recorded and its stderr is shown", async ({ page }) => {
  fake.rule("ssh", { steps: [{ err: "fake-ssh: Permission denied (publickey)." }], code: 255 });
  await openKernel(page, host);
  await call(page, "page.save", {
    target: "new:org.onedesk.datasource:source",
    changes: { name: "Staging", "body.mode": "ssh", "body.sshHost": "e2e-fake-host", "body.container": "postgres", "body.database": "shop", "body.user": "postgres" },
  });
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Resources", exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
  await page.getByRole("treeitem", { name: "Staging", exact: true }).dblclick();
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText(/fake-ssh: Permission denied/).first()).toBeVisible({ timeout: 30_000 });
  const calls = fake.calls("ssh");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0]!.args.join(" ")).toContain("e2e-fake-host");
  expect(calls[0]!.args.join(" ")).toContain("docker");
});
