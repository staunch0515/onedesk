// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "../../design";
import { I18nProvider } from "../i18n";
import { AiSettingsPage, claudeDesktopSnippet } from "../pages/ai-settings-page";
import { AuditPage } from "../pages/audit-page";
import { ProtocolProvider } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { WorkbenchProvider } from "../state/context";
import { createStore } from "../state/store";
import { InfoPanelPart } from "./info-panel";

function wrap(client: ReturnType<typeof createMockClient>, ui: React.ReactNode) {
  const store = createStore(null, () => undefined);
  return render(
    <ProtocolProvider client={client}>
      <I18nProvider locale="en-US">
        <ToastProvider closeLabel="Close" viewportLabel="Notifications" duration={1000}>
          <WorkbenchProvider store={store}>{ui}</WorkbenchProvider>
        </ToastProvider>
      </I18nProvider>
    </ProtocolProvider>,
  );
}

describe("round 19 shell", () => {
  it("shows the AI switch off by default and turns it on", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    wrap(client, <InfoPanelPart resourceId="q-orders-today" />);
    const sw = await screen.findByRole("switch", { name: /Visible to AI/ });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(async () => expect((await client.resource.get("q-orders-today"))?.aiVisible).toBe(true));
  });

  it("a group's switch covers what is below it", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    const group = (await client.tree.createGroup("resources", null, "G"));
    wrap(client, <InfoPanelPart resourceId={group.key} />);
    const sw = await screen.findByRole("switch", { name: /including everything below/ });
    fireEvent.click(sw);
    await waitFor(async () => expect((await client.resource.get(group.key))?.aiVisible).toBe(true));
  });

  it("the policy defaults to off and a change is written to the workspace configuration", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    wrap(client, <AiSettingsPage tab={{ id: "t", target: "shell:ai" } as never} />);
    const sw = await screen.findByRole("switch", { name: /Allow AI clients/ });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(async () => expect((await client.mcp.status()).enabled).toBe(true));
  });

  it("builds the Claude Desktop snippet around the program path", () => {
    expect(JSON.parse(claudeDesktopSnippet("/x/onedesk-mcp"))).toEqual({ mcpServers: { onedesk: { command: "/x/onedesk-mcp", args: [] } } });
  });

  it("the audit page can show only AI calls with their tool, arguments, rows and time", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    wrap(client, <AuditPage tab={{ id: "t", target: "core:audit" } as never} descriptor={{ title: "Audit", target: "core:audit", icon: "scroll-text", breadcrumb: [], actions: [], resultTabs: [], values: {} } as never} />);
    const select = await screen.findByRole("combobox", { name: "Source" });
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "AI only" }));
    expect((await screen.findAllByText("org_onedesk_sql__run_sql")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Edit resource")).toBeNull();
    expect(screen.getAllByText(/failed: aiFreeQuery/).length).toBeGreaterThan(0);
  });
});
