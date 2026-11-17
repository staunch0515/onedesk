/**
 * Entry of the workbench prototype (stage 0). Open /workbench.html.
 * URL options, used by the screenshot script: ?reset (fresh demo data and layout), ?quiet (no
 * background run at start), ?theme=light|dark, ?density=compact, ?lang=zh-CN.
 *
 * This file is the only place that names the mock and the connection (week1-protocol §2):
 *   - inside the Tauri window: the kernel through the main process (mixed with demo data, D265);
 *   - `?kernel=ws://127.0.0.1:<port>&token=<token>`: the same, through `onedesk-devhost`;
 *   - neither: pure demo data (the look reference; `e2e/workbench.spec.ts` runs this).
 * If a connection was asked for and fails, the interface falls back to demo data and says so.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../design";
import { App, readSettings } from "./app";
import type { ProtocolClient } from "./protocol";
import { createMixedClient } from "./protocol/mixed-client";
import { createMockClient } from "./protocol/mock";
import { connectKernel } from "./protocol/real";
import { openStartupPage } from "./state/startup";
import { createStore, type LayoutState } from "./state/store";

async function start() {
  const query = new URLSearchParams(window.location.search);
  const reset = query.has("reset");
  let client: ProtocolClient;
  let startupError: string | undefined;
  try {
    const kernel = await connectKernel(query, () => query.get("lang") ?? document.documentElement.lang ?? "en-US");
    client = kernel ? createMixedClient(kernel, createMockClient({ fresh: reset, quiet: true })) : createMockClient({ fresh: reset, quiet: query.has("quiet") });
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    client = createMockClient({ fresh: reset, quiet: query.has("quiet") });
  }

  if (query.get("theme")) await client.workspace.setConfig("ui.theme", query.get("theme")!);
  if (query.get("density")) await client.workspace.setConfig("ui.density", query.get("density")!);
  if (query.get("lang")) await client.workspace.setConfig("ui.language", query.get("lang")!);

  const saved = reset ? null : await client.ui.get<Partial<LayoutState>>("layout");
  const store = createStore(saved, (layout) => void client.ui.set("layout", layout));

  if (!saved) {
    // First connection of this client: a default environment and the welcome set of tabs.
    const [envs, targets] = await Promise.all([client.params.envOptions(), client.workspace.startTargets()]);
    const tabs = targets.map((target, i) => ({ id: `t-start-${i}`, target, title: "", icon: "loader", pinned: false, envId: envs[0]?.id ?? null, params: {} }));
    store.set({ lastEnvId: envs[0]?.id ?? null, tabs, activeTabId: tabs[0]?.id ?? null });
    const first = targets.find((x) => x.startsWith("resource:"));
    if (first) {
      const res = await client.resource.get(first.slice(9));
      if (res) {
        const path = await client.tree.path(res.tree, res.id);
        store.set((s) => ({ expanded: { ...s.expanded, [res.tree]: path.slice(0, -1) } }));
      }
    }
  }

  // No tab came back (nothing saved, or all closed before the last quit): the startup page, once (D382).
  await openStartupPage(client, store);

  const settings = await readSettings(client);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App client={client} store={store} settings={settings} startupError={startupError} />
    </StrictMode>,
  );
}

void start();
