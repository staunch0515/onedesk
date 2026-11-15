/**
 * Entry of the workbench prototype (stage 0). Open /workbench.html.
 * URL options, used by the screenshot script: ?reset (fresh demo data and layout), ?quiet (no
 * background run at start), ?theme=light|dark, ?density=compact, ?lang=zh-CN.
 *
 * This file is the only place that names the mock. To run against the real kernel, build a
 * ProtocolClient that talks to the worker process and pass it to <App> instead.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../design";
import { App, readSettings } from "./app";
import type { ProtocolClient } from "./protocol";
import { createMockClient } from "./protocol/mock";
import { createStore, type LayoutState } from "./state/store";

async function start() {
  const query = new URLSearchParams(window.location.search);
  const reset = query.has("reset");
  const client: ProtocolClient = createMockClient({ fresh: reset, quiet: query.has("quiet") });

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

  const settings = await readSettings(client);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App client={client} store={store} settings={settings} />
    </StrictMode>,
  );
}

void start();
