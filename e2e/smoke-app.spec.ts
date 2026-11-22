/**
 * Optional: smoke test of the built OneDesk.app (round 20). Skipped unless ONEDESK_SMOKE_APP is set, so `pnpm e2e` is unchanged.
 *   ONEDESK_SMOKE_APP=/path/to/OneDesk.app pnpm e2e:app      (or `pnpm smoke:app [app]` to run the script alone)
 * It only runs scripts/smoke-app.sh (temporary data dir, in-memory secret store: nothing of the user's is touched).
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { ROOT } from "./kernel-host";

const app = process.env.ONEDESK_SMOKE_APP;

test("the built .app passes scripts/smoke-app.sh", async () => {
  test.skip(!app, "set ONEDESK_SMOKE_APP to the path of OneDesk.app to run the .app smoke test");
  test.setTimeout(180_000);
  let out = "";
  let code = 0;
  try {
    out = (await promisify(execFile)("sh", [path.join(ROOT, "scripts/smoke-app.sh"), app!], { cwd: ROOT, timeout: 150_000 })).stdout;
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    out = err.stdout ?? String(e);
    code = err.code ?? 1;
  }
  const failed = out.split("\n").filter((l) => l.startsWith("FAIL:"));
  expect(failed, out).toEqual([]);
  expect(code, out).toBe(0);
  expect(out).toContain("ok:");
});
